import {reconcileDispatches} from './dispatch-state';
import { createCoinbaseAllocations } from './allocations';
import { coinbaseFillMovements } from './currency-accounting';
import type { createDatabaseLifecycle } from '../database';
import type { CoinbaseChatScope } from '../../shared/platform-connections';
import type { ActivityRequest, ActivityPage, CoinbaseOrder, CoinbaseFill } from './activity';
import { coinbaseError } from './errors';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
type Read = (scope:CoinbaseChatScope,request:ActivityRequest)=>Promise<ActivityPage>;
const resources=['spot_orders','spot_fills'] as const;
type Resource=typeof resources[number];
interface Checkpoint {cursor:string|null;window_start:Date|null;window_end:Date|null;completed_at:Date|null;seen_cursors:string[]}
const comparable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
/** Uses the same account-scoped immutable execution store as Robinhood. No attribution is inferred here. */
export function createCoinbaseActivitySync(database:Database,read:Read,assertScope:(scope:CoinbaseChatScope)=>Promise<unknown>,now=()=>Date.now()) {
  async function persist(scope:CoinbaseChatScope,orders:CoinbaseOrder[],fills:CoinbaseFill[],checkpoint?:{resource:Resource;cursor:string|null;seen:string[]}) {
    await assertScope(scope);
    await database.use(db=>db.transaction(async tx=>{
      for(const order of orders) {
        const old=(await tx.query<{data:CoinbaseOrder}>("SELECT data FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND provider_ref=$2",[scope.accountRef,order.providerOrderRef])).rows[0]?.data;
        if(old&&(old.productId!==order.productId||old.side!==order.side||old.sourceCreatedAt!==order.sourceCreatedAt))throw new Error('Changed order identity');
        await tx.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen)
          VALUES($1,'coinbase',$2,'crypto',$3,$4,$5,$6,$6) ON CONFLICT(account_id,provider,provider_ref)
          DO UPDATE SET state=excluded.state,terminal=excluded.terminal,data=excluded.data,last_seen=excluded.last_seen`,
          [scope.accountRef,order.providerOrderRef,order.state,order.terminal,JSON.stringify(order),new Date(now()).toISOString()]);
      }
      for(const fill of fills) {
        const order=(await tx.query<{data:CoinbaseOrder}>("SELECT data FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND provider_ref=$2",[scope.accountRef,fill.orderRef])).rows[0]?.data;
        if(!order||order.productId!==fill.productId||order.side!==fill.side)throw new Error('Missing or inconsistent order evidence');
        const old=(await tx.query<{data:CoinbaseFill}>("SELECT data FROM account_executions WHERE account_id=$1 AND provider='coinbase' AND provider_ref=$2",[scope.accountRef,fill.providerExecutionRef])).rows[0]?.data;
        if(old&&comparable(old)!==comparable(fill))throw new Error('Changed execution evidence');
        // Deferred until the multi-currency allocation reconciler supports this venue.
        await tx.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at,attribution_state)
          VALUES($1,'coinbase',$2,$3,'crypto',$4,$5,'deferred') ON CONFLICT DO NOTHING`,[scope.accountRef,fill.providerExecutionRef,fill.orderRef,JSON.stringify(fill),fill.occurredAt]);
        for(const movement of coinbaseFillMovements(fill))await tx.query(`INSERT INTO coinbase_execution_movements(account_id,execution_ref,kind,asset,quantity,exact)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[scope.accountRef,fill.providerExecutionRef,movement.kind,movement.asset,movement.quantity,movement.exact]);
      }
      if(checkpoint)await tx.query(`UPDATE coinbase_activity_sync SET cursor=$3,seen_cursors=$4,state='partial',error_code=NULL WHERE account_id=$1 AND resource=$2`,[scope.accountRef,checkpoint.resource,checkpoint.cursor,JSON.stringify(checkpoint.seen)]);
    }));
  }
  async function sync(scope:CoinbaseChatScope,resource:Resource) {
    const saved=(await database.use(db=>db.query<Checkpoint>('SELECT * FROM coinbase_activity_sync WHERE account_id=$1 AND resource=$2',[scope.accountRef,resource]))).rows[0];
    const until=(saved?.window_end??new Date(now())).toISOString();
    let since=saved?.window_end?saved.window_start?.toISOString():saved?.completed_at?new Date(saved.completed_at.getTime()-7*86400000).toISOString():undefined;
    if(!saved?.window_end&&since){
      const pending=(await database.use(db=>db.query<{started_at:Date}>(`SELECT min(d.started_at) AS started_at FROM coinbase_order_dispatches d JOIN coinbase_allocation_orders o ON o.id=d.order_id WHERE o.account_id=$1 AND o.state IN ('submitting','unknown','bound','reconciliation_required')`,[scope.accountRef]))).rows[0]?.started_at;
      if(pending&&pending.getTime()<Date.parse(since))since=new Date(pending.getTime()-60000).toISOString();
    }
    let cursor=saved?.cursor??null;
    const seen=new Set(saved?.window_end?saved.seen_cursors:[]);
    await database.use(db=>db.query(`INSERT INTO coinbase_activity_sync(account_id,resource,state,attempted_at,window_start,window_end)
      VALUES($1,$2,'running',$3,$4,$5) ON CONFLICT(account_id,resource) DO UPDATE SET state='running',attempted_at=excluded.attempted_at,error_code=NULL,window_start=excluded.window_start,window_end=excluded.window_end`,
      [scope.accountRef,resource,new Date(now()).toISOString(),since??null,until]));
    try {
      for(let pageIndex=0;pageIndex<8;pageIndex++) {
        const page=await read(scope,{resource,until,...(since?{since}:{}),...(cursor?{cursor}:{})});
        if(page.cursor&&(page.cursor===cursor||seen.has(page.cursor)))throw new Error('Repeated provider cursor');
        const orders=[...page.orders];
        for(const id of new Set(page.fills.map(fill=>fill.orderRef))) {
          const known=(await database.use(db=>db.query("SELECT 1 FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND provider_ref=$2",[scope.accountRef,id]))).rows.length;
          if(!known)orders.push(...(await read(scope,{resource:'order',orderId:id})).orders);
        }
        if(page.cursor)seen.add(page.cursor);
        await persist(scope,orders,page.fills,{resource,cursor:page.cursor,seen:[...seen]});
        cursor=page.cursor;
        if(cursor)continue;
        if(resource==='spot_orders') {
          // Creation-time lookback cannot discover a fill/cancel on an older open order.
          const open=(await database.use(db=>db.query<{provider_ref:string}>("SELECT provider_ref FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND NOT terminal UNION SELECT provider_order_ref AS provider_ref FROM coinbase_allocation_orders WHERE account_id=$1 AND provider_order_ref IS NOT NULL AND state IN ('bound','unknown','reconciliation_required') LIMIT 101",[scope.accountRef]))).rows;
          if(open.length>100)throw new Error('Open order limit');
          for(const item of open)await persist(scope,(await read(scope,{resource:'order',orderId:item.provider_ref})).orders,[]);
        }
        await assertScope(scope);
        await database.use(db=>db.query(`UPDATE coinbase_activity_sync SET state='completed',completed_at=$3,cursor=NULL,window_start=NULL,window_end=NULL,seen_cursors='[]',error_code=NULL WHERE account_id=$1 AND resource=$2`,[scope.accountRef,resource,until]));
        return;
      }
    } catch(error) {
      // Retain evidence, but restart this bounded window if a cursor expires or evidence is rejected.
      await database.use(db=>db.query("UPDATE coinbase_activity_sync SET state='failed',error_code=$3,cursor=NULL,seen_cursors='[]' WHERE account_id=$1 AND resource=$2",[scope.accountRef,resource,coinbaseError(error).code]));
    }
  }
  return {async refresh(scope:CoinbaseChatScope,selected:readonly Resource[]=resources) {
    for(const resource of selected)await sync(scope,resource);
    await assertScope(scope);
    await database.use(db=>db.transaction(async tx=>{
      const missing=(await tx.query<{provider_ref:string;data:CoinbaseFill}>(`SELECT e.provider_ref,e.data FROM account_executions e
        WHERE e.account_id=$1 AND e.provider='coinbase' AND NOT EXISTS(SELECT 1 FROM coinbase_execution_movements m WHERE m.account_id=e.account_id AND m.execution_ref=e.provider_ref)
        ORDER BY e.occurred_at LIMIT 500`,[scope.accountRef])).rows;
      for(const fill of missing)for(const movement of coinbaseFillMovements(fill.data))await tx.query(`INSERT INTO coinbase_execution_movements(account_id,execution_ref,kind,asset,quantity,exact)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[scope.accountRef,fill.provider_ref,movement.kind,movement.asset,movement.quantity,movement.exact]);
    }));
    await assertScope(scope);
    await createCoinbaseAllocations(database,now).reconcile(scope.accountRef);
    await reconcileDispatches(database,scope.accountRef,now);

  }};
}
