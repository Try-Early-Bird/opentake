import { createHash } from 'node:crypto';
import type { DatabaseClient as PGlite } from './database-client';
import { readTradingQueue, type TradingQueueItem } from '../shared/trading-queue';
import type { NotificationInput } from '../shared/notifications';

/** Bind an action to the queue snapshot that generated the notice, not just its reusable ID. */
export function tradingNoticeKey(item:TradingQueueItem):string {
 return createHash('sha256').update(JSON.stringify([item.id,item.createdAt,item.state,item.title,item.detail,item.reason,item.expectedAt,item.actions,item.approval])).digest('hex');
}
export async function syncTradingNotifications(db:Pick<PGlite,'transaction'>,input:unknown,now:number,recovery=false){
 const items=readTradingQueue(input).filter(item=>item.link&&(item.state==='needs_you'||item.state==='waiting'));
 await db.transaction(async tx=>{
  const keys=items.map(tradingNoticeKey);
  await tx.query(`UPDATE notifications SET resolved_at=coalesce(resolved_at,$1::timestamptz) WHERE payload->'source'->>'type'='trading_queue' AND payload->>'eventKey'<>'rule-rebalance' AND NOT (payload->>'eventKey'=ANY($2::text[]))`,[new Date(now).toISOString(),keys]);
  // Rule reviews are owned by their worker, not the general trading queue.
  // Repair old notices that queue reconciliation incorrectly marked resolved.
  // Partial rebalances hold nothing open; their own notice text stands and may be dismissed.
  await tx.query(`UPDATE notifications n SET resolved_at=NULL,expires_at=NULL,
    payload=(n.payload-'expiresAt') || jsonb_build_object('title','Rule rebalance needs attention','body','Open this Take to inspect the unresolved Coinbase order. This is not a new approval request.','requiresAction',true)
    FROM strategy_rule_trades j WHERE n.payload->'source'->>'type'='trading_queue'
    AND n.payload->>'eventKey'='rule-rebalance' AND n.payload->'source'->>'id'=j.request_id::text
    AND j.state='attention' AND j.reason IS DISTINCT FROM 'partial_rebalance' AND (n.resolved_at IS NOT NULL OR n.expires_at IS NOT NULL OR n.payload->>'title'<>'Rule rebalance needs attention')`);
  for(const item of items){
   const requiresAction=item.state==='needs_you';
   const notice:NotificationInput={kind:requiresAction?'orders_need_confirmation':'trading_waiting',tier:requiresAction?'act_now':'know_today',requiresAction,
    eventKey:tradingNoticeKey(item),context:{strategyId:item.link!.id},source:{type:'trading_queue',id:item.id},occurredAt:new Date(now).toISOString(),
    title:item.title.slice(0,120),body:(item.detail??(requiresAction?'Review this strategy to continue.':'Waiting to run.')).slice(0,240),
    trading:{queueItemId:item.id,actions:item.actions,summary:item.approval?.summary??item.detail??item.title,strategyName:item.approval?.strategyName??item.title},
   };
   await tx.query('SELECT record_local_notification($1::jsonb,$2)',[JSON.stringify(notice),recovery]);
  }
 });
}
