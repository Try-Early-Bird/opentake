import {defaultCoinbaseAccountConfig,type CoinbaseAccountSourceConfig} from '../../shared/coinbase-field-mappings';
import {isCryptoDust,defaultCryptoDustPolicy,type CryptoDustPolicy} from '../../shared/crypto-dust';
import {valueCoinbaseHoldings,type LiveCoinbasePrice} from './live-valuation';
import {coinbasePortfolioStrategies,type CoinbasePortfolioAllocation} from './portfolio-strategies';
import { FILL_WATCH_MS } from '../account-sync/cadence';
import {createCoinbaseMarkets} from './markets';
import {createCoinbaseHoldingSeries} from './holding-series';
import { createCoinbaseCapital } from './capital';
import { createCoinbasePriceCache } from './price-cache';
import { walletBalance, sameDisplayQuantity } from './history-amounts';
import { decimalToScaledInteger, scaledIntegerToDecimal } from '../allocations/decimal';
import { reconcileCoinbaseHistory } from './reconciliation';
import { createCoinbaseActivitySync } from './activity-sync';
import { reconstructCoinbaseDay, type CoinbaseValuation } from './history-valuation';
import type { CoinbaseHistory } from './history';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import type { createCoinbaseConnections } from './connections';
import type { PortfolioAccount, PortfolioView, CoinbaseSpotPosition } from '../../shared/portfolio';
import { CoinbaseError, coinbaseError } from './errors';
function plainDecimal(value: string | number): string {
  const text = String(value);
  if (typeof value !== 'number' || !text.includes('e')) return text;
  const [mantissa, exponent] = text.split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
}
const decimal = z.union([z.string(), z.number().finite().nonnegative()]).transform(plainDecimal).refine(value => /^(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length <= 80, 'Invalid decimal');
const balance = z.object({ value: decimal, currency: z.string().regex(/^[A-Z]{3}$/) });
const response = z.object({
  portfolio_balances: z.object({ total_balance: balance, total_cash_equivalent_balance: balance.optional() }),
  spot_positions: z.array(z.object({ asset: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,39}$/), total_balance_crypto: decimal, total_balance_fiat: decimal, available_to_trade_fiat: decimal.optional(), is_cash: z.boolean() })).max(10000),
  futures_positions: z.array(z.unknown()).optional(), equity_positions: z.array(z.unknown()).optional(),
});
interface Observation { portfolio: NonNullable<PortfolioView['portfolio']>; spotPositions: CoinbaseSpotPosition[]; warnings: string[] }
export function normalizeCoinbasePortfolio(input: unknown): Observation {
  const parsed = response.safeParse(input);
  if (!parsed.success) throw new CoinbaseError('provider');
  const value = parsed.data, total = value.portfolio_balances.total_balance, cash = value.portfolio_balances.total_cash_equivalent_balance;
  if (cash && cash.currency !== total.currency) throw new CoinbaseError('provider');
  const assets = value.spot_positions.map(position => position.asset);
  if (new Set(assets).size !== assets.length) throw new CoinbaseError('provider');
  return {
    portfolio: { totalValue: total.value, currency: total.currency, cash: cash?.value ?? null, buyingPower: null },
    spotPositions: value.spot_positions.map(position => ({ instrumentRef: `coinbase:${position.asset}`, asset: position.asset, quantity: position.total_balance_crypto, marketValue: position.total_balance_fiat, availableValue: position.available_to_trade_fiat ?? null, currency: total.currency, isCash: position.is_cash })),
    warnings: value.futures_positions?.length || value.equity_positions?.length ? ['The total includes non-spot assets. Only spot holdings are listed here.'] : [],
  };
}
/** Cost fields only apply to the same holding quantity and currency, never to a different snapshot. */
export function applyCoinbasePositionDetails(positions:CoinbaseSpotPosition[],input:unknown){
 const parsed=z.array(z.object({asset:z.string(),total_balance_crypto:decimal,total_balance_fiat:decimal,cost_basis:balance.nullish().catch(null),average_entry_price:balance.nullish().catch(null)})).safeParse(input);
 if(!parsed.success)return;const details=parsed.data;
 for(const position of positions){
  const matches=details.filter(row=>row.asset===position.asset);if(matches.length!==1)continue;
  const row=matches[0];
  if(decimalToScaledInteger(row.total_balance_crypto,36)!==decimalToScaledInteger(position.quantity,36))continue;
  position.averageEntryPrice=row.average_entry_price?.currency===position.currency&&Number(row.average_entry_price.value)>0?row.average_entry_price.value:null;
  if(row.cost_basis?.currency===position.currency&&Number(row.cost_basis.value)>0){
   const pnl=decimalToScaledInteger(position.marketValue,36)-decimalToScaledInteger(row.cost_basis.value,36);
   position.unrealizedPnl=(pnl<0n?'-':'')+scaledIntegerToDecimal(pnl<0n?-pnl:pnl,36);
  }else position.unrealizedPnl=null;
 }
}
type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
type Connections = Pick<ReturnType<typeof createCoinbaseConnections>, 'list' | 'chatScope' | 'assertChatScope' | 'readChat'> & Partial<Pick<ReturnType<typeof createCoinbaseConnections>, 'readHistory' | 'readActivity' | 'readProductMetadata' | 'readPositionDetails'>>;
export function createCoinbasePortfolio(database: Database, connections: Connections, now = () => Date.now(), unavailable = () => false, livePrice: LiveCoinbasePrice = () => null, dustPolicy:()=>CryptoDustPolicy = ()=>defaultCryptoDustPolicy, sourceOptions:{backgroundAllowed?(accountId:string):Promise<boolean>;config?(accountId:string):Promise<CoinbaseAccountSourceConfig>;
  /** A sync finished and saved the account's latest data (drift checks can use it now). */
  synced?(accountId:string):void}={}) {
  // Market data is account-independent, but every cache miss uses a connected MCP session.
  let marketRead=Promise.resolve();
  const marketRequests=new Map<string,Promise<unknown>>();
  function readMarket(accountId:string|undefined,name:string,args:Record<string,unknown>):Promise<unknown>{
    if(stopped||suspended)return Promise.reject(new CoinbaseError('cancelled'));
    const epoch=generation;
    const key=JSON.stringify([epoch,accountId??null,name,Object.entries(args).sort(([a],[b])=>a.localeCompare(b))]);
    const existing=marketRequests.get(key);if(existing)return existing;
    // Bound pending distinct reads; duplicates share the same operation even at capacity.
    if(marketRequests.size>=32)return Promise.reject(new CoinbaseError('busy'));
    const check=()=>{if(stopped||suspended||epoch!==generation)throw new CoinbaseError('cancelled');};
    const result=marketRead.then(async()=>{
      check();
      const selected=accountId??(await connections.list()).find(account=>account.capabilities.accountRead)?.accountId;
      check();if(!selected)throw new CoinbaseError('unavailable');
      const scope=await connections.chatScope(selected);check();
      let data=(await connections.readChat(scope,name,args)).data;check();
      if(name==='coinbase_products_get'&&connections.readProductMetadata){
        // CLI 0.0.10 drops these fields. Core prices and rules still come from MCP.
        try{data={...data,...await connections.readProductMetadata(selected,String(args.product_id))};}
        catch(error){if(!(error instanceof CoinbaseError)||error.code!=='provider')throw error;}
      }
      check();await connections.assertChatScope(scope);check();
      return data;
    }).finally(()=>{marketRequests.delete(key);});
    marketRequests.set(key,result);
    marketRead=result.then(()=>{},()=>{});return result;
  }
  const prices=createCoinbasePriceCache(database,fetch,now,(product,start,end,interval)=>readMarket(undefined,'coinbase_products_candles',{product_id:product,start,end,granularity:interval===3600?'1h':'1d',limit:350}));
  const activity = connections.readActivity ? createCoinbaseActivitySync(database,async(scope,request)=>{if(stopped||suspended)throw new CoinbaseError('cancelled');return connections.readActivity!(scope,request);},async scope=>{if(stopped||suspended)throw new CoinbaseError('cancelled');await connections.assertChatScope(scope);if(stopped||suspended)throw new CoinbaseError('cancelled');},now) : undefined;
  const active = new Map<string, Promise<void>>();
  const activePurpose=new Map<string,'required'|'background'>();
  let working: Promise<void> | undefined;
  let stopped = false, suspended = false;
  let generation=0;
  async function schedule(accountId:string,failed:boolean){
    await database.use(db=>db.query(`UPDATE coinbase_portfolio_sync SET failure_count=CASE WHEN $2 THEN least(failure_count+1,5) ELSE 0 END,
      next_attempt_at=$3::timestamptz + (CASE WHEN $2 THEN least(60*power(2,least(failure_count,4)),900) ELSE 900 END)*interval '1 second' WHERE account_id=$1`,[accountId,failed,new Date(now()).toISOString()]));
  }
  async function accounts(): Promise<PortfolioAccount[]> {
    const connectionsList = await connections.list();
    // Seek each listed account's newest row instead of scanning retained history.
    const balances = connectionsList.length ? (await database.use(db => db.query<{ account_id: string; observed_at: Date; data: Observation }>(`SELECT a.account_id,o.observed_at,o.data
      FROM unnest($1::uuid[]) AS a(account_id) CROSS JOIN LATERAL (
        SELECT observed_at,data FROM coinbase_portfolio_observations WHERE account_id=a.account_id
        ORDER BY observed_at DESC,id DESC LIMIT 1
      ) o`, [connectionsList.map(connection => connection.accountId)]))).rows : [];
    return connectionsList.map(connection => {
      const saved = balances.find(row => row.account_id === connection.accountId);
      return { id: connection.accountId, venue: 'coinbase', label: connection.label, selected: false, available: connection.status === 'connected', balance: saved ? { totalValue: (connection.status === 'connected' ? valueCoinbaseHoldings(saved.data,saved.observed_at.getTime(),now(),livePrice) : saved.data).portfolio.totalValue, currency: saved.data.portfolio.currency, observedAt: saved.observed_at.toISOString() } : null };
    });
  }
  const service = {
    accounts,
    async heldProducts(): Promise<string[]> { return (await service.heldMarkets()).map(item=>item.product); },
    async heldMarkets(): Promise<Array<{product:string;account:string}>> {
      const rows=(await database.use(db=>db.query<{data:Observation;label:string}>(`SELECT DISTINCT ON (o.account_id) o.data,coalesce(d.label,a.nickname,'Coinbase account') AS label
        FROM coinbase_portfolio_observations o JOIN linked_accounts a ON a.id=o.account_id
        JOIN platform_connections c ON c.id=a.connection_id
        LEFT JOIN coinbase_connection_details d ON d.connection_id=c.id
        WHERE c.venue='coinbase' AND c.status='connected'
        ORDER BY o.account_id,o.observed_at DESC,o.id DESC`))).rows;
      const dust=dustPolicy();
      return rows.flatMap(({data,label})=>data.spotPositions.filter(p=>!p.isCash&&p.asset!=='USDC'&&p.asset!=='USD'&&p.currency==='USD'&&Number(p.quantity)>0&&(!dust.hide||!isCryptoDust(p.marketValue,p.currency,dust.threshold))).map(p=>({product:p.asset+'-USD',account:label})));
    },
    busy: () => active.size > 0 || !!working || marketRequests.size>0,
    tick(): Promise<void> {
      if (working) return working;
      if (stopped || suspended || unavailable()) return Promise.resolve();
      working = (async () => {
        const list = await accounts();
        for (const account of list) {
          if (stopped || suspended || unavailable()) break;
          if (!account.available) continue;
          if(sourceOptions.backgroundAllowed&&!await sourceOptions.backgroundAllowed(account.id))continue;
          const sync = (await database.use(db => db.query<{ attempted_at: Date; error_code: string | null; next_attempt_at:Date|null;failure_count:number }>(
            'SELECT attempted_at,error_code,next_attempt_at,failure_count FROM coinbase_portfolio_sync WHERE account_id=$1', [account.id]))).rows[0];
          // Persist cadence across restarts; transient contention retries sooner.
          const pending=(await database.use(db=>db.query(`SELECT 1 FROM coinbase_activity_sync WHERE account_id=$1 AND state IN ('partial','failed','interrupted')
            UNION ALL SELECT 1 FROM coinbase_transaction_history WHERE account_id=$1 AND (state='failed' OR (state='partial' AND error_code='page_limit'))
            UNION ALL SELECT 1 FROM coinbase_allocation_orders WHERE account_id=$1 AND state IN ('submitting','unknown','bound','reconciliation_required') LIMIT 1`,[account.id]))).rows.length>0;
          const recentOrder = pending && (await database.use(db => db.query(`SELECT 1
            FROM coinbase_allocation_orders o LEFT JOIN coinbase_order_dispatches d ON d.order_id=o.id
            WHERE o.account_id=$1 AND o.state IN ('submitting','unknown','bound','reconciliation_required')
              AND coalesce(d.started_at,o.created_at)>to_timestamp($2::double precision/1000.0)-interval '2 minutes'
            LIMIT 1`, [account.id,now()]))).rows.length>0;
          const interval = recentOrder ? FILL_WATCH_MS : pending || sync?.error_code === 'busy' ? 60_000 : 15 * 60_000;
          const due=sync?.next_attempt_at?.getTime()??(sync?sync.attempted_at.getTime()+interval:0);
          if(sync&&now()<Math.min(due,pending&&!sync.failure_count?sync.attempted_at.getTime()+interval:Infinity))continue;
          try { await service.refresh(account.id,'background'); } catch { /* The account retains a safe error and its last good data. */ }
        }
      })().finally(() => { working = undefined; });
      return working;
    },
    suspend(){suspended=true;generation++;},
    async wake(){
      if(stopped)return;
      const epoch=generation;await working;await Promise.allSettled([...active.values()]);await marketRead;
      if(stopped||epoch!==generation)return;suspended=false;
      // Wake healthy/interrupted reads promptly; retain backoff for provider failures.
      await database.use(db=>db.query("UPDATE coinbase_portfolio_sync SET next_attempt_at=$1 WHERE failure_count=0 OR error_code IN ('cancelled','interrupted')",[new Date(now()).toISOString()]));
      await service.tick();
    },
    async start() { await database.use(db => db.query("UPDATE coinbase_activity_sync SET state='interrupted',error_code='interrupted' WHERE state='running'")); await database.use(db => db.query("UPDATE coinbase_portfolio_sync SET state='interrupted',error_code='interrupted',next_attempt_at=$1 WHERE state='running'",[new Date(now()).toISOString()])); },
    async close() { stopped = true; generation++; await working; await Promise.allSettled(active.values()); await marketRead; },
    refresh(accountId: string, purpose:'required'|'background'='required'):Promise<void> {
      z.uuid().parse(accountId);
      if (stopped || suspended) return Promise.reject(new CoinbaseError('cancelled'));
      const existing = active.get(accountId); if (existing) return purpose==='required'&&activePurpose.get(accountId)==='background'?existing.then(()=>service.refresh(accountId,'required')):existing;
      const epoch=generation;
      const check=()=>{if(stopped||suspended||epoch!==generation)throw new CoinbaseError('cancelled');};
      const work = (async () => {
        const sourceConfig=purpose==='background'?(await sourceOptions.config?.(accountId)??defaultCoinbaseAccountConfig):defaultCoinbaseAccountConfig;
        if(purpose==='background'&&!Object.values(sourceConfig.reads).some(Boolean))return;
        await database.use(db => db.query("INSERT INTO coinbase_portfolio_sync(account_id,state,attempted_at) VALUES($1,'running',$2) ON CONFLICT(account_id) DO UPDATE SET state='running',attempted_at=excluded.attempted_at,error_code=NULL", [accountId, new Date(now()).toISOString()]));
        try {
          check();const scope = await connections.chatScope(accountId);
          check();
          const observedAt = now();
          let normalized:Observation|undefined;
          if(sourceConfig.reads.portfolio){
          const result = await connections.readChat(scope, 'coinbase_portfolios_get', {});
          check();normalized = normalizeCoinbasePortfolio(result.data);
          if(connections.readPositionDetails&&sourceConfig.reads.positionDetails) {
            try {applyCoinbasePositionDetails(normalized.spotPositions,await connections.readPositionDetails(scope));}
            catch(error){if(!(error instanceof CoinbaseError)||error.code!=='provider')throw error;}
          }
          await connections.assertChatScope(scope);check();
          await database.use(db => db.transaction(async tx => {
            await tx.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)', [accountId, new Date(observedAt).toISOString(), JSON.stringify(normalized)]);
            await tx.query("UPDATE coinbase_portfolio_sync SET state='completed',error_code=NULL WHERE account_id=$1", [accountId]);
          }));
          }
          check();if(activity&&(sourceConfig.reads.orders||sourceConfig.reads.fills))await activity.refresh(scope,[...(sourceConfig.reads.orders?['spot_orders' as const]:[]),...(sourceConfig.reads.fills?['spot_fills' as const]:[])]);
          check();
          // Historical coverage is independent of a successful current balance read.
          if (connections.readHistory&&sourceConfig.reads.history&&normalized) {
            try {
              const previous=(await database.use(db=>db.query<{data:CoinbaseHistory|null}>('SELECT data FROM coinbase_transaction_history WHERE account_id=$1',[accountId]))).rows[0]?.data;
              check();const history = await connections.readHistory(scope,previous??undefined);
              check();
              if(history.wallets) {
                const exact=new Map<string,bigint>();
                for(const wallet of history.wallets) {const quantity=walletBalance(wallet);if(quantity!==null)exact.set(wallet.asset,(exact.get(wallet.asset)??0n)+quantity);}
                // Preserve Coinbase's displayed holding rows and fiat marks; correct only their units.
                for(const position of normalized.spotPositions)if(exact.has(position.asset)) {const quantity=scaledIntegerToDecimal(exact.get(position.asset)!,36);if(sameDisplayQuantity(quantity,position.quantity))position.quantity=quantity;}
                await connections.assertChatScope(scope);
                await database.use(db=>db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[accountId,new Date(now()).toISOString(),JSON.stringify(normalized)]));
              }
              const valuation: CoinbaseValuation = normalized.warnings.length ? {state:'unavailable',reason:'coverage',points:[]} : await reconstructCoinbaseDay(history,normalized.spotPositions,normalized.portfolio.currency,observedAt,(product,start,end)=>{check();return prices.candles(product,start,end);});
              const dailyValuation=valuation.reason==='price_gap' ? await reconstructCoinbaseDay(history,normalized.spotPositions,normalized.portfolio.currency,observedAt,
                (product,start,end)=>{check();return prices.candles(product,start,end,86400);},(product,date)=>{check();return prices.dailySpot(product,date);}) : undefined;
              check();await connections.assertChatScope(scope);
              await database.use(db => db.query(`INSERT INTO coinbase_transaction_history(account_id,checked_at,state,error_code,data)
                VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO UPDATE SET checked_at=excluded.checked_at,state=excluded.state,error_code=excluded.error_code,data=excluded.data`,
                [accountId,new Date(now()).toISOString(),history.state,history.reason,JSON.stringify({...history,valuation,dailyValuation})]));
            } catch (error) {
              await database.use(db => db.query(`INSERT INTO coinbase_transaction_history(account_id,checked_at,state,error_code)
                VALUES($1,$2,'failed',$3) ON CONFLICT(account_id) DO UPDATE SET checked_at=excluded.checked_at,state='failed',error_code=excluded.error_code`,
                [accountId,new Date(now()).toISOString(),[coinbaseError(error).code,coinbaseError(error).detail].filter(Boolean).join(':')]));
            }
          }
          check();
          if(!sourceConfig.reads.portfolio)await database.use(db=>db.query("UPDATE coinbase_portfolio_sync SET state='completed',error_code=NULL WHERE account_id=$1",[accountId]));
          const failed=(await database.use(db=>db.query(`SELECT 1 FROM coinbase_activity_sync WHERE account_id=$1 AND state='failed' AND resource=ANY($2::text[])
            UNION ALL SELECT 1 FROM coinbase_transaction_history WHERE account_id=$1 AND state='failed' AND $3 LIMIT 1`,[accountId,[...(sourceConfig.reads.orders?['spot_orders']:[]),...(sourceConfig.reads.fills?['spot_fills']:[])],sourceConfig.reads.history]))).rows.length>0;
          await schedule(accountId,failed);
          sourceOptions.synced?.(accountId);
        } catch (error) {
          const safe = coinbaseError(error);
          await database.use(db => db.query("UPDATE coinbase_portfolio_sync SET state='failed',error_code=$2 WHERE account_id=$1", [accountId, safe.code]));
          await schedule(accountId,true);
          throw safe;
        }
      })().finally(() => {active.delete(accountId);activePurpose.delete(accountId);});
      activePurpose.set(accountId,purpose);active.set(accountId, work); return work;
    },
    async snapshot(accountId: string): Promise<PortfolioView> {
      z.uuid().parse(accountId);
      const list = await accounts(), account = list.find(item => item.id === accountId);
      if (!account) throw new CoinbaseError('unavailable');
      const capitalActivity=await createCoinbaseCapital(database,now).activity(accountId);
      return database.use(async db => {
        const latest = (await db.query<{ observed_at: Date; data: Observation }>('SELECT observed_at,data FROM coinbase_portfolio_observations WHERE account_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1', [accountId])).rows[0];
        const sync = (await db.query<{ state: string; error_code: string | null }>('SELECT state,error_code FROM coinbase_portfolio_sync WHERE account_id=$1', [accountId])).rows[0];
        const history = (await db.query<{ observed_at: Date; total_value: string; currency: string }>(`SELECT DISTINCT ON (date_trunc('hour',observed_at)) observed_at,data->'portfolio'->>'totalValue' AS total_value,data->'portfolio'->>'currency' AS currency
          FROM (SELECT id,observed_at,data FROM coinbase_portfolio_observations WHERE account_id=$1
            UNION ALL SELECT account_id AS id,observed_at,jsonb_build_object('portfolio',jsonb_build_object('totalValue',total_value,'currency',currency)) AS data
            FROM coinbase_valuation_snapshots WHERE account_id=$1 AND quality='complete') observations
          WHERE observed_at>=to_timestamp($2/1000.0)
          ORDER BY date_trunc('hour',observed_at),observed_at DESC,id DESC`, [accountId, now()-366*86400000])).rows;
        const ownership=(await db.query<{allocationId:string;strategyId:string;title:string;asset:string;quantity:string;restore:boolean}>(`SELECT a.id AS "allocationId",a.strategy_id AS "strategyId",coalesce(v.metadata->>'title','Take') AS title,e.asset,sum(e.quantity)::text AS quantity,(a.restore_required OR a.status='reconciliation_required') AS restore
          FROM coinbase_allocations a JOIN coinbase_allocation_entries e ON e.allocation_id=a.id JOIN strategy_versions v ON v.id=a.version_id
          WHERE a.account_id=$1 GROUP BY a.id,a.strategy_id,v.metadata,e.asset,a.restore_required`,[accountId])).rows;
        const valued=latest&&account.available?valueCoinbaseHoldings(latest.data,latest.observed_at.getTime(),now(),livePrice):latest?.data;
        const spotPositions=(valued?.spotPositions??[]).map(position=>{
          const claims=ownership.filter(row=>row.asset===position.asset);
          const valid=claims.every(row=>!row.restore&&!row.quantity.startsWith('-'))&&claims.reduce((sum,row)=>sum+decimalToScaledInteger(row.quantity,36),0n)<=decimalToScaledInteger(position.quantity,36);
          return {...position,takeAllocations:valid?claims.filter(row=>decimalToScaledInteger(row.quantity,36)>0n).map(({allocationId,strategyId,title,quantity})=>({allocationId,strategyId,title,quantity})):undefined};
        });
        const allocations=(await db.query<CoinbasePortfolioAllocation>(`SELECT a.id,a.strategy_id AS "strategyId",t.id AS "takeId",a.status,a.restore_required AS restore,
          coalesce(v.metadata->>'title','Take') AS title,coalesce(v.metadata->>'description','') AS description,v.spec
          FROM coinbase_allocations a JOIN strategy_versions v ON v.id=a.version_id LEFT JOIN takes t ON t.strategy_id=a.strategy_id WHERE a.account_id=$1`,[accountId])).rows;
        const attributed=coinbasePortfolioStrategies(allocations,ownership,spotPositions);
        const txHistory = (await db.query<{checked_at:Date;state:'complete'|'partial'|'failed';error_code:string|null;data:(CoinbaseHistory & {valuation?:CoinbaseValuation;dailyValuation?:CoinbaseValuation})|null}>('SELECT checked_at,state,error_code,data FROM coinbase_transaction_history WHERE account_id=$1',[accountId])).rows[0];
        const coinbaseHistory = txHistory ? {reconciliation:txHistory.data&&latest?reconcileCoinbaseHistory(txHistory.data,latest.data.spotPositions):undefined,state:txHistory.state,checkedAt:txHistory.checked_at.toISOString(),transactionCount:txHistory.data?.transactions.length??0,walletCount:txHistory.data?.walletCount??0,completedWallets:txHistory.data?.completedWallets??0,issue:txHistory.error_code,valuation:txHistory.data?.valuation?.state,valuationIssue:txHistory.data?.valuation?.reason??null,dailyValuation:txHistory.data?.dailyValuation?.state,dailyValuationIssue:txHistory.data?.dailyValuation?.reason} : undefined;
        const observations=history.map(row=>({observedAt:row.observed_at.toISOString(),totalValue:row.total_value,currency:row.currency}));
        // Prefer observations wherever available; reconstruction only fills the earlier window.
        const firstObservation=observations[0]?.observedAt??'';
        const reconstructed=txHistory?.state==='complete' ? [...(txHistory.data?.dailyValuation?.points??[]),...(txHistory.data?.valuation?.points??[])].filter(p=>p.observedAt<firstObservation) : [];
        const activityStatus=(await db.query<{resource:'spot_orders'|'spot_fills';state:string;completed_at:Date|null;error_code:string|null}>('SELECT resource,state,completed_at,error_code FROM coinbase_activity_sync WHERE account_id=$1',[accountId])).rows.map(row=>({resource:row.resource,observedAt:row.completed_at?.toISOString()??null,state:row.state,errorCode:row.error_code,stale:!account.available||!row.completed_at||now()-row.completed_at.getTime()>900000}));
        const orders=(await db.query<{data:PortfolioView['orders'][number]}>("SELECT data FROM account_orders WHERE account_id=$1 AND provider='coinbase' ORDER BY data->>'sourceCreatedAt' DESC LIMIT 500",[accountId])).rows.map(row=>row.data);
        const executions=(await db.query<{data:PortfolioView['executions'][number]}>("SELECT data FROM account_executions WHERE account_id=$1 AND provider='coinbase' ORDER BY occurred_at DESC LIMIT 500",[accountId])).rows.map(row=>row.data);
        const accountTransactions=(txHistory?.data?.transactions??[]).map(({id,asset,amount,type,status,occurredAt,fee,networkFee,orderRef})=>({id,asset,amount,type,status,occurredAt,fee,networkFee,orderRef}));
        return { accountTransactions, capitalActivity, coinbaseHistory, account, accounts: list, portfolio: valued?.portfolio ?? null, spotPositions, strategies:attributed.strategies,selfDirectedSpotPositions:attributed.selfDirectedSpotPositions,allocationWarnings:[...(latest?.data.warnings??[]),...attributed.warnings],
          resources: [{ resource: 'portfolio', observedAt: latest?.observed_at.toISOString() ?? null, state: sync?.state ?? 'not_synced', errorCode: sync?.error_code ?? null, stale: !account.available || !latest || now()-latest.observed_at.getTime()>900000 },...activityStatus],
          history: [...reconstructed,...observations],
          positions: [], positionHistory: [], orders, executions, gaps: [], reservedCash: '0' };
      });
    },
  };
  return {...service,prices,markets:createCoinbaseMarkets(prices,now,(accountId,product)=>readMarket(accountId,'coinbase_products_get',{product_id:product})),series:createCoinbaseHoldingSeries(service.snapshot,prices,now)};
}
