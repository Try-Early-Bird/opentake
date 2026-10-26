import {personalCashHeld,unsettledTakeCash} from '../orders/cash-holds';
import {cryptoInstrumentFromRef} from '../orders/crypto-take-identity';
import {cryptoPreviewInput} from '../orders/crypto-preview-contract';
import {cryptoSizingPolicy} from '../planning/crypto-sizing-policy';
import {instrumentKey} from '../../shared/strategies';
import {sizeTargetBasket,type SizingPolicy} from '../planning/basket-sizing';
import {hasRobinhoodCrypto,isRobinhoodCryptoModel,type createCryptoModel} from '../assets/crypto-model';
import {lastCompletedBasketDay} from '../trading/session-policy';
import {executionBasket} from '../mixed-execution/basket';
import {basketEligibility} from '../trading/eligibility';
import { assertBasketExecution } from '../../shared/strategies';
import {createHash,randomUUID} from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import type {PlanOptions,PlanResult,PlanSleeve,PlanTrigger,Planner} from './contracts';
import {takeMarketOrder,type EquityOrder} from '../orders/contract';
import {decimalToScaledInteger,scaledIntegerToDecimal} from '../allocations/decimal';
import {deriveAllocationValuation} from '../allocations/allocation-valuation';
import {correctionImproves,measureDrift,positionsAtCloses,projectPositionsAfterOrders,targetPositionsAtCloses,type DriftMeasure} from '../allocations/drift';
import {planRedemption,redemptionSales} from '../allocations/redemption';
import {redemptionNeedsReconfirm,retryHoldUntil} from '../allocations/allocation-transactions';
import {instruction} from '../allocations/ledger';
import {delistedMarks} from './delistings';
import {computeModelValuations,modelWeightsFromValuation,scheduledRebalanceDays,type DailyClose} from '../strategies/model-valuation';
import {easternClock,isTradingDay,shiftEasternDate,easternWallTimeToUtc} from '../market-series/sessions';
import {dailyNotionalExceeded,lossLimitReached,MINIMUM_ORDER_NOTIONAL_USD} from './limits';
import {preflightSubscription,type InstrumentPolicy,type PreflightResult} from './preflight';
import type {BasketSpec,StrategyInstrument} from '../../shared/strategies';
import {lotsForAllocationSell,prefetchSellLots,type SellLots,type TaxLotReader} from './sell-lots';

// The strategy planner for local allocations. An allocation is a
// strategy_allocations row, its
// legs are strategy_executions, every run records a strategy_execution_plans
// row. The planner never places an order; it writes queued legs whose
// order_request is the writer's contract (orders/contract.ts).
// Local differences: the model's current weights are valued on read from the
// local price store's daily closes;
// tradability comes from the committed version's verification; sells use
// Robinhood's default lot order (no tax-lot resolver is wired yet); there is
// no daily drift history table.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Closes=(symbols:string[],fromDay:string,query:Pick<PGlite,'query'>)=>Promise<Map<string,DailyClose[]>>;
const SNAPSHOT_MAX_AGE_MS=15*60*1_000;
const DEFER_RETRY_MS=5*60*1_000;
const SELL_PROCEEDS_HAIRCUT_BPS=100n;
/** A share-denominated sell clears the minimum by 5%. */
export const SELL_MINIMUM_HEADROOM_BPS=500;
const TRADABILITY_TTL_MS=24*60*60*1_000;
/** Execution states that block planning another group for the same allocation. */
export const OPEN_EXECUTION_STATES=['queued','reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required'] as const;
const OPEN_SQL=`(${OPEN_EXECUTION_STATES.map(s=>`'${s}'`).join(',')})`;

