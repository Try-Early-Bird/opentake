import { approvalCopy } from '../shared/tool-approval-copy';
import { backgroundDatabaseWork } from './database-client';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import type { DatabaseClient as PGlite } from './database-client';
import {syncActionNotifications} from './action-notifications';
import {observedOrderState} from '../shared/trading';
import {syncCoinbaseLifecycleNotifications} from './coinbase/lifecycle-notifications';
import {syncCoinbaseHealthNotifications} from './coinbase/sync-notifications';
import {syncCapitalNotifications} from './trading/capital-notifications';
import {syncOrderActivity,orderEvidence} from './trading/activity';
import { readTradingQueue } from '../shared/trading-queue';
import { syncTradingNotifications, tradingNoticeKey } from './trading-notifications';
import { syncTakeEventNotifications, type DividendYields } from './take-event-notifications';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { createDatabaseLifecycle } from './database';
import type { NotificationInput, NotificationItem, NotificationKey, NotificationNavigation, NotificationPage, NotificationTarget } from '../shared/notifications';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
async function describeApprovals(db: Pick<PGlite, 'query'>, rows: { payload: NotificationInput }[]) {
  for (const row of rows) {
    const p = row.payload;
    if (p.kind !== 'run_approval_needed' || !('takeId' in p.context)) continue;
    const approvalTable = p.source.type === 'tool_approval' ? 'tool_approvals' : p.source.type === 'platform_approval' ? 'platform_access_requests' : null;
    if (!approvalTable) continue;
    const toolApproval = approvalTable === 'tool_approvals';
    const detail = (await db.query<{ title: string; provider: string | null; tool: string | null; serverId: string | null; server: string | null; sharing: boolean | null; mode: string | null }>(`
      SELECT t.title, ${toolApproval ? 'NULL::text AS provider, a.tool_name AS tool, a.server_id::text AS "serverId", a.server_name AS server, a.platform_sharing AS sharing' : 'a.provider, NULL::text AS tool, NULL::text AS "serverId", NULL::text AS server, false AS sharing'},
        r.configuration->>'permissionMode' AS mode
      FROM ${approvalTable} a JOIN take_runs r ON r.id=a.run_id JOIN takes t ON t.id=r.take_id
      WHERE a.id=$1::uuid AND t.id=$2::uuid`, [p.source.id, p.context.takeId])).rows[0];
    if (!detail) continue;
    const clean = (value: string) => value.replace(/[\r\n\t]/g, ' ').slice(0, 160);
    const title = `${clean(detail.title) || 'Untitled Take'} needs your approval`;
    const provider = ({ claude: 'Claude', codex: 'Codex', grok: 'Grok', openrouter: 'OpenRouter' } as Record<string, string>)[detail.provider ?? ''] ?? 'the AI provider';
    // The approval panel's wording, without the call's arguments: notifications never copy them.
    const copy = approvalCopy({ tool_name: detail.tool ?? 'tool_request', server_id: detail.serverId ?? '', server_name: detail.server ? clean(detail.server) : null });
    const body = p.source.type === 'platform_approval'
      ? `Allow ${provider} to use account data in this Take. Balances, positions and earlier account context may be shared. This permission is separate from Auto tool mode.`
      : [copy.title, copy.description, detail.sharing ? 'This external tool may receive account context from the Take.' : detail.mode === 'ask' ? 'This Take is set to Ask before tool calls.' : ''].filter(Boolean).join(' ');
    row.payload = { ...p, title, body };
  }
}
export interface NativeAlert { title: string; body: string; click(): void; failed(): void }
interface Options {
  deliver(alert: NativeAlert): void;
  openDesktop(): void;
  badge(count: number): void;
  now?: () => number;
  trading?:{list():Promise<unknown>;act(id:string,action:'confirm'|'cancel'):Promise<unknown>};
  /** Tells a probable reinvested dividend from unexplained shares; without it every increase reads as unexplained. */
  dividendYields?: DividendYields;
}
const sequence = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => BigInt(v) <= 9223372036854775807n);
const uuid = z.string().uuid();
const inputSchema = z.object({
  kind: z.enum(['rule_notification','action_update','capital_update', 'order_update', 'connection_attention', 'run_approval_needed', 'orders_need_confirmation', 'trading_waiting', 'strategy_archived', 'close_failed', 'cash_shortfall', 'outside_sale', 'take_overspent', 'order_unknown', 'holding_not_bought', 'symbol_delisted', 'missing_evidence', 'account_data_stale', 'shares_appeared']),
  tier: z.enum(['act_now', 'know_today', 'digest']), requiresAction: z.boolean(),
  eventKey: z.string().min(1).max(200),
  context: z.union([z.object({ venue: z.string().min(1).max(80), connectionId: uuid, accountId: uuid.optional() }).strict(), z.object({ takeId: uuid }).strict(), z.object({strategyId:uuid}).strict()]),
  source: z.union([z.object({ type: z.enum(['connection', 'tool_approval', 'platform_approval']), id: uuid }).strict(),z.object({type:z.enum(['rule','action','trading_queue','take_event','order']),id:z.string().min(1).max(200)}).strict()]),
  occurredAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }).optional(),
  title: z.string().min(1).max(120), body: z.string().max(240),
  action:z.object({
    updatedAt:z.string().datetime({offset:true}).optional(),id:z.string(),kind:z.enum(['investment','deposit','withdrawal','close','rebalance']),state:z.enum(['pending','waiting','attention','completed','cancelled']),title:z.string(),takeTitle:z.string(),filled:z.number().int().nonnegative(),total:z.number().int().nonnegative(),
    orders:z.array(z.object({id:z.string(),symbol:z.string(),side:z.string(),state:z.string(),amount:z.string().nullable(),currency:z.string(),venue:z.string(),account:z.string()}).strict()),
    accounts:z.array(z.object({venue:z.string(),label:z.string(),state:z.string(),message:z.string().nullable(),returned:z.array(z.object({currency:z.string(),amount:z.string()}).strict())}).strict()),
  }).strict().optional(),
  account:z.object({venue:z.enum(['coinbase','robinhood']),label:z.string(),takeTitle:z.string().optional()}).optional(),
  order:z.object({quantity:z.string().nullable().optional(),notional:z.string().nullable().optional(),currency:z.string().nullable().optional(),filledQuantity:z.string().nullable().optional(),filledNotional:z.string().nullable().optional(),id:uuid,orderId:uuid,venue:z.enum(['coinbase','robinhood']),accountId:uuid,accountLabel:z.string(),connectionId:uuid,strategyId:uuid.nullable(),takeId:uuid.nullable(),takeTitle:z.string().nullable(),reviewId:uuid.nullable(),providerRef:z.string().nullable(),symbol:z.string(),side:z.string(),observedAt:z.string().datetime({offset:true}),execution:z.object({state:z.enum(['reviewed','reserved','submitting','accepted','partially_filled','filled','cancelled','expired','rejected','unknown','reconciliation_required']),cancelState:z.enum(['none','sending','requested','unknown','rejected'])}).strict()}).strict().optional(),
  trading:z.object({queueItemId:z.string().max(200),actions:z.array(z.enum(['confirm','cancel'])),summary:z.string(),strategyName:z.string()}).optional(),
  takeEvent:z.object({venue:z.enum(['coinbase','robinhood']).optional(),event:z.enum(['strategy_archived','close_failed','cash_shortfall','outside_sale','take_overspent','order_unknown','holding_not_bought','symbol_delisted','missing_evidence']),allocationId:uuid,strategyName:z.string(),symbol:z.string().nullable(),detail:z.string().nullable()}).strict().optional(),
}).strict();
interface Row { id: string; sequence: string; payload: NotificationInput; seen: boolean; resolvedAt: string | null }
const sortTime = `CASE WHEN payload->>'kind'='action_update' THEN coalesce(payload->'action'->>'updatedAt',payload->>'occurredAt')::timestamptz ELSE created_at END`;
const columns = `id,sequence::text,payload,seen,resolved_at::text AS "resolvedAt"`;
const keyOf = (p: NotificationKey): NotificationKey => ({ kind: p.kind, context: p.context, source: p.source, eventKey: p.eventKey });

