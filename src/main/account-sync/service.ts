import {accountSyncInterval} from './cadence';
import {addStrategyHoldings} from '../allocations/portfolio-view';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import type { createConnections } from '../connections';
import { ConnectionFailure } from '../connection-errors';
import { normalizeRobinhoodOrderPage, type NormalizedRobinhoodOrder } from './order-normalization';
import { normalizeRobinhoodPortfolio, normalizeRobinhoodPositionPage, type NormalizedRobinhoodPosition } from './snapshot-normalization';
import type { AccountResource, PortfolioView, PortfolioAccount, ResourceStatus } from '../../shared/portfolio';
import { normalizeEquityQuoteDetails } from '../market-series/normalization';
import { multiplyDecimals } from '../allocations/decimal';

type Database = ReturnType<typeof createDatabaseLifecycle>;
type Connections = Pick<ReturnType<typeof createConnections>, 'status' | 'readTool'>;
const resources: AccountResource[] = ['portfolio', 'equity_positions', 'option_positions', 'equity_orders', 'option_orders'];
const DAY = 86_400_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminalStates = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'expired', 'failed', 'voided']);
const toolFor = (resource: AccountResource) => `get_${resource}`;
const stripPayload = <T extends { providerPayload: unknown }>(value: T): Omit<T, 'providerPayload'> => {
 const { providerPayload: _ignored, ...safe } = value; return safe;
};

// The portfolio UI is a local read. AI access uses the same selected-account
// policy and platform-access gate as other built-in account tools.
/** Robinhood's quotes tool takes a bounded list; positions are quoted in slices of this size. */
const QUOTE_SLICE = 10;

