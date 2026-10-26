import {randomUUID} from 'node:crypto';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import type {OrderActivity} from '../../shared/order-activity';
import {orderNotificationTitle} from '../../shared/order-activity';
import {observedOrderState,type CancellationState} from '../../shared/trading';
import type {NotificationInput} from '../../shared/notifications';
import {strategyNameSql,withCurrentTakeName} from '../strategies/take-name';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Evidence=Omit<OrderActivity,'id'|'execution'|'observedAt'> & {state:string;cancelState:CancellationState;filledQuantity:string|null};
const projection=`a.id AS "accountId",a.connection_id AS "connectionId",coalesce(c.label,a.nickname,a.masked_number) AS "accountLabel"`;
/** Only locally placed orders carry Take attribution. Provider symbol matches never establish ownership. */
export async function orderEvidence(db:Pick<PGlite,'query'>):Promise<Evidence[]>{
 return (await db.query<Evidence>(`
 SELECT i.id AS "orderId",'robinhood' AS venue,${projection},
 al.strategy_id AS "strategyId",NULL::uuid AS "takeId",v.metadata->>'title' AS "takeTitle",
 NULL::uuid AS "reviewId",i.provider_order_ref AS "providerRef",coalesce(nullif(i.order_request->>'symbol',''),CASE WHEN i.asset_class='crypto' THEN nullif(i.review_result->>'symbol','') END,'Unknown market') AS symbol,i.order_request->>'side' AS side,
 CASE WHEN i.status='placed' THEN coalesce(f.snapshot->>'state',p.state,'accepted') ELSE i.status END AS state,'none' AS "cancelState",coalesce(f.snapshot->>'filled',p.data->>'cumulativeQuantity') AS "filledQuantity",
 i.order_request->>'quantity' AS quantity,i.order_request->>'dollar_amount' AS notional,'USD' AS currency,
 CASE WHEN f.snapshot IS NOT NULL THEN f.snapshot->>'netCash' WHEN p.data->>'cumulativeQuantity' IS NOT NULL AND p.data->>'averagePrice' IS NOT NULL THEN ((p.data->>'cumulativeQuantity')::numeric*(p.data->>'averagePrice')::numeric)::text END AS "filledNotional"
 FROM order_intents i JOIN linked_accounts a ON a.id=i.account_id
 LEFT JOIN order_fill_checkpoints f ON f.intent_id=i.id
 LEFT JOIN coinbase_connection_details c ON c.connection_id=a.connection_id
 LEFT JOIN strategy_allocations al ON al.id=i.allocation_id
 LEFT JOIN strategy_versions v ON v.id=al.applied_version_id
 LEFT JOIN account_orders p ON p.account_id=i.account_id AND p.provider='robinhood' AND p.provider_ref=i.provider_order_ref
 WHERE i.status NOT IN ('reviewed','expired','abandoned')
 UNION ALL
 SELECT o.id,'coinbase',${projection},al.strategy_id,r.take_id,coalesce(${strategyNameSql('al.strategy_id')},r.payload->>'takeTitle'),r.id,o.provider_order_ref,o.product,o.side,
 CASE WHEN o.state='closed' THEN coalesce(p.state,CASE WHEN d.state='rejected' THEN 'rejected' ELSE 'cancelled' END)
 WHEN o.state='bound' THEN coalesce(p.state,'accepted') ELSE o.state END,coalesce(d.cancel_state,'none'),p.data->>'filledQuantity',o.max_base::text,
 (SELECT x->>'notional' FROM jsonb_array_elements(r.payload->'orders') WITH ORDINALITY AS q(x,n) WHERE o.cause='review:'||r.id::text||':'||(n-1)::text),
 split_part(o.product,'-',2),
 (SELECT sum((e.data->>'notionalAmount')::numeric)::text FROM account_executions e WHERE e.account_id=o.account_id AND e.provider='coinbase' AND e.order_ref=o.provider_order_ref)
 FROM coinbase_allocation_orders o JOIN linked_accounts a ON a.id=o.account_id
 JOIN coinbase_allocations al ON al.id=o.allocation_id
 JOIN coinbase_order_reviews r ON r.account_id=o.account_id AND o.cause LIKE 'review:'||r.id::text||':%'
 LEFT JOIN coinbase_connection_details c ON c.connection_id=a.connection_id
 LEFT JOIN coinbase_order_dispatches d ON d.order_id=o.id
 LEFT JOIN account_orders p ON p.account_id=o.account_id AND p.provider='coinbase' AND p.provider_ref=o.provider_order_ref
 WHERE o.state<>'prepared' AND d.order_id IS NOT NULL
 `)).rows;
}
const reportable=new Set(['accepted','partially_filled','filled','cancelled','expired','rejected','unknown','reconciliation_required']);
/** Journal and notification commit together. Account locks serialize concurrent host/portfolio reads. */
export async function syncOrderActivity(db:Pick<PGlite,'transaction'>,now:number,recovery=false){
 await db.transaction(async tx=>{
  await tx.query('SELECT id FROM linked_accounts ORDER BY id FOR UPDATE');
  await tx.query(`UPDATE notifications n SET resolved_at=coalesce(resolved_at,$1::timestamptz) WHERE payload->'source'->>'type'='order' AND EXISTS(SELECT 1 FROM order_intents i WHERE i.id::text=n.payload->'source'->>'id' AND i.account_id::text=n.payload->'context'->>'accountId' AND i.status='abandoned')`,[new Date(now).toISOString()]);
  const rows=await orderEvidence(tx);
  for(const row of rows){
   // Repair legacy missing labels in place without replaying delivery or changing read state.
   const missing=(await tx.query<{id:string;payload:OrderActivity}>(`SELECT id,payload FROM order_activity WHERE venue=$1 AND account_id=$2 AND order_id=$3 AND (payload->>'symbol' IS NULL OR payload->>'symbol'='')`,[row.venue,row.accountId,row.orderId])).rows;
   for(const old of missing){
    const corrected={...old.payload,symbol:row.symbol};
    await tx.query('UPDATE order_activity SET payload=$2 WHERE id=$1',[old.id,JSON.stringify(corrected)]);
    await tx.query(`UPDATE notifications SET payload=jsonb_set(jsonb_set(payload,'{order}', $2::jsonb),'{title}',$3::jsonb) WHERE payload->>'kind'='order_update' AND payload->'order'->>'id'=$1`,[old.id,JSON.stringify(corrected),JSON.stringify(orderNotificationTitle(corrected).slice(0,120))]);
   }
   const state=observedOrderState(row.state,row.filledQuantity);if(!reportable.has(state))continue;
   const execution={state,cancelState:row.cancelState};
   const signature=JSON.stringify(execution);
   const previous=(await tx.query<{signature:string}>(`SELECT signature FROM order_activity WHERE venue=$1 AND account_id=$2 AND order_id=$3 ORDER BY sequence DESC LIMIT 1`,[row.venue,row.accountId,row.orderId])).rows[0];
   if(previous?.signature===signature)continue;
   const {state:_state,cancelState:_cancel,...identity}=row;
   const event:OrderActivity={...identity,id:randomUUID(),execution,observedAt:new Date(now).toISOString()};
   await tx.query('INSERT INTO order_activity(id,venue,account_id,order_id,signature,payload) VALUES($1,$2,$3,$4,$5,$6)',[event.id,event.venue,event.accountId,event.orderId,signature,JSON.stringify(event)]);
   await tx.query(`UPDATE notifications SET resolved_at=coalesce(resolved_at,$3::timestamptz) WHERE payload->'source'->>'type'='order' AND payload->'source'->>'id'=$1 AND payload->'context'->>'accountId'=$2`,[event.orderId,event.accountId,event.observedAt]);
   const requiresAction=state==='unknown'||state==='reconciliation_required'||(row.cancelState==='unknown'&&!['filled','cancelled','expired','rejected'].includes(state));
   const broker=event.venue==='coinbase'?'Coinbase':'Robinhood';
   const notice:NotificationInput={kind:'order_update',tier:requiresAction?'act_now':'know_today',requiresAction,
    context:{venue:event.venue,connectionId:event.connectionId,accountId:event.accountId},source:{type:'order',id:event.orderId},eventKey:event.id,
    occurredAt:event.observedAt,title:orderNotificationTitle(event).slice(0,120),
    body:[broker,event.accountLabel,event.takeTitle,row.cancelState!=='none'?`Cancellation ${row.cancelState}`:null].filter(Boolean).join(' · ').slice(0,240),order:event};
   await tx.query('SELECT record_local_notification($1::jsonb,$2)',[JSON.stringify(notice),recovery]);
  }
 });
}
export function createOrderActivity(database:Database,clock=Date.now){
 return {
  sync:(recovery=false)=>database.use(db=>syncOrderActivity(db,clock(),recovery)),
  async list(accountId:string):Promise<OrderActivity[]>{return database.use(async db=>(await db.query<{payload:OrderActivity}>(`SELECT ${withCurrentTakeName('payload')} AS payload FROM order_activity WHERE account_id=$1 ORDER BY sequence DESC LIMIT 100`,[accountId])).rows.map(row=>row.payload));},
 };
}