/** The service owns delivery; source transactions own the truth of a decision. */
export function createNotifications(database: Database, options: Options) {
  const now = options.now ?? Date.now;
  const presence = new Map<string, number>();
  let ticking: Promise<void> | undefined;
  let stopped = false;
  const at = () => new Date(now()).toISOString();
  let nextTradingSync=0;let tradingSync:Promise<void>|undefined;
  async function syncTrading(force=false,recovery=false){
    if(!options.trading)return;
    if(tradingSync){await tradingSync;if(!force)return;}
    if(!force&&now()<nextTradingSync)return;
    tradingSync=(async()=>{const items=await options.trading!.list();await database.use(db=>syncTradingNotifications(db,items,now(),recovery));nextTradingSync=now()+5000;})();
    try{await tradingSync;}finally{tradingSync=undefined;}
  }

  async function target(input: unknown): Promise<NotificationTarget> {
    const id = uuid.parse(input);
    return database.use(async db => {
      const row = (await db.query<Row>(`SELECT ${columns} FROM notifications WHERE id=$1 AND NOT pruned`, [id])).rows[0];
      if(row?.payload.order){
        const event=row.payload.order;
        const latest=(await db.query<{payload:import('../shared/order-activity').OrderActivity}>('SELECT payload FROM order_activity WHERE venue=$1 AND account_id=$2 AND order_id=$3 ORDER BY sequence DESC LIMIT 1',[event.venue,event.accountId,event.orderId])).rows[0];
        return {type:'order',order:latest?.payload??event};
      }
      if(row&&'strategyId' in row.payload.context){
        const id=row.payload.context.strategyId;const exists=(await db.query('SELECT id FROM strategies WHERE id=$1',[id])).rows.length;
        return exists?{type:'strategy',strategyId:id}:{type:'attention'};
      }
      if (!row || row.resolvedAt || (row.payload.expiresAt && Date.parse(row.payload.expiresAt) <= now())) return { type: 'attention' };
      const context = row.payload.context;
      if ('takeId' in context) {
        const exists = (await db.query('SELECT id FROM takes WHERE id=$1 AND archived_at IS NULL', [context.takeId])).rows.length;
        return exists ? { type: 'take', takeId: context.takeId } : { type: 'attention' };
      }
      if(!('venue' in context))return {type:'attention'};
      const exists = (await db.query('SELECT id FROM platform_connections WHERE id=$1 AND venue=$2', [context.connectionId, context.venue])).rows.length;
      return exists ? { type: 'connection', connectionId: context.connectionId, venue: context.venue } : { type: 'attention' };
    });
  }
  async function navigate(id?: string) {
    const destination: NotificationTarget = id ? await target(id) : { type: 'attention' };
    await database.use(db => db.query('UPDATE notification_delivery SET navigation=$1', [JSON.stringify({ id: randomUUID(), target: destination })]));
    options.openDesktop();
  }
  // Take events are derived from the database, so they reconcile on the same cadence as the queue.
  let nextTakeEventSync=0;
  let takeEventWork: Promise<void> | undefined;
  function syncTakeEvents(recovery=false): Promise<void> {
    if (takeEventWork) return takeEventWork;
    if (!recovery && now()<nextTakeEventSync) return Promise.resolve();
    const started=now();
    takeEventWork=(async()=>{
      // Yield outside transactions so IPC and foreground reads can make progress.
      const stages=[
        () => database.use(db=>syncOrderActivity(db,now(),recovery)),
        () => database.use(db=>syncCapitalNotifications(db,recovery)),
        () => database.use(db=>syncCoinbaseHealthNotifications(db,now(),recovery)),
        () => database.use(db=>syncCoinbaseLifecycleNotifications(db,now(),recovery)),
        () => database.use(db=>syncTakeEventNotifications(db,now(),recovery,options.dividendYields)),
        () => database.use(db=>syncActionNotifications(db,now(),recovery)),
      ];
      for (const stage of stages) { await yieldToHost(); await backgroundDatabaseWork(stage); }
    })().finally(()=>{
      // Slow or failed passes must leave breathing room rather than catch up.
      const duration=Math.max(0,now()-started);
      nextTakeEventSync=now()+Math.max(5000,Math.min(60000,duration*4));
      takeEventWork=undefined;
    });
    return takeEventWork;
  }
  async function cycle() {
    await syncTrading().catch(()=>{});
    await syncTakeEvents().catch(()=>{});
    const timestamp = at();
    const focused = [...presence.values()].some(expiry => expiry > now());
    const batch = await database.use(db => db.transaction(async tx => {
      // Run state and expiry can invalidate an approval without the UI polling it.
      await tx.query(`UPDATE notifications n SET resolved_at=$1 WHERE resolved_at IS NULL AND (
        expires_at <= $1::timestamptz OR
        (payload->'source'->>'type'='tool_approval' AND NOT EXISTS (
          SELECT 1 FROM tool_approvals a JOIN take_runs r ON r.id=a.run_id
          WHERE a.id::text=n.payload->'source'->>'id' AND a.state='pending' AND r.state IN ('starting','running'))) OR
        (payload->'source'->>'type'='platform_approval' AND NOT EXISTS (
          SELECT 1 FROM platform_access_requests a JOIN take_runs r ON r.id=a.run_id
          WHERE a.id::text=n.payload->'source'->>'id' AND a.state='pending' AND r.state IN ('starting','running'))))`, [timestamp]);
      await tx.query(`UPDATE notifications SET delivery='suppressed' WHERE delivery='pending' AND
        (resolved_at IS NOT NULL OR payload->>'tier'='digest' OR (origin='recovery' AND NOT (payload->>'requiresAction')::boolean))`);
      // Preserve identity tombstones so reconciliation cannot resurrect pruned events.
      await tx.query(`UPDATE notifications SET pruned=true,delivery=CASE WHEN delivery='pending' THEN 'suppressed' ELSE delivery END,payload=payload || '{"title":"","body":""}'::jsonb
        WHERE NOT pruned AND created_at < $1::timestamptz - interval '30 days'
        AND (resolved_at IS NOT NULL OR NOT (payload->>'requiresAction')::boolean)`, [timestamp]);
      const pending = (await tx.query<Row & { origin: string }>(`SELECT ${columns},origin FROM notifications WHERE delivery='pending' AND NOT pruned ORDER BY notifications.sequence`)).rows;
      await describeApprovals(tx, pending);
      const state = (await tx.query<{ throttle: string; recovery: string; urgent: boolean; recoverySent: boolean }>(`SELECT throttle_until::text AS throttle,recovery_until::text AS recovery,urgent_used AS urgent,recovery_sent AS "recoverySent" FROM notification_delivery`)).rows[0];
      const recoveryWaiting = Date.parse(state.recovery) > now();
      if (state.recoverySent) await tx.query("UPDATE notifications SET delivery='suppressed' WHERE delivery='pending' AND origin='recovery'");
      const candidates = pending.filter(row => row.origin === 'live' || (!recoveryWaiting && !state.recoverySent));
      if (!recoveryWaiting) await tx.query('UPDATE notification_delivery SET recovery_sent=true');
      const counts = (await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM notifications WHERE NOT pruned AND NOT seen`)).rows[0].count;
      if (!candidates.length) return { count: counts, rows: [] as Row[] };
      const throttle = Date.parse(state.throttle);
      const urgent = candidates.find(row => row.origin === 'live' && row.payload.kind === 'run_approval_needed' && row.payload.tier === 'act_now' && row.payload.expiresAt && Date.parse(row.payload.expiresAt) < throttle);
      const allowed = !focused && (!(throttle > now()) || (!state.urgent && urgent));
      const delivered = allowed ? (throttle > now() ? [urgent!] : candidates) : [];
      const ids = candidates.map(row => row.id);
      await tx.query(`UPDATE notifications SET delivery='suppressed' WHERE id=ANY($1::uuid[])`, [ids]);
      if (delivered.length) {
        // Persist before calling the OS. A crash can lose a banner, never replay it.
        await tx.query(`UPDATE notifications SET delivery='attempted' WHERE id=ANY($1::uuid[])`, [delivered.map(row => row.id)]);
        if (throttle > now()) await tx.query('UPDATE notification_delivery SET urgent_used=true');
        else await tx.query(`UPDATE notification_delivery SET throttle_until=$1::timestamptz + interval '60 seconds',urgent_used=false`, [timestamp]);
      }
      return { count: counts, rows: delivered, recovery: delivered.some(row => row.origin === 'recovery') };
    }));
    options.badge(batch.count);
    if (!batch.rows.length || stopped) return;
    const rows = batch.rows;
    const summary = rows.length > 1 || batch.recovery;
    const remaining = rows[0].payload.expiresAt ? Math.max(0, Math.ceil((Date.parse(rows[0].payload.expiresAt) - now()) / 1000)) : undefined;
    const failed = () => { void database.use(db => db.query(`UPDATE notifications SET delivery='failed' WHERE id=ANY($1::uuid[]) AND delivery='attempted'`, [rows.map(row => row.id)])).catch(() => {}); };
    try {
      options.deliver({
        title: summary ? `${rows.length} ${rows.length === 1 ? 'item needs' : 'items need'} your attention` : rows[0].payload.title,
        body: summary ? (batch.recovery ? 'After reconnecting. Open notifications to review current items.' : 'Open notifications to review current items.')
          : `${rows[0].payload.body}${remaining === undefined ? '' : ` Expires in ${remaining}s.`}`,
        click: () => { void navigate(summary ? undefined : rows[0].id).catch(() => {}); }, failed,
      });
    } catch { failed(); }
  }
  return {
    async act(input:unknown,requestedAction:unknown){
      const id=uuid.parse(input),action=z.enum(['confirm','cancel']).parse(requestedAction);
      if(!options.trading)throw new Error('Trading actions are unavailable.');
      await syncTrading(true);
      const row=await database.use(async db=>(await db.query<Row>(`SELECT ${columns} FROM notifications WHERE id=$1 AND NOT pruned`,[id])).rows[0]);
      if(!row||row.resolvedAt||!row.payload.trading?.actions.includes(action))throw new Error('This trading item changed. Review its current status.');
      const current=readTradingQueue(await options.trading.list()).find(item=>item.id===row.payload.trading!.queueItemId);
      if(!current||tradingNoticeKey(current)!==row.payload.eventKey||!current.actions.includes(action))throw new Error('This trading item changed. Review its current status.');
      const updated=await options.trading.act(current.id,action);
      await database.use(db=>syncTradingNotifications(db,updated,now()));
    },
    async record(input: NotificationInput, origin: 'live' | 'recovery' = 'live') {
      const p = inputSchema.parse(input);
      return database.use(async db => {
        await db.query('SELECT record_local_notification($1::jsonb,$2)', [JSON.stringify(p), origin === 'recovery']);
        return (await db.query<{ id: string }>('SELECT id FROM notifications WHERE identity=$1::jsonb', [JSON.stringify(keyOf(p))])).rows[0];
      });
    },
    async resolve(key: NotificationKey) {
      await database.use(db => db.query('UPDATE notifications SET resolved_at=coalesce(resolved_at,$2) WHERE identity=$1::jsonb', [JSON.stringify(keyOf(key)), at()]));
    },
    async recover() {
      await syncTrading(true,true).catch(()=>{});
      await syncTakeEvents(true).catch(()=>{});
      await database.use(db => db.transaction(async tx => {
        await tx.query(`UPDATE notifications SET origin='recovery' WHERE delivery='pending'`);
        // Repeated wake signals must not keep pushing the same recovery window out.
        await tx.query(`UPDATE notification_delivery SET recovery_until=$1::timestamptz + interval '10 seconds',recovery_sent=false WHERE recovery_until <= $1::timestamptz AND throttle_until <= $1::timestamptz`, [at()]);
      }));
    },
    presence(client: string, focused: boolean) {
      if (focused) presence.set(client, now() + 6000); else presence.delete(client);
      for (const [id, expiry] of presence) if (expiry <= now()) presence.delete(id);
    },
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (!ticking) ticking = cycle().finally(() => { ticking = undefined; });
      return ticking;
    },
    async stop() { stopped = true; await ticking?.catch(() => {}); },
    async list(cursor?: unknown): Promise<NotificationPage> {
      const before = cursor == null ? null : sequence.parse(cursor);
      return database.use(db => db.transaction(async tx => {
        const rows = (await tx.query<Row>(`SELECT ${columns} FROM notifications WHERE NOT pruned AND ($1::bigint IS NULL OR (${sortTime},sequence)<(SELECT ${sortTime},sequence FROM notifications WHERE sequence=$1::bigint)) ORDER BY ${sortTime} DESC,notifications.sequence DESC LIMIT 51`, [before])).rows;
        await describeApprovals(tx, rows);
        const counts = (await tx.query<{ throughSequence: string; unreadCount: number; actionRequiredCount: number }>(`SELECT
          coalesce(max(sequence),0)::text AS "throughSequence",
          count(*) FILTER(WHERE NOT seen AND NOT pruned)::int AS "unreadCount",
          count(*) FILTER(WHERE NOT pruned AND resolved_at IS NULL AND (expires_at IS NULL OR expires_at>$1) AND (payload->>'requiresAction')::boolean)::int AS "actionRequiredCount" FROM notifications`, [at()])).rows[0];
        // Resolve account labels from exact notification references, never all accounts in a Take.
        for(const row of rows){
          const p=row.payload;if(p.account||p.order)continue;
          const allocationId=p.takeEvent?.allocationId??(p.trading?.queueItemId.match(/^strategy:(?:instruction|orders):([0-9a-f-]{36}):/i)?.[1]);
          const accountId='accountId' in p.context?p.context.accountId:undefined;
          if(!allocationId&&!accountId)continue;
          const account=(await tx.query<{venue:'coinbase'|'robinhood';label:string}>(`SELECT pc.venue,coalesce(c.label,a.nickname,a.masked_number) AS label
            FROM linked_accounts a JOIN platform_connections pc ON pc.id=a.connection_id LEFT JOIN coinbase_connection_details c ON c.connection_id=pc.id
            WHERE pc.venue IN ('coinbase','robinhood') AND (a.id::text=$1 OR a.id IN (
              SELECT account_id FROM strategy_allocations WHERE id::text=$2 UNION ALL SELECT account_id FROM coinbase_allocations WHERE id::text=$2)) LIMIT 1`,[accountId??null,allocationId??null])).rows[0];
          if(account)row.payload={...p,account};
        }
        // Enrich older receipts only when their observed state still matches the order.
        // Never attach later fills to an earlier open-order notification.
        const evidence=rows.some(r=>r.payload.order)?await orderEvidence(tx):[];
        for(const row of rows){const order=row.payload.order;if(!order)continue;
          const latest=evidence.find(e=>e.orderId===order.orderId&&e.accountId===order.accountId);
          if(latest&&order.execution.state!=='partially_filled'&&observedOrderState(latest.state,latest.filledQuantity)===order.execution.state)
            row.payload={...row.payload,order:{...order,quantity:order.quantity??latest.quantity,notional:order.notional??latest.notional,currency:order.currency??latest.currency,filledQuantity:order.filledQuantity??latest.filledQuantity,filledNotional:order.filledNotional??latest.filledNotional}};
        }
        return { ...counts, items: rows.slice(0, 50).map(({ payload, ...row }) => ({ ...payload, ...row })), nextCursor: rows.length > 50 ? rows[49].sequence : null };
      }));
    },
    async markSeen(value: unknown) {
      const count=await database.use(db=>db.transaction(async tx=>{
        await tx.query('UPDATE notifications SET seen=true WHERE sequence <= $1::bigint',[sequence.parse(value)]);
        return (await tx.query<{count:number}>('SELECT count(*)::int AS count FROM notifications WHERE NOT pruned AND NOT seen')).rows[0].count;
      }));
      options.badge(count);
    },
    target,
    async navigation(): Promise<NotificationNavigation | null> {
      return database.use(async db => (await db.query<{ navigation: NotificationNavigation | null }>('SELECT navigation FROM notification_delivery')).rows[0].navigation);
    },
    async acknowledge(value: unknown) {
      await database.use(db => db.query(`UPDATE notification_delivery SET navigation=NULL WHERE navigation->>'id'=$1`, [uuid.parse(value)]));
    },
  };
}