const easternDateOf=(ms:number)=>easternClock(ms).date;
/** The most recent trading day strictly before `today`. */
export function lastCompletedTradingDay(today:string):string{
 let day=shiftEasternDate(today,-1);
 while(!isTradingDay(day))day=shiftEasternDate(day,-1);
 return day;
}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuidFromHash=(hash:string)=>`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
const nonNegativeDecimal=(value:string)=>/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value);
const plain=(value:string)=>value.includes('.')?value.replace(/0+$/u,'').replace(/\.$/u,''):value;
/** The writer's decimal form: whole cents for dollars, at most six places for shares. */
const cents=(value:string)=>{const [w,f='']=plain(value).split('.');return f?`${w}.${f.slice(0,2)}`.replace(/\.$/u,''):w!;};
const shares=(value:string)=>{const [w,f='']=plain(value).split('.');return f?`${w}.${f.slice(0,6)}`.replace(/0+$/u,'').replace(/\.$/u,''):w!;};


interface AllocationRecord {
 id:string;status:string;restore_required:boolean;strategy_id:string;account_id:string;
 allocation_value:string|null;max_daily_notional:string|null;max_loss:string|null;applied_version_sequence:number;
 strategy_status:string;archived_at:Date|null;version_id:string|null;version_sequence:number|null;spec:BasketSpec|null;
 verification:{checkedAt?:string;results?:{instrument:StrategyInstrument;state:string;tradable:boolean|null;fractional:boolean|null}[]}|null;
 version_created_at:Date|null;available:boolean;agentic_allowed:boolean;selected:boolean;
}

/** The tax_lots field a sell carries when it names specific lots. */
const lotsFor=(choice:SellLots|undefined)=>choice?.kind==='lots'?{tax_lots:choice.taxLots}:{};

export function createPlanner(database:Database,deps:{closes?:Closes; cryptoModel?:ReturnType<typeof createCryptoModel>['read'];
 /** Live open lots per symbol, so sells name the allocation's own lots (strategy-owned tax lots). */
 taxLots?:TaxLotReader}={},clock=()=>Date.now()){
 const weightsOf=(spec:BasketSpec)=>{assertBasketExecution(spec);return {weights:spec.target.weights.map(w=>({symbol:w.instrument.market?instrumentKey(w.instrument):w.instrument.symbol.toUpperCase(),weightPercent:w.bps/100})),cashPercent:spec.target.cashBps/100};};

 async function load(tx:Pick<PGlite,'query'>,allocationId:string){
  const record=(await tx.query<AllocationRecord>(`SELECT a.id,a.status,a.restore_required,a.strategy_id,a.account_id,a.allocation_value::text,a.max_daily_notional::text,a.max_loss::text,
   a.applied_version_sequence,s.status AS strategy_status,s.archived_at,v.id AS version_id,v.sequence AS version_sequence,v.spec,v.verification,coalesce((SELECT (d.effective_on::text||'T17:00:00Z')::timestamptz FROM strategy_version_effective_dates d WHERE d.version_id=v.id),v.created_at) AS version_created_at,
   l.available,l.agentic_allowed,l.selected
   FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id JOIN linked_accounts l ON l.id=a.account_id
   LEFT JOIN strategy_versions v ON v.id=a.accepted_version_id WHERE a.id=$1`,[allocationId])).rows[0];
  if(record?.spec&&record.version_id)record.spec=await executionBasket(tx,record.spec,{strategyId:record.strategy_id,versionId:record.version_id,accountId:record.account_id},'robinhood');
  return record;
 }

 /** Model weights: the committed version marked to the stored closes since it took effect. */
 async function modelOf(record:AllocationRecord,q:Pick<PGlite,'query'>):Promise<{weights:{symbol:string;weightPercent:number}[];cashPercent:number;units:Record<string,string>;closes:Record<string,string>;cash:string;valuedOn:string}|null|'stale'>{
  if(record.spec&&hasRobinhoodCrypto(record.spec)){
   if(!record.version_id||!deps.cryptoModel)return 'stale';
   const result=await deps.cryptoModel(q,record.account_id,{id:record.version_id,sequence:record.version_sequence??1,spec:record.spec});
   if(!result.ready)return 'stale';
   const weights=modelWeightsFromValuation(result.current);
   return weights?{...weights,units:result.current.units,closes:result.current.closes,cash:result.current.cash,valuedOn:result.current.valuedOn}:'stale';
  }
  if(record.spec===null||record.version_created_at===null||deps.closes===undefined)return null;
  const today=easternDateOf(clock());
  const expected=lastCompletedBasketDay(record?.spec??null,today);
  const effectiveOn=easternDateOf(new Date(record.version_created_at).getTime());
  // A version committed since the last completed session: its weights still are the model.
  if(effectiveOn>expected)return null;
  const allocation=weightsOf(record.spec);
  const closes=await deps.closes(allocation.weights.map(w=>w.symbol),effectiveOn,q);
  const days=[...new Set([...closes.values()].flatMap(list=>list.map(c=>c.day)))].filter(day=>day>=effectiveOn&&day<=today).sort();
  // A delisted sleeve closes to cash at its last close.
  // Read on the caller's handle: modelOf runs inside the planner's transaction.
  const delisted=await delistedMarks(q,allocation.weights.map(w=>w.symbol));
  const rows=computeModelValuations({allocations:[{id:record.version_id!,sequence:record.version_sequence??1,...allocation,effectiveOn}],closesBySymbol:closes,days,
   rebalanceDays:scheduledRebalanceDays(days,record.spec.rebalance.schedule),driftBands:record.spec.rebalance,delisted});
  const last=rows.at(-1);
  if(last===undefined||last.valuedOn<expected)return 'stale';
  const weights=modelWeightsFromValuation(last);
  return weights===null?'stale':{...weights,units:last.units,closes:last.closes,cash:last.cash,valuedOn:last.valuedOn};
 }

 async function blockedSymbols(tx:Pick<PGlite,'query'>):Promise<Set<string>>{
  const row=(await tx.query<{blocked_symbols:string[]}>(`SELECT blocked_symbols FROM trading_preferences LIMIT 1`)).rows[0];
  return new Set((row?.blocked_symbols??[]).map(s=>s.toUpperCase()));
 }

 /** Fresh positions (sync checkpoint within 15 minutes), the latest snapshot, and the allocation's ledger. */
 async function evidence(tx:Pick<PGlite,'query'>,record:AllocationRecord,now:number){
  const heldClasses=new Set((await tx.query<{asset_class:string}>(`SELECT asset_class FROM strategy_attribution_entries WHERE allocation_id=$1 AND instrument_ref IS NOT NULL GROUP BY asset_class,instrument_ref HAVING sum(quantity_delta)<>0`,[record.id])).rows.map(p=>p.asset_class));
  const ownsCrypto=heldClasses.has('crypto');
  const crypto=(record.spec!==null&&hasRobinhoodCrypto(record.spec))||ownsCrypto;
  const resources=crypto?(record.spec&&isRobinhoodCryptoModel(record.spec)&&!heldClasses.has('equity')?['crypto_positions']:['equity_positions','crypto_positions']):['equity_positions'];
  type Position={instrumentRef:string;symbol:string|null;quantity:string;markPrice:string|null;marketValue:string|null;priceObservedAt?:string|null;providerPayload?:{cryptoSizing?:{quantityIncrement:string;minimumQuantity:string;maximumQuantity:string;minimumNotional:string|null}}};
  const data:Position[]=[],cryptoKeys=new Set<string>();let observedAt=new Date(now).toISOString();
  for(const resource of resources){
   const isCrypto=resource==='crypto_positions';
   const checkpoint=(await tx.query<{watermark:Date}>(`SELECT watermark FROM account_sync_checkpoints WHERE account_id=$1 AND resource=$2`,[record.account_id,resource])).rows[0];
   if(!checkpoint||now-new Date(checkpoint.watermark).getTime()>(isCrypto?60000:SNAPSHOT_MAX_AGE_MS)||new Date(checkpoint.watermark).getTime()>now)return null;
   const snapshot=(await tx.query<{data:Position[];observed_at:Date}>(`SELECT s.data,o.observed_at FROM account_observations o JOIN position_snapshots s ON s.id=o.position_snapshot_id AND s.account_id=o.account_id WHERE o.account_id=$1 AND o.resource=$2 ORDER BY o.observed_at DESC LIMIT 1`,[record.account_id,resource])).rows[0];
   if(!snapshot)return null;
   observedAt=new Date(Math.min(Date.parse(observedAt),new Date(snapshot.observed_at).getTime())).toISOString();
   for(const p of snapshot.data){
    if(isCrypto)cryptoKeys.add(p.instrumentRef);
    const stamp=Date.parse(p.priceObservedAt??'');
    data.push({...p,instrumentRef:crypto&&!isCrypto?p.symbol?.toUpperCase()??p.instrumentRef:p.instrumentRef,symbol:p.symbol?.toUpperCase()??null,
     markPrice:isCrypto&&(!Number.isFinite(stamp)||stamp>now||now-stamp>60000)?null:p.markPrice,marketValue:isCrypto?null:p.marketValue});
   }
  }
  for(const w of record.spec?.target.weights??[])if(w.instrument.market)cryptoKeys.add(instrumentKey(w.instrument));
  const cash=(await tx.query<{cash:string}>(`SELECT coalesce(sum(cash_delta),0)::text AS cash FROM strategy_attribution_entries WHERE allocation_id=$1`,[record.id])).rows[0]!.cash;
  const positions=(await tx.query<{symbol:string;instrumentRef:string|null;quantity:string}>(crypto
   ?`SELECT max(symbol) AS symbol,CASE WHEN asset_class='crypto' THEN instrument_ref ELSE upper(symbol) END AS "instrumentRef",sum(quantity_delta)::text AS quantity FROM strategy_attribution_entries WHERE allocation_id=$1 AND instrument_ref IS NOT NULL GROUP BY asset_class,CASE WHEN asset_class='crypto' THEN instrument_ref ELSE upper(symbol) END`
   :`SELECT upper(symbol) AS symbol,NULL AS "instrumentRef",coalesce(sum(quantity_delta),0)::text AS quantity FROM strategy_attribution_entries WHERE allocation_id=$1 AND symbol IS NOT NULL GROUP BY upper(symbol)`,[record.id])).rows;
  for(const p of positions)if(p.instrumentRef&&cryptoInstrumentFromRef(p.instrumentRef,p.symbol))cryptoKeys.add(p.instrumentRef);
  const valuation=deriveAllocationValuation({cashUsd:plain(cash),positions:positions.map(p=>({symbol:p.symbol,quantity:plain(p.quantity),...(crypto&&p.instrumentRef?{instrumentRef:p.instrumentRef}:{})})),snapshot:data});
  const sizingPolicies=new Map<string,SizingPolicy>();
  if(crypto&&valuation.ready)for(const p of data){
   const policy=p.markPrice?cryptoSizingPolicy(p.providerPayload?.cryptoSizing,p.markPrice):null;
   if(!policy||!p.markPrice)continue;
   sizingPolicies.set(p.instrumentRef,policy);
   if(record.spec!.target.weights.some(w=>instrumentKey(w.instrument)===p.instrumentRef)&&!valuation.positions.has(p.instrumentRef))valuation.positions.set(p.instrumentRef,{quantity:'0',valueUsd:'0',markPriceUsd:p.markPrice});
  }
  return {valuation,sizingPolicies,cryptoKeys,observedAt};
 }

 async function recordPlan(tx:Transaction,input:{allocationId:string;transactionId:string|null;trigger:string;disposition:PlanResult['disposition'];reasonCode:string|null;sleeves:PlanSleeve[]}):Promise<string>{
  const id=randomUUID();
  await tx.query(`INSERT INTO strategy_execution_plans(id,allocation_id,transaction_id,trigger,disposition,reason_code,sleeves,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
   [id,input.allocationId,input.transactionId,input.trigger,input.disposition,input.reasonCode,JSON.stringify(input.sleeves),new Date(clock()).toISOString()]);
  return id;
 }

 async function insertLeg(tx:Transaction,input:{record:AllocationRecord;planId:string;transactionId:string;kind:'subscribe'|'rebalance'|'liquidate'|'redeem';trigger:string;order:EquityOrder|ReturnType<typeof cryptoPreviewInput.parse>;symbol?:string;notional:string;idempotency:unknown}):Promise<string>{
  const id=randomUUID(),now=new Date(clock()).toISOString();
  await tx.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,plan_id,transaction_id,kind,trigger,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at,planned_notional)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13,$14,$15,$15,$16)`,
   [id,input.record.id,input.record.account_id,input.record.strategy_id,input.record.version_id,input.planId,input.transactionId,input.kind,input.trigger,input.symbol??('symbol' in input.order?input.order.symbol:''),input.order.side,
    JSON.stringify(input.order),uuidFromHash(sha(input.idempotency)),sha({accountId:input.record.account_id,assetClass:'currency_pair_id' in input.order?'crypto':'equity',orderRequest:input.order}),now,input.notional]);
  return id;
 }

 async function planAllocation(allocationId:string,trigger:PlanTrigger,options:PlanOptions&{dryRun?:boolean}={}):Promise<PlanResult>{
  // Lots are read before the transaction: a network call must not hold the database.
  const sellLots=options.dryRun?new Map():await prefetchSellLots(database,deps.taxLots,allocationId);
  return database.use(db=>db.transaction(async tx=>{
   const nowMs=clock(),now=new Date(nowMs).toISOString();
   const record=await load(tx,allocationId);
   const base={allocationId,planId:null as string|null,executionIds:[] as string[],sleeves:[] as PlanSleeve[]};
   if(!record)return {...base,disposition:'failed',reasonCode:'allocation_not_found'};
   // Money recorded before planning and still waiting: this run buys with it, oldest first.
   const waitingMoney=options.dryRun||record.status!=='active'?undefined:(await tx.query<{id:string}>(`SELECT id FROM strategy_allocation_transactions
    WHERE allocation_id=$1 AND kind IN ('investment','contribution') AND pending_reason IS NOT NULL AND outcome IS NULL ORDER BY created_at LIMIT 1`,[allocationId])).rows[0];
   const recorded=async(result:PlanResult,transactionId:string|null=null):Promise<PlanResult>=>{
    if(options.dryRun)return result;
    if(waitingMoney!==undefined){
     const waiting=result.disposition==='deferred'||result.disposition==='failed';
     await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason=$2 WHERE id=$1`,[waitingMoney.id,waiting?(result.reasonCode??'deferred'):null]);
    }
    if(result.planId!==null)return result;
    return {...result,planId:await recordPlan(tx,{allocationId,transactionId,trigger,disposition:result.disposition,reasonCode:result.reasonCode,sleeves:result.sleeves})};
   };
   const park=async(disposition:'deferred'|'failed',reasonCode:string)=>{
    if(!options.dryRun)await tx.query(`UPDATE strategy_allocations SET planning_reason_code=$2,planning_deferred_until=$3,updated_at=$4 WHERE id=$1`,[allocationId,reasonCode,new Date(nowMs+DEFER_RETRY_MS).toISOString(),now]);
    return recorded({...base,disposition,reasonCode});
   };
   if(record.status!=='active'||record.restore_required)return {...base,disposition:'deferred',reasonCode:record.restore_required?'restore_required':`allocation_${record.status}`};
   if(record.strategy_status!=='committed'||record.archived_at!==null||record.spec===null||record.version_sequence===null)return park('deferred','strategy_not_published');
   const rebalancePlan=options.dryRun===true||trigger!=='republish';
   if(!rebalancePlan&&record.version_sequence<=record.applied_version_sequence){
    if(!options.dryRun)await tx.query(`UPDATE strategy_allocations SET planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1 AND planning_reason_code='enqueued'`,[allocationId,now]);
    return recorded({...base,disposition:'up_to_date',reasonCode:null});
   }
   if(!record.available||!record.agentic_allowed||!record.selected)return park('deferred','account_unavailable');
   const allocation=weightsOf(record.spec);
   // Allocations created before migration 34 carry no allocation_value; the ledger's value caps the orders instead.
   if(record.allocation_value!==null&&!nonNegativeDecimal(plain(record.allocation_value)))return park('failed','invalid_allocation_value');
   const allocationValue=record.allocation_value===null?null:plain(record.allocation_value);
   if((await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ${OPEN_SQL} LIMIT 1`,[allocationId])).rows.length)return park('deferred','open_execution');
   if((await tx.query(`SELECT 1 FROM strategy_reconciliation_cases WHERE resolved_at IS NULL AND impacts @> jsonb_build_array(jsonb_build_object('allocationId',$1::text)) LIMIT 1`,[allocationId])).rows.length)
    return park('deferred','reconciliation_required');
   // Consecutive failed runs back retries off, doubling to a day; a person asking to plan is never held.
   if(trigger!=='manual'){
    const recentRuns=(await tx.query<{failed:boolean;ended_at:Date|null}>(`SELECT bool_or(e.status='failed') AS failed,max(e.terminal_at) AS ended_at
     FROM strategy_allocation_transactions t JOIN strategy_executions e ON e.transaction_id=t.id WHERE t.allocation_id=$1
     GROUP BY t.id,t.created_at ORDER BY t.created_at DESC LIMIT 6`,[allocationId])).rows;
    const holdUntil=retryHoldUntil({recentRuns:recentRuns.map(r=>({failed:r.failed===true,endedAt:r.ended_at===null?null:new Date(r.ended_at).toISOString()})),now:nowMs});
    if(holdUntil!==null){
     if(!options.dryRun)await tx.query(`UPDATE strategy_allocations SET planning_reason_code='retry_backoff',planning_deferred_until=$2,updated_at=$3 WHERE id=$1`,[allocationId,holdUntil,now]);
     return {...base,disposition:'deferred',reasonCode:'retry_backoff'};
    }
   }
   const seen=await evidence(tx,record,nowMs);
   if(seen===null)return park('deferred','fresh_position_snapshot_required');
   const valuation=seen.valuation;
   if(!valuation.ready)return park('deferred',valuation.reason);
   const capital=(await tx.query<{capital:string}>(`SELECT coalesce(sum(cash_delta),0)::text AS capital FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type IN ('capital_allocated','capital_released')`,[allocationId])).rows[0]!.capital;
   if(lossLimitReached(record.max_loss===null?null:plain(record.max_loss),plain(capital),valuation.allocationValueUsd)){
    if(!options.dryRun)await tx.query(`UPDATE strategy_allocations SET status='paused',paused_at=$2,planning_reason_code='loss_limit_reached',planning_deferred_until=NULL,updated_at=$2 WHERE id=$1 AND status='active'`,[allocationId,now]);
    return {...base,disposition:'deferred',reasonCode:'loss_limit_reached'};
   }
   // Every plan targets the model portfolio as it stands, not the weights as committed.
   const model=await modelOf(record,tx);
   if(model==='stale')return park('deferred','model_stale');
   const modelWeights=model===null?null:{weights:model.weights,cashPercent:model.cashPercent};
   const targets=new Map((modelWeights?.weights??allocation.weights).map(w=>[w.symbol,w.weightPercent]));
   // A delisted symbol gets no leg either way: nothing can be bought, and shares still attributed are released, not sold (hosted).
   const delisted=new Set((await delistedMarks(tx)).keys());
   for(const symbol of delisted)targets.delete(symbol);
   // Tradability from the version's verification; verdicts older than a day are not trusted.
   const checkedAt=Date.parse(record.verification?.checkedAt??'');
   const untradableNow=new Set(Number.isFinite(checkedAt)&&checkedAt<=nowMs&&nowMs-checkedAt<=TRADABILITY_TTL_MS
    ?(record.verification?.results??[]).filter(r=>r.tradable===false).map(r=>r.instrument.market?instrumentKey(r.instrument):r.instrument.symbol.toUpperCase()).filter(s=>targets.has(s)):[]);
   const holdsBasket=[...targets.keys()].every(symbol=>decimalToScaledInteger(valuation.positions.get(symbol)?.quantity??'0')>0n);
   // A first purchase only buys with the allocation's cash. One that already holds shares (of an
   // earlier version, its sequence not yet advanced) is rebalancing: it may sell to fund buys.
   const holdsAny=[...valuation.positions.values()].some(p=>decimalToScaledInteger(p.quantity)>0n);
   const firstPurchase=record.applied_version_sequence===0&&!holdsBasket&&!holdsAny;
   if(untradableNow.size>0){
    if(firstPurchase)return park('deferred','symbol_not_tradable');
    for(const symbol of untradableNow)targets.delete(symbol);
   }
   const blocked=await blockedSymbols(tx);
   const blockedNow=new Set([...targets.keys()].filter(key=>blocked.has(record.spec!.target.weights.find(w=>(w.instrument.market?instrumentKey(w.instrument):w.instrument.symbol)===key)?.instrument.symbol??key)));
   if(blockedNow.size>0){
    if(firstPurchase)return park('deferred','symbol_blocked');
    for(const symbol of blockedNow)targets.delete(symbol);
   }
   const cryptoSizing=seen.cryptoKeys.size>0;
   if(cryptoSizing&&[...new Set([...targets.keys(),...valuation.positions.keys()])].some(key=>seen.cryptoKeys.has(key)&&!seen.sizingPolicies.has(key)))return park('deferred','crypto_sizing_evidence_required');
   const symbols=[...new Set([...targets.keys(),...valuation.positions.keys()])].filter(s=>!delisted.has(s)&&!untradableNow.has(s)&&!blockedNow.has(s)).sort();
   const valueBefore=decimalToScaledInteger(valuation.allocationValueUsd);
   const buysOnly=trigger==='deposit'||options.buysOnly===true;
   // Deploy cash sizes with at most its amount; the valuation and drift keep the real cash.
   const cashUsd=options.cashCapUsd!==undefined&&decimalToScaledInteger(options.cashCapUsd)<decimalToScaledInteger(valuation.cashUsd)?options.cashCapUsd:valuation.cashUsd;
   const sized=sizeTargetBasket({cashUsd,firstPurchase,buysOnly,sellProceedsHaircutBps:Number(SELL_PROCEEDS_HAIRCUT_BPS),policies:seen.sizingPolicies,...(!cryptoSizing?{conserve:{allocationValueUsd:valuation.allocationValueUsd,cashPercent:modelWeights?.cashPercent??allocation.cashPercent}}:{}),
    legs:symbols.map(symbol=>{const position=valuation.positions.get(symbol);return {symbol,targetWeightPercent:targets.get(symbol)??0,allocationValueUsd:valuation.allocationValueUsd,
     currentInstrumentValueUsd:position?.valueUsd??'0',currentQuantity:position?.quantity??'0',availableCashUsd:cashUsd,
     markPriceUsd:position?.markPriceUsd??null,maximumOrderNotionalUsd:allocationValue===null||allocationValue==='0'?valuation.allocationValueUsd:allocationValue,
     minimumOrderNotionalUsd:MINIMUM_ORDER_NOTIONAL_USD,sellMinimumHeadroomBps:SELL_MINIMUM_HEADROOM_BPS};})});
   if(sized.deferred)return park('deferred',sized.deferred==='insufficient_allocation_cash'?'insufficient_bucket_cash':sized.deferred);
   const {orders,decisions}=sized;
   // A first purchase is the whole basket or nothing.
   if(!basketEligibility(firstPurchase,[...targets.keys()],orders.filter(o=>o.side==='buy').map(o=>o.symbol)).ok)return park('deferred','incomplete_basket');
   // Daily notional cap: the group is planned whole or not at all.
   // What a leg spends or raises in USD: the buy's dollars, or the sell's value at the sizing marks.
   const legNotional=(o:{side:'buy'|'sell';symbol:string;dollarAmount?:string}):string=>o.side==='buy'?o.dollarAmount!:decisions[o.symbol]!.deltaValueUsd;
   const planned=orders.reduce((total,o)=>{const d=decisions[o.symbol];return d===undefined?total:total+decimalToScaledInteger(d.deltaValueUsd);},0n);
   const dayStart=new Date(easternWallTimeToUtc(easternDateOf(nowMs),0)).toISOString();
   const placedToday=(await tx.query<{notional:string;unknown:number}>(`SELECT coalesce(sum(planned_notional),0)::text AS notional,count(*) FILTER (WHERE planned_notional IS NULL)::int AS unknown FROM strategy_executions
    WHERE allocation_id=$1 AND created_at>=$2 AND status NOT IN ('cancelled','failed')`,[allocationId,dayStart])).rows[0]!;
   if(record.max_daily_notional!==null&&placedToday.unknown>0)return park('deferred','daily_notional_evidence_required');
   if(orders.length>0&&dailyNotionalExceeded(record.max_daily_notional===null?null:plain(record.max_daily_notional),plain(placedToday.notional),scaledIntegerToDecimal(planned)))return park('deferred','daily_notional_limit');
   const total=decimalToScaledInteger(valuation.allocationValueUsd);
   const sleeves:PlanSleeve[]=symbols.map(symbol=>{
    const d=decisions[symbol],current=valuation.positions.get(symbol)?.valueUsd??'0';
    return {symbol,targetWeightPercent:targets.get(symbol)??0,currentWeightPercent:total>0n?Number(decimalToScaledInteger(current)*10_000n/total)/100:0,currentValueUsd:current,
     disposition:d?.disposition??'skip',side:d?.disposition==='order'?d.order.side:null,
     amount:d?.disposition==='order'?(d.order.side==='buy'?d.order.dollarAmount:d.order.quantity):null,reason:d!==undefined&&d.disposition!=='order'?d.reason:null,
     notionalUsd:d?.disposition==='order'?legNotional(d.order):null};
   });
   // A caller's notional cap (an approved or agent-capped rule trade) refuses the whole plan; the allocation is not parked.
   if(options.maxNotionalUsd!==undefined&&orders.reduce((total,o)=>total+decimalToScaledInteger(legNotional(o)),0n)>decimalToScaledInteger(options.maxNotionalUsd))return recorded({...base,disposition:'deferred',reasonCode:'notional_cap',sleeves});
   // Drift before the plan, both sides at the model's closes (or the committed weights by share).
   let drift:DriftMeasure|null=null;
   const published=model===null?{positions:allocation.weights.map(w=>({symbol:w.symbol,valueUsd:String(w.weightPercent)})),cashUsd:String(allocation.cashPercent)}:null;
   if(published!==null){
    const follower=positionsAtCloses(valuation.positions,{});
    if(follower.unpriced.length===0)drift=measureDrift({allocated:{positions:follower.positions,cashUsd:valuation.cashUsd},target:published});
   }else if(model!==null){
    const follower=positionsAtCloses(valuation.positions,model.closes),target=targetPositionsAtCloses(model.units,model.closes);
    if(follower.unpriced.length===0&&target.unpriced.length===0)drift=measureDrift({allocated:{positions:follower.positions,cashUsd:valuation.cashUsd},target:{positions:target.positions,cashUsd:model.cash}});
   }
   const finish=async(reached:boolean)=>{
    const updated=await tx.query(`UPDATE strategy_allocations SET applied_version_sequence=CASE WHEN $3 THEN $4 ELSE applied_version_sequence END,applied_version_id=CASE WHEN $3 THEN $7::uuid ELSE applied_version_id END,planning_reason_code=NULL,planning_deferred_until=NULL,
     last_rebalanced_on=$5,last_rebalanced_at=$6,updated_at=$6 WHERE id=$1 AND applied_version_sequence=$2`,[allocationId,record.applied_version_sequence,reached,record.version_sequence,easternDateOf(nowMs),now,record.version_id]);
    if((updated.affectedRows??0)===0)throw new Error('Take allocation state changed');
   };
   // The correction gate: place only if the executable set leaves the allocation closer to the target.
   if(drift!==null&&orders.length>0){
    const closes:Record<string,string>=model?.closes??{};
    const atCloses=new Map([...valuation.positions].map(([symbol,p])=>[symbol,{quantity:p.quantity,markPriceUsd:closes[symbol]??p.markPriceUsd}]));
    const marks:Record<string,string>=model!==null?{...model.closes}:Object.fromEntries(orders.filter(o=>!valuation.positions.has(o.symbol)).map(o=>[o.symbol,'1']));
    const projected=projectPositionsAfterOrders({positions:atCloses,cashUsd:valuation.cashUsd,orders,marks});
    const after=positionsAtCloses(projected.positions,closes);
    const target=model!==null?{...targetPositionsAtCloses(model.units,model.closes),cashUsd:model.cash}:{positions:published!.positions,unpriced:[] as string[],cashUsd:published!.cashUsd};
    if(projected.unpriced.length===0&&after.unpriced.length===0&&target.unpriced.length===0){
     const measured=measureDrift({allocated:{positions:after.positions,cashUsd:projected.cashUsd},target:{positions:target.positions,cashUsd:target.cashUsd}});
     if(!correctionImproves(drift,measured)){
      if(options.dryRun)return {...base,disposition:'up_to_date',reasonCode:'correction_not_improving',sleeves};
      await finish(holdsBasket);
      return recorded({...base,disposition:'up_to_date',reasonCode:'correction_not_improving',sleeves});
     }
    }
   }
   if(options.dryRun)return {...base,disposition:orders.length===0?'up_to_date':'planned',reasonCode:null,sleeves};
   if(orders.length===0){await finish(true);return recorded({...base,disposition:'up_to_date',reasonCode:null,sleeves});}
   // Sells name the allocation's own tax lots; an unsettled or missing lot parks the plan.
   const lotChoices=new Map<string,SellLots>();
   for(const order of orders){
    if(order.side!=='sell'||seen.cryptoKeys.has(order.symbol))continue;
    const choice=await lotsForAllocationSell(tx,{allocationId,symbol:order.symbol,quantity:shares(order.quantity),live:sellLots.get(order.symbol),nowMs});
    if(choice.kind==='unsettled')return park('deferred','lots_unsettled');
    if(choice.kind==='unavailable')return park('deferred','attributed_lots_unavailable');
    lotChoices.set(order.symbol,choice);
   }
   const kind=firstPurchase?'subscribe' as const:'rebalance' as const;
   const transactionId=waitingMoney?.id??await instruction(tx,{allocationId,kind:'rebalance',cause:`plan:${trigger}:${now}`},now);
   const planId=await recordPlan(tx,{allocationId,transactionId,trigger,disposition:'planned',reasonCode:null,sleeves});
   const executionIds:string[]=[];
   const removedInstruments=new Map((await tx.query<{ref:string;symbol:string}>(`SELECT instrument_ref AS ref,min(symbol) AS symbol FROM strategy_attribution_entries WHERE allocation_id=$1 AND asset_class='crypto' GROUP BY instrument_ref HAVING sum(quantity_delta)>0 AND count(DISTINCT symbol)=1`,[allocationId])).rows.map(p=>[p.ref,cryptoInstrumentFromRef(p.ref,p.symbol)]));
   for(const order of orders){
    const instrument=record.spec.target.weights.find(w=>(w.instrument.market?instrumentKey(w.instrument):w.instrument.symbol)===order.symbol)?.instrument??(order.side==='sell'?removedInstruments.get(order.symbol):null);
    if(seen.cryptoKeys.has(order.symbol)&&!instrument?.market)return park('deferred','crypto_instrument_evidence_required');
    const parsed=seen.cryptoKeys.has(order.symbol)?takeMarketOrder({assetClass:'crypto',currencyPairId:instrument!.market!.reference,side:order.side,amount:order.side==='buy'?cents(order.dollarAmount):order.quantity}):takeMarketOrder(order.side==='buy'
     ?{assetClass:'equity',symbol:order.symbol,side:'buy',amount:cents(order.dollarAmount)}
     :{assetClass:'equity',symbol:order.symbol,side:'sell',amount:shares(order.quantity),...lotsFor(lotChoices.get(order.symbol))});
    if(!parsed.success)return park('failed','unrepresentable_order_amount');
    // A new plan after a terminal attempt has fresh keys; existing open legs block duplicate planning.
    executionIds.push(await insertLeg(tx,{record,planId,transactionId,kind,trigger,order:parsed.data,symbol:instrument?.symbol??order.symbol,notional:legNotional(order),
     idempotency:{allocationId,planId,symbol:order.symbol}}));
   }
   await finish(false);
   if(waitingMoney!==undefined)await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1`,[waitingMoney.id]);
   return {...base,planId,disposition:'planned',reasonCode:null,executionIds,sleeves};
  }));
 }

 async function planLiquidation(allocationId:string,input:{kind:'redeem'|'liquidate';transactionId:string;amount?:string;symbols?:string[]|null;previewSymbols?:string[]|null}):Promise<PlanResult>{
  const sellLots=await prefetchSellLots(database,deps.taxLots,allocationId);
  return database.use(db=>db.transaction(async tx=>{
   const nowMs=clock(),now=new Date(nowMs).toISOString();
   const record=await load(tx,allocationId);
   const base={allocationId,planId:null as string|null,executionIds:[] as string[],sleeves:[] as PlanSleeve[]};
   const triggerName=input.kind==='redeem'?'redemption':'close';
   const markInstruction=async(disposition:'deferred'|'failed',reasonCode:string)=>{
    await tx.query(disposition==='deferred'?`UPDATE strategy_allocation_transactions SET pending_reason=$2 WHERE id=$1`
     :`UPDATE strategy_allocation_transactions SET pending_reason=NULL,outcome='failed' WHERE id=$1 AND $2::text IS NOT NULL`,[input.transactionId,reasonCode]);
   };
   const park=async(disposition:'deferred'|'failed',reasonCode:string):Promise<PlanResult>=>{
    await tx.query(`UPDATE strategy_allocations SET planning_reason_code=$2,planning_deferred_until=$3,updated_at=$4 WHERE id=$1`,[allocationId,reasonCode,new Date(nowMs+DEFER_RETRY_MS).toISOString(),now]);
    const planId=await recordPlan(tx,{allocationId,transactionId:input.transactionId,trigger:triggerName,disposition,reasonCode,sleeves:[]});
    await markInstruction(disposition,reasonCode);
    return {...base,planId,disposition,reasonCode};
   };
   if(!record)return {...base,disposition:'failed',reasonCode:'allocation_not_found'};
   const instructionRow=(await tx.query<{outcome:string|null}>(`SELECT outcome FROM strategy_allocation_transactions WHERE id=$1 AND allocation_id=$2`,[input.transactionId,allocationId])).rows[0];
   if(!instructionRow)return {...base,disposition:'failed',reasonCode:'instruction_not_found'};
   if(instructionRow.outcome!==null)return {...base,disposition:'failed',reasonCode:`instruction_${instructionRow.outcome}`};
   if(record.status!=='active'||record.restore_required){
    const code=record.restore_required?'restore_required':`allocation_${record.status}`;
    await markInstruction('deferred',code);
    return {...base,disposition:'deferred',reasonCode:code};
   }
   if(!record.available||!record.agentic_allowed||!record.selected)return park('deferred','account_unavailable');
   if((await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ${OPEN_SQL} LIMIT 1`,[allocationId])).rows.length)return park('deferred','open_execution');
   const seen=await evidence(tx,record,nowMs);
   if(seen===null)return park('deferred','fresh_position_snapshot_required');
   const valuation=seen.valuation;
   if(!valuation.ready)return park('deferred',valuation.reason);
   const crypto=seen.cryptoKeys.size>0;
   const ownedRows=(await tx.query<{ref:string;symbol:string}>(`SELECT instrument_ref AS ref,min(symbol) AS symbol FROM strategy_attribution_entries WHERE allocation_id=$1 AND asset_class='crypto' GROUP BY instrument_ref HAVING sum(quantity_delta)>0 AND count(DISTINCT symbol)=1`,[allocationId])).rows;
   const instruments=new Map(ownedRows.map(p=>[p.ref,cryptoInstrumentFromRef(p.ref,p.symbol)]));
   const label=(key:string)=>seen.cryptoKeys.has(key)?instruments.get(key)?.symbol??key:key;
   let minimum=decimalToScaledInteger(MINIMUM_ORDER_NOTIONAL_USD);
   if(crypto)for(const [key,p] of valuation.positions){
    if(decimalToScaledInteger(p.quantity)===0n||!seen.cryptoKeys.has(key))continue;
    const policy=seen.sizingPolicies.get(key);
    if(!policy||!instruments.get(key))return park('deferred','crypto_sizing_evidence_required');
    const floor=decimalToScaledInteger(policy.minimumOrderNotionalUsd);if(floor>minimum)minimum=floor;
   }
   const selected=input.symbols===undefined||input.symbols===null?null:input.symbols;
   const chosen=selected===null?null:new Set<string>();
   if(selected!==null)for(const name of selected){
    const matches=[...valuation.positions.keys()].filter(key=>key===name||label(key).toUpperCase()===name.toUpperCase());
    if(crypto&&matches.length!==1)return park('deferred','crypto_instrument_evidence_required');
    for(const key of matches)chosen!.add(key);
   }
   let sells:{symbol:string;quantity:string;valueUsd:string}[]=[];
   for(const [symbol,position] of [...valuation.positions].sort(([a],[b])=>a.localeCompare(b))){
    if(decimalToScaledInteger(position.quantity)===0n)continue;
    if(chosen!==null&&!chosen.has(symbol))continue;
    // Positions under the minimum order cannot be sold at market; they stay with the member.
    if(decimalToScaledInteger(position.valueUsd)<(seen.cryptoKeys.has(symbol)?decimalToScaledInteger(seen.sizingPolicies.get(symbol)!.minimumOrderNotionalUsd):decimalToScaledInteger(MINIMUM_ORDER_NOTIONAL_USD))){
     if(seen.cryptoKeys.has(symbol)&&input.kind==='liquidate')return park('deferred','crypto_dust_remaining');
     continue;
    }
    sells.push({symbol,quantity:position.quantity,valueUsd:position.valueUsd});
   }
   // A redemption sells part of every holding, in shares, so a price move cannot take more than the allocation owns.
   if(input.kind==='redeem'){
    if(input.amount===undefined)return park('failed','redemption_amount_required');
    const model=await modelOf(record,tx);
    const targets=model!==null&&model!=='stale'?model.weights:record.spec===null?undefined:weightsOf(record.spec).weights;
    const plan=planRedemption(input.amount,[...valuation.positions].map(([symbol,p])=>({symbol,valueUsd:p.valueUsd})),{minimumOrderNotionalUsd:scaledIntegerToDecimal(minimum),...(targets===undefined?{}:{targets})});
    if(!plan.ok)return park('failed',plan.reasons[0]?.code??'redemption_unavailable');
    const marks=new Map([...valuation.positions].map(([symbol,p])=>[symbol,{markPriceUsd:p.markPriceUsd??'0',attributedQuantity:p.quantity,...(seen.cryptoKeys.has(symbol)?{quantityIncrement:seen.sizingPolicies.get(symbol)?.quantityIncrement,minimumOrderNotionalUsd:seen.sizingPolicies.get(symbol)?.minimumOrderNotionalUsd}:{})}]));
    const {sales,unpriced}=redemptionSales(plan.legs,marks,{minimumOrderNotionalUsd:MINIMUM_ORDER_NOTIONAL_USD,sellHeadroomBps:SELL_MINIMUM_HEADROOM_BPS});
    if(unpriced.length>0)return park('deferred','missing_mark_price');
    if(sales.length===0)return park('failed','nothing_to_sell');
    sells=sales.map(s=>({symbol:s.symbol,quantity:s.quantity,valueUsd:s.notionalUsd}));
   }
   if(crypto)for(const sell of sells){
    if(!seen.cryptoKeys.has(sell.symbol))continue;
    const policy=seen.sizingPolicies.get(sell.symbol)!;
    const quantity=decimalToScaledInteger(sell.quantity),step=decimalToScaledInteger(policy.quantityIncrement),value=decimalToScaledInteger(sell.valueUsd);
    if(quantity%step!==0n)return park('deferred','crypto_dust_remaining');
    if(value<decimalToScaledInteger(policy.minimumOrderNotionalUsd))return park('deferred','crypto_order_below_minimum');
    if(policy.maximumOrderNotionalUsd&&value>decimalToScaledInteger(policy.maximumOrderNotionalUsd))return park('deferred','order_notional_limit');
   }
   const sleeves:PlanSleeve[]=sells.map(s=>({symbol:label(s.symbol),targetWeightPercent:0,currentWeightPercent:0,currentValueUsd:s.valueUsd,disposition:'order',side:'sell',amount:s.quantity,reason:null}));
   if(sells.length===0){
    await tx.query(`UPDATE strategy_allocations SET planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
    if(input.kind==='redeem')await markInstruction('failed','nothing_to_sell');
    else await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1`,[input.transactionId]);
    const planId=await recordPlan(tx,{allocationId,transactionId:input.transactionId,trigger:triggerName,disposition:'skipped',reasonCode:'nothing_to_sell',sleeves});
    return {...base,planId,disposition:'skipped',reasonCode:'nothing_to_sell'};
   }
   // Selling a different set than the member was shown is a different instruction; it waits for them.
   if(input.kind==='redeem'&&redemptionNeedsReconfirm(input.previewSymbols??null,sells.map(s=>label(s.symbol)))){
    const planId=await recordPlan(tx,{allocationId,transactionId:input.transactionId,trigger:triggerName,disposition:'deferred',reasonCode:'reconfirm_required',sleeves});
    await markInstruction('deferred','reconfirm_required');
    return {...base,planId,disposition:'deferred',reasonCode:'reconfirm_required',sleeves};
   }
   const lotChoices=new Map<string,SellLots>();
   for(const sell of sells){
    if(seen.cryptoKeys.has(sell.symbol))continue;
    const choice=await lotsForAllocationSell(tx,{allocationId,symbol:sell.symbol,quantity:shares(sell.quantity),live:sellLots.get(sell.symbol),nowMs});
    if(choice.kind==='unsettled')return park('deferred','lots_unsettled');
    if(choice.kind==='unavailable')return park('deferred','attributed_lots_unavailable');
    lotChoices.set(sell.symbol,choice);
   }
   const planId=await recordPlan(tx,{allocationId,transactionId:input.transactionId,trigger:triggerName,disposition:'planned',reasonCode:null,sleeves});
   const executionIds:string[]=[];
   for(const sell of sells){
    const parsed=seen.cryptoKeys.has(sell.symbol)?takeMarketOrder({assetClass:'crypto',currencyPairId:instruments.get(sell.symbol)!.market!.reference,side:'sell',amount:sell.quantity}):takeMarketOrder({assetClass:'equity',symbol:sell.symbol,side:'sell',amount:shares(sell.quantity),...lotsFor(lotChoices.get(sell.symbol))});
    if(!parsed.success)return park('failed','unrepresentable_order_amount');
    executionIds.push(await insertLeg(tx,{record,planId,transactionId:input.transactionId,kind:input.kind,trigger:triggerName,order:parsed.data,symbol:label(sell.symbol),notional:sell.valueUsd,
     idempotency:{allocationId,symbol:sell.symbol,plannedAt:now,trigger:triggerName}}));
   }
   await tx.query(`UPDATE strategy_allocations SET planning_reason_code='liquidating',planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
   await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1`,[input.transactionId]);
   return {...base,planId,disposition:'planned',reasonCode:null,executionIds,sleeves};
  }));
 }

 /**
  * The preflight a first investment (strategyId) or a deposit (allocationId)
  * must pass before money moves.
  */
 async function preflight(input:{accountId:string;amount:string;strategyId?:string;allocationId?:string},query?:Pick<PGlite,'query'>):Promise<PreflightResult>{
  const read=async(db:Pick<PGlite,'query'>)=>{
   const nowMs=clock();
   let spec:BasketSpec|null=null,verification:AllocationRecord['verification']=null,record:AllocationRecord|undefined;
   if(input.allocationId!==undefined){
    record=await load(db,input.allocationId);
    if(!record||record.account_id!==input.accountId)throw new Error('Allocation not found');
    spec=record.spec;verification=record.verification;
   }else{
    const row=(await db.query<{spec:BasketSpec;verification:AllocationRecord['verification'];id:string;sequence:number;created_at:Date}>(`SELECT v.spec,v.verification,v.id,v.sequence,coalesce((SELECT (d.effective_on::text||'T17:00:00Z')::timestamptz FROM strategy_version_effective_dates d WHERE d.version_id=v.id),v.created_at) AS created_at FROM strategies s
     JOIN strategy_versions v ON v.id=s.current_version_id WHERE s.id=$1 AND s.status='committed' AND s.archived_at IS NULL`,[input.strategyId])).rows[0];
    if(row){spec=row.spec;verification=row.verification;
     record={id:'00000000-0000-0000-0000-000000000000',status:'active',restore_required:false,strategy_id:input.strategyId!,account_id:input.accountId,allocation_value:null,max_daily_notional:null,max_loss:null,applied_version_sequence:0,
      strategy_status:'committed',archived_at:null,version_id:row.id,version_sequence:row.sequence,spec:row.spec,verification:row.verification,version_created_at:row.created_at,available:true,agentic_allowed:true,selected:true};}
   }
   const today=easternDateOf(nowMs);
   const model=record===undefined?null:await modelOf(record,db);
   const published=spec===null?{weights:[],cashPercent:0}:weightsOf(spec);
   const weights=model!==null&&model!=='stale'?{weights:model.weights,cashPercent:model.cashPercent}:published;
   const effectiveOn=record?.version_created_at?easternDateOf(new Date(record.version_created_at).getTime()):today;
   const expected=lastCompletedBasketDay(record?.spec??null,today);
   const symbols:InstrumentPolicy['symbols']={};
   for(const r of verification?.results??[])if(r.tradable!==null)symbols[r.instrument.market?instrumentKey(r.instrument):r.instrument.symbol.toUpperCase()]={tradable:r.tradable,fractional:r.instrument.market?.kind==='crypto'||r.fractional!==false};
   // Cash free for this money: the account's cash less every allocation's claim; room: value less every allocation.
   const portfolio=(await db.query<{data:{cash:string|null;totalValue:string}}>(`SELECT p.data FROM account_observations o JOIN portfolio_snapshots p ON p.id=o.portfolio_snapshot_id
    WHERE o.account_id=$1 AND o.resource='portfolio' ORDER BY o.observed_at DESC LIMIT 1`,[input.accountId])).rows[0]?.data;
   const claims=(await db.query<{cash:string;value:string}>(`SELECT coalesce(sum(e.cash_delta),0)::text AS cash,
    coalesce((SELECT sum(allocation_value) FROM strategy_allocations WHERE account_id=$1 AND status IN ('active','paused','diverged') AND id IS DISTINCT FROM $2::uuid),0)::text AS value
    FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id WHERE a.account_id=$1 AND a.status IN ('active','paused','diverged')`,[input.accountId,input.allocationId??null])).rows[0]!;
   const signed=(value:string)=>value.startsWith('-')?-decimalToScaledInteger(plain(value.slice(1))):decimalToScaledInteger(plain(value));
   const free=(value:string|null|undefined,claimed:string)=>{if(value==null)return null;const left=signed(value)-signed(claimed);return scaledIntegerToDecimal(left<0n?0n:left);};
   const seen=record?await evidence(db,record,nowMs):null;
   const currentValuesUsd=seen?.valuation.ready?Object.fromEntries([...seen.valuation.positions].map(([key,p])=>[key,p.valueUsd])):{};
   const reservedCash=scaledIntegerToDecimal(signed(claims.cash)+await personalCashHeld(db as Transaction,input.accountId)+await unsettledTakeCash(db as Transaction,input.accountId));
   const result=preflightSubscription({amountUsd:input.amount,weights:weights.weights.map(w=>({...w,instrumentRef:w.symbol,symbol:spec?.target.weights.find(t=>(t.instrument.market?instrumentKey(t.instrument):t.instrument.symbol.toUpperCase())===w.symbol)?.instrument.symbol??w.symbol})),cashPercent:weights.cashPercent,
    modelValuedOn:model!==null&&model!=='stale'?model.valuedOn:null,expectedValuedOn:effectiveOn<=expected&&deps.closes!==undefined?expected:null,
    instrumentPolicy:{symbols},availableCashUsd:free(portfolio?.cash,reservedCash),accountRoomUsd:free(portfolio?.totalValue,claims.value),
    blockedSymbols:[...await blockedSymbols(db)],...(input.allocationId?{currentValuesUsd}:{})});
   const refuse=(code:PreflightResult['reasons'][number]['code'])=>({...result,ok:false,legs:[],reasons:[...result.reasons,{code,symbols:[]}]});
   if(model==='stale')return refuse('model_stale');
   if(!seen?.valuation.ready)return refuse('fresh_position_snapshot_required');
   const valuation=seen.valuation;
   const cryptoSizing=seen.cryptoKeys.size>0;
   const keys=[...new Set([...weights.weights.map(w=>w.symbol),...valuation.positions.keys()])].sort();
   if(keys.some(key=>seen.cryptoKeys.has(key)&&!seen.sizingPolicies.has(key)))return refuse('crypto_sizing_evidence_required');
   const cash=scaledIntegerToDecimal(decimalToScaledInteger(valuation.cashUsd)+decimalToScaledInteger(input.amount));
   const total=scaledIntegerToDecimal(decimalToScaledInteger(valuation.allocationValueUsd)+decimalToScaledInteger(input.amount));
   const firstPurchase=record?.applied_version_sequence===0&&![...valuation.positions.values()].some(p=>decimalToScaledInteger(p.quantity)>0n);
   const targetWeights=new Map(weights.weights.map(w=>[w.symbol,w.weightPercent]));
   const sized=sizeTargetBasket({cashUsd:cash,firstPurchase,buysOnly:true,sellProceedsHaircutBps:Number(SELL_PROCEEDS_HAIRCUT_BPS),policies:seen.sizingPolicies,
    ...(!cryptoSizing?{conserve:{allocationValueUsd:total,cashPercent:weights.cashPercent}}:{}),
    legs:keys.map(symbol=>{const p=valuation.positions.get(symbol);return {symbol,targetWeightPercent:targetWeights.get(symbol)??0,allocationValueUsd:total,
     currentInstrumentValueUsd:p?.valueUsd??'0',currentQuantity:p?.quantity??'0',availableCashUsd:cash,markPriceUsd:p?.markPriceUsd??null,
     maximumOrderNotionalUsd:record?.allocation_value&&record.allocation_value!=='0'?scaledIntegerToDecimal(decimalToScaledInteger(plain(record.allocation_value))+decimalToScaledInteger(input.amount)):total,
     minimumOrderNotionalUsd:MINIMUM_ORDER_NOTIONAL_USD,sellMinimumHeadroomBps:SELL_MINIMUM_HEADROOM_BPS};})});
   if(sized.deferred)return refuse('sizing_unavailable');
   if(!basketEligibility(firstPurchase,weights.weights.filter(w=>w.weightPercent>0).map(w=>w.symbol),sized.orders.filter(o=>o.side==='buy').map(o=>o.symbol)).ok)return refuse('incomplete_basket');
   let debit=0n,notional=0n;
   const legs=sized.orders.flatMap(o=>{
    if(o.side!=='buy')return [];
    notional+=decimalToScaledInteger(o.dollarAmount);debit+=decimalToScaledInteger(seen.sizingPolicies.get(o.symbol)?.maximumBuyDebit?.(o.dollarAmount)??o.dollarAmount);
    const instrument=spec?.target.weights.find(w=>(w.instrument.market?instrumentKey(w.instrument):w.instrument.symbol.toUpperCase())===o.symbol)?.instrument;
    return [{symbol:instrument?.symbol??o.symbol,...(instrument?{instrumentRef:instrumentKey(instrument)}:{}),weightPercent:targetWeights.get(o.symbol)??0,notionalUsd:o.dollarAmount}];
   });
   // Provider minima and cash caps are decided by the same engine as queued legs.
   const reasons=result.reasons.filter(r=>r.code!=='leg_below_minimum').map(r=>({...r,symbols:r.symbols.map(key=>spec?.target.weights.find(w=>(w.instrument.market?instrumentKey(w.instrument):w.instrument.symbol.toUpperCase())===key)?.instrument.symbol??key)}));
   return {...result,ok:reasons.length===0,reasons,legs,retainedCashUsd:scaledIntegerToDecimal(decimalToScaledInteger(cash)-debit),
    orderReserveUsd:scaledIntegerToDecimal(debit-notional),existingCashUsed:scaledIntegerToDecimal(debit>decimalToScaledInteger(input.amount)?debit-decimalToScaledInteger(input.amount):0n)};
  };
  return query?read(query):database.use(read);
 }

 return {planAllocation:(allocationId:string,trigger:PlanTrigger,options?:PlanOptions)=>planAllocation(allocationId,trigger,options),
  /** Sizes the legs without writing anything. */
  previewAllocation:(allocationId:string,trigger:PlanTrigger,options?:PlanOptions)=>planAllocation(allocationId,trigger,{...options,dryRun:true}),
  planLiquidation,preflight} satisfies Planner&Record<string,unknown>;
}