export function createAccountSync(database: Database, connections: Connections, now = () => Date.now(),cryptoPositions?: (accountId:string)=>Promise<NormalizedRobinhoodPosition[]>,cryptoOrders?:(accountId:string,since:string,knownOpen:string[])=>Promise<NormalizedRobinhoodOrder[]>) {
 const syncResources:AccountResource[]=[...resources,...(cryptoOrders?['crypto_orders' as const]:[]),...(cryptoPositions?['crypto_positions' as const]:[])];
 let active: AbortController | undefined;
 async function eligible(accountId: string) {
  const state = await connections.status();
  if (state.status !== 'connected' || !state.accounts.some(a => a.id === accountId && a.selected && a.agenticAllowed)) throw new ConnectionFailure('reauth_required');
 }
 async function persistOrders(accountId: string, assetClass: 'equity' | 'option' | 'crypto', orders: NormalizedRobinhoodOrder[], observed: string) {
  await database.use(db => db.transaction(async tx => {
   for (const order of orders) {
    const { executions, ...safe } = stripPayload(order);
    await tx.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen)
      VALUES($1,'robinhood',$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(account_id,provider,provider_ref) DO UPDATE SET
      state=excluded.state,terminal=excluded.terminal,data=excluded.data,last_seen=excluded.last_seen`,
      [accountId, order.providerOrderRef, assetClass, order.state, terminalStates.has(order.state), JSON.stringify(safe), observed]);
    for (const execution of executions) {
     // Incomplete evidence must not be silently discarded while advancing the watermark.
     if (!execution.quantity || !execution.price || !execution.occurredAt || !/[1-9]/.test(execution.quantity) || execution.quantity.startsWith('-') || execution.price.startsWith('-')) throw new Error('Incomplete fill');
     const normalized = stripPayload(execution);
     const ref = execution.providerExecutionRef ?? `derived_${hash({ order: order.providerOrderRef, ...normalized })}`;
     const data = { ...normalized, providerExecutionRef: ref, orderRef: order.providerOrderRef, symbol: order.symbol, instrumentRef: order.instrumentRef, side: order.side, origin: order.origin, orderCreatedAt: order.sourceCreatedAt, assetClass };
     const existing = (await tx.query<{data: unknown}>(`SELECT data FROM account_executions WHERE account_id=$1 AND provider='robinhood' AND provider_ref=$2`, [accountId, ref])).rows[0];
     if (existing && hash(existing.data) !== hash(JSON.parse(JSON.stringify(data)))) {
      // JSONB key order is not significant; compare the financial evidence only.
      const old = existing.data as typeof data;
      if (old.quantity !== data.quantity || old.price !== data.price || old.notionalAmount !== data.notionalAmount || old.assetClass !== data.assetClass || old.feeAmount !== data.feeAmount || old.occurredAt !== data.occurredAt || old.orderRef !== data.orderRef || old.side !== data.side || old.instrumentRef !== data.instrumentRef) throw new Error('Changed execution evidence');
     }
     await tx.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at)
       VALUES($1,'robinhood',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [accountId, ref, order.providerOrderRef, assetClass, JSON.stringify(data), execution.occurredAt]);
    }
   }
  }));
 }
 async function syncResource(accountId: string, resource: AccountResource, signal: AbortSignal) {
  const runId = randomUUID(), started = new Date(now()).toISOString();
  await database.use(db => db.query(`INSERT INTO account_sync_runs(id,account_id,resource,state,started_at) VALUES($1,$2,$3,'running',$4)`, [runId, accountId, resource, started]));
  const checkpoint = await database.use(async db => (await db.query<{watermark: Date; discovery_complete: boolean}>(`SELECT watermark,discovery_complete FROM account_sync_checkpoints WHERE account_id=$1 AND resource=$2`, [accountId, resource])).rows[0]);
  try {
   // Allowed silence is the longer of the closed-window cadences at the last read and now:
   // at 4 pm the cadence widens from 15 minutes to an hour, and that wait is not an outage.
   const allowed = Math.max(accountSyncInterval(checkpoint?.watermark.getTime() ?? now(), false), accountSyncInterval(now(), false)) + 2*60_000;
   if (checkpoint && now() - checkpoint.watermark.getTime() > allowed) {
    await database.use(db => db.query(`INSERT INTO account_sync_gaps(id,account_id,resource,from_at,to_at,reason) VALUES($1,$2,$3,$4,$5,'watcher_offline') ON CONFLICT DO NOTHING`, [randomUUID(), accountId, resource, checkpoint.watermark.toISOString(), started]));
   }
   const read = async (args: Record<string, unknown>) => {
    signal.throwIfAborted(); await eligible(accountId);
    const value = await connections.readTool(toolFor(resource), args, accountId, signal);
    signal.throwIfAborted(); return value;
   };
   let snapshot: unknown;
   if(resource==='crypto_orders'){
    if(!cryptoOrders)throw Error('Crypto order reader unavailable');
    const open=(await database.use(db=>db.query<{provider_ref:string}>("SELECT provider_ref FROM account_orders WHERE account_id=$1 AND provider='robinhood' AND asset_class='crypto' AND NOT terminal",[accountId]))).rows.map(r=>r.provider_ref);
    await eligible(accountId);signal.throwIfAborted();
    const orders=await cryptoOrders(accountId,new Date(checkpoint?checkpoint.watermark.getTime()-5*60000:now()-7*DAY).toISOString(),open);
    signal.throwIfAborted();await eligible(accountId);
    // Outside crypto executions are not equity lots or Take-owned fills.
    if(orders.some(order=>order.executions.length))throw Error('Unexpected crypto attribution data');
    await persistOrders(accountId,'crypto',orders,started);
   }
   else if(resource==='crypto_positions'){if(!cryptoPositions)throw Error('Crypto position reader unavailable');snapshot=(await cryptoPositions(accountId)).map(stripPayload);}
   else if (resource === 'portfolio') snapshot = stripPayload(normalizeRobinhoodPortfolio(await read({})));
   else {
    const isOrder = resource.endsWith('_orders');
    const assetClass = resource.startsWith('equity') ? 'equity' : 'option';
    const base: Record<string, unknown> = {};
    // Initial discovery walks the unbounded history, including old open orders.
    // A bounded traversal must finish before discovery_complete can be true.
    if (isOrder && checkpoint?.discovery_complete) base.created_at_gte = new Date(Math.min(now() - 7 * DAY, checkpoint.watermark.getTime() - 300_000)).toISOString();
    const positions = new Map<string, NormalizedRobinhoodPosition>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let pageIndex = 0; ; pageIndex++) {
     if (pageIndex >= 100) throw new Error('History pagination limit');
     const response = await read({ ...base, ...(cursor ? { cursor } : {}) });
     if (isOrder) {
      // Empty lists are valid; arbitrary error objects are not complete history.
      if (!hasOrderEnvelope(response)) throw new Error('Malformed order response');
      const page = normalizeRobinhoodOrderPage(response);
      await persistOrders(accountId, assetClass, page.orders, started); cursor = page.nextCursor;
     } else {
      const page = normalizeRobinhoodPositionPage(response, assetClass);
      for (const position of page.positions) positions.set(position.positionKey, position);
      cursor = page.nextCursor;
     }
     if (!cursor) break;
     if (seen.has(cursor)) throw new Error('Repeated provider cursor');
     seen.add(cursor);
    }
    if (isOrder) {
     const open = await database.use(async db => (await db.query<{provider_ref:string}>(`SELECT provider_ref FROM account_orders WHERE account_id=$1 AND provider='robinhood' AND asset_class=$2 AND NOT terminal ORDER BY provider_ref`, [accountId, assetClass])).rows);
     if (open.length > 500) throw new Error('Open order limit');
     for (const order of open) {
      const page = normalizeRobinhoodOrderPage(await read({ order_id: order.provider_ref }));
      if (!page.orders.some(o => o.providerOrderRef === order.provider_ref)) throw new Error('Missing open order evidence');
      await persistOrders(accountId, assetClass, page.orders.filter(o => o.providerOrderRef === order.provider_ref), started);
     }
    } else {
     if (assetClass === 'equity') await markEquityPositions(positions, signal);
     snapshot = [...positions.values()].sort((a,b) => a.positionKey.localeCompare(b.positionKey)).map(stripPayload);
    }
   }
   signal.throwIfAborted(); await eligible(accountId);
   await database.use(db => db.transaction(async tx => {
    if (snapshot !== undefined) {
     const contentHash = hash(snapshot), snapshotId = randomUUID();
     let id: string;
     if (resource === 'portfolio') {
      id = (await tx.query<{id:string}>(`INSERT INTO portfolio_snapshots(id,account_id,payload_hash,data) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,payload_hash) DO UPDATE SET payload_hash=excluded.payload_hash RETURNING id`, [snapshotId, accountId, contentHash, JSON.stringify(snapshot)])).rows[0].id;
     } else {
      id = (await tx.query<{id:string}>(`INSERT INTO position_snapshots(id,account_id,asset_class,payload_hash,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,asset_class,payload_hash) DO UPDATE SET payload_hash=excluded.payload_hash RETURNING id`, [snapshotId, accountId, resource==='crypto_positions'?'crypto':resource.startsWith('equity') ? 'equity' : 'option', contentHash, JSON.stringify(snapshot)])).rows[0].id;
     }
     await tx.query(`INSERT INTO account_observations(id,run_id,account_id,resource,observed_at,portfolio_snapshot_id,position_snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), runId, accountId, resource, started, resource === 'portfolio' ? id : null, resource === 'portfolio' ? null : id]);
    }
    await tx.query(`INSERT INTO account_sync_checkpoints(account_id,resource,watermark,discovery_complete) VALUES($1,$2,$3,true) ON CONFLICT(account_id,resource) DO UPDATE SET watermark=excluded.watermark,discovery_complete=true`, [accountId, resource, started]);
    await tx.query(`UPDATE account_sync_runs SET state='completed',finished_at=$2 WHERE id=$1`, [runId, new Date(now()).toISOString()]);
   }));
  } catch {
   await database.use(db => db.query(`UPDATE account_sync_runs SET state=$2,finished_at=$3,error_code=$4 WHERE id=$1`, [runId, signal.aborted ? 'interrupted' : 'failed', new Date(now()).toISOString(), signal.aborted ? 'cancelled' : 'sync_incomplete']));
   throw new ConnectionFailure(signal.aborted ? 'cancelled' : 'transient');
  }
 }
 /**
  * Robinhood's positions endpoint carries no price, so a captured position has
  * no mark and an allocation holding it cannot be valued. Quote the symbols
  * and fill each position's mark and market value. A quote failure leaves the
  * position unmarked rather than blocking the capture.
  */
 async function markEquityPositions(positions: Map<string, NormalizedRobinhoodPosition>, signal: AbortSignal) {
  const symbols = [...new Set([...positions.values()].filter(p => p.symbol !== null && p.markPrice === null).map(p => p.symbol as string))];
  const prices = new Map<string, string>();
  for (let start = 0; start < symbols.length; start += QUOTE_SLICE) {
   signal.throwIfAborted();
   try {
    for (const [symbol, detail] of normalizeEquityQuoteDetails(await connections.readTool('get_equity_quotes', { symbols: symbols.slice(start, start + QUOTE_SLICE) }, undefined, signal))) {
     if (detail.lastTradePrice !== undefined) prices.set(symbol, detail.lastTradePrice);
    }
   } catch { /* Unmarked positions stay unvalued; the next sync retries. */ }
  }
  for (const [key, position] of positions) {
   const price = position.symbol === null ? undefined : prices.get(position.symbol);
   if (price !== undefined) positions.set(key, { ...position, markPrice: price, marketValue: multiplyDecimals(price, position.quantity) });
  }
 }
 return {
  busy: () => Boolean(active),
  cancel() { active?.abort(); },
  async start() { await database.use(db => db.exec(`UPDATE account_sync_runs SET state='interrupted',finished_at=now(),error_code='host_restarted' WHERE state='running'`)); },
  async synchronize() {
   if (active) throw new ConnectionFailure('busy');
   const controller = new AbortController(); active = controller;
   const timeout = setTimeout(() => controller.abort(), 240_000);
   try {
    const state = await connections.status();
    const account = state.accounts.find(a => a.selected && a.agenticAllowed);
    if (state.status !== 'connected' || !account) throw new ConnectionFailure('reauth_required');
    let failed = false;
    for (const resource of syncResources) {
     controller.signal.throwIfAborted();
     try { await syncResource(account.id, resource, controller.signal); } catch { failed = true; }
    }
    if (failed) throw new ConnectionFailure('transient');
   } finally { clearTimeout(timeout); active = undefined; }
  },
  async snapshot(accountId?: string): Promise<PortfolioView> {
   if (accountId !== undefined) z.uuid().parse(accountId);
   return database.use(db=>db.transaction(async db => {
    const accounts = (await db.query<PortfolioAccount>(`SELECT a.id,c.venue,a.masked_number AS "maskedNumber",coalesce(a.nickname,a.masked_number) AS label,a.selected,a.available,a.account_type AS "accountType",a.option_level AS "optionLevel",
      (SELECT json_build_object('totalValue',p.data->>'totalValue','currency',p.data->>'currency','observedAt',obs.observed_at)
       FROM account_observations obs JOIN portfolio_snapshots p ON p.id=obs.portfolio_snapshot_id
       WHERE obs.account_id=a.id AND obs.resource='portfolio' ORDER BY obs.observed_at DESC LIMIT 1) AS balance
      FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id WHERE c.venue='robinhood' AND (a.agentic_allowed OR (NOT a.available AND EXISTS(SELECT 1 FROM account_observations saved WHERE saved.account_id=a.id))) ORDER BY a.selected DESC,a.id`)).rows;
    const account = accountId ? accounts.find(a => a.id === accountId) : accounts.find(a => a.selected) ?? accounts[0];
    if (accountId && !account) throw new Error('Unknown account');
    const view: PortfolioView = { account: account ?? null, accounts, resources: [], history: [], positionHistory: [], portfolio: null, positions: [], orders: [], executions: [], gaps: [] };
    if (!account) return view;
    for (const resource of syncResources) {
     const run = (await db.query<{state:string;error_code:string|null}>(`SELECT state,error_code FROM account_sync_runs WHERE account_id=$1 AND resource=$2 ORDER BY started_at DESC,id DESC LIMIT 1`, [account.id, resource])).rows[0];
     const checkpoint = (await db.query<{watermark:Date}>(`SELECT watermark FROM account_sync_checkpoints WHERE account_id=$1 AND resource=$2`, [account.id, resource])).rows[0];
     const observation = (await db.query<{observed_at:Date;data:unknown}>(`SELECT o.observed_at,coalesce(p.data,s.data) AS data FROM account_observations o LEFT JOIN portfolio_snapshots p ON p.id=o.portfolio_snapshot_id LEFT JOIN position_snapshots s ON s.id=o.position_snapshot_id WHERE o.account_id=$1 AND o.resource=$2 ORDER BY o.observed_at DESC LIMIT 1`, [account.id, resource])).rows[0];
     const observed = checkpoint?.watermark;
     view.resources.push({resource, observedAt: observed?.toISOString() ?? null, state: run?.state ?? 'not_synced', errorCode: run?.error_code ?? null, stale: !observed || now()-observed.getTime()>900_000} satisfies ResourceStatus);
     if (resource === 'portfolio' && observation) view.portfolio = observation.data as PortfolioView['portfolio'];
     if (resource.endsWith('_positions') && observation) view.positions.push(...(observation.data as PortfolioView['positions']).map(p => ({...p,assetClass:resource==='crypto_positions'?'crypto' as const:resource.startsWith('equity')?'equity' as const:'option' as const})));
    }
    // One observed value per hour keeps a year of local history bounded. Never
    // synthesize a pre-connection baseline or treat deposits as investment return.
    view.history = (await db.query<{observed_at:Date;total_value:string;currency:string}>(`
      WITH history AS (
        SELECT o.observed_at,p.data,1 AS priority FROM account_observations o
          JOIN portfolio_snapshots p ON p.id=o.portfolio_snapshot_id
          WHERE o.account_id=$1 AND o.resource='portfolio' AND o.observed_at >= to_timestamp($2/1000.0)
        UNION ALL SELECT observed_at,data,0 AS priority FROM portfolio_history_imports
          WHERE account_id=$1 AND observed_at >= to_timestamp($2/1000.0)
      ) SELECT DISTINCT ON (date_trunc('hour',observed_at)) observed_at,
        data->>'totalValue' AS total_value,data->>'currency' AS currency
      FROM history ORDER BY date_trunc('hour',observed_at),observed_at DESC,priority DESC`, [account.id, now()-366*DAY])).rows
      .map(r=>({observedAt:r.observed_at.toISOString(),totalValue:r.total_value,currency:r.currency}));
    view.positionHistory = (await db.query<{instrumentRef:string;assetClass:string;observedAt:string;markPrice:string;currency:string}>(`
      WITH hourly AS (
        SELECT DISTINCT ON (o.resource,date_trunc('hour',o.observed_at))
          o.observed_at,o.position_snapshot_id
        FROM account_observations o WHERE o.account_id=$1 AND o.position_snapshot_id IS NOT NULL
          AND o.observed_at >= to_timestamp($2/1000.0)
        ORDER BY o.resource,date_trunc('hour',o.observed_at),o.observed_at DESC
      ) SELECT item->>'instrumentRef' AS "instrumentRef",s.asset_class AS "assetClass",
        h.observed_at::text AS "observedAt",item->>'markPrice' AS "markPrice",item->>'currency' AS currency
      FROM hourly h JOIN position_snapshots s ON s.id=h.position_snapshot_id,
        LATERAL jsonb_array_elements(s.data) item
      WHERE item->>'markPrice' IS NOT NULL ORDER BY h.observed_at`, [account.id,now()-366*DAY])).rows;
    view.orders = (await db.query<{data:PortfolioView['orders'][number];asset_class:string}>(`SELECT data,asset_class FROM account_orders WHERE account_id=$1 ORDER BY last_seen DESC,provider_ref LIMIT 100`, [account.id])).rows.map(r => ({...r.data,assetClass:r.asset_class}));
    view.executions = (await db.query<{data:PortfolioView['executions'][number]}>(`SELECT data FROM account_executions WHERE account_id=$1 ORDER BY occurred_at DESC,provider_ref LIMIT 100`, [account.id])).rows.map(r => r.data);
    view.gaps = (await db.query<PortfolioView['gaps'][number]>(`SELECT resource,from_at::text AS "fromAt",to_at::text AS "toAt",reason FROM account_sync_gaps WHERE account_id=$1 ORDER BY to_at DESC LIMIT 20`, [account.id])).rows;
    return addStrategyHoldings(db,view);
   }));
  },
 };
}
function hasOrderEnvelope(value: unknown): boolean {
 if (Array.isArray(value)) return true;
 if (!value || typeof value !== 'object') return false;
 const r = value as Record<string,unknown>;
 if (r.isError || r.error) return false;
 if (typeof r.id === 'string' && typeof r.state === 'string') return true;
 return ['results','orders','data'].some(k => k in r && hasOrderEnvelope(r[k]));
}
