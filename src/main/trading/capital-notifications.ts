import type { DatabaseClient as PGlite } from '../database-client';
import type {NotificationInput} from '../../shared/notifications';
/** Receipts come from posted cash entries, never preview amounts or cancellation refunds. */
export async function syncCapitalNotifications(db:Pick<PGlite,'transaction'>,recovery=false){
 await db.transaction(async tx=>{
  const rows=(await tx.query<{id:string;strategyId:string;title:string;account:string;direction:string;amount:string;currency:string;at:Date;venue:string}>(`
   SELECT t.id::text||':'||e.entry_type AS id,a.strategy_id AS "strategyId",v.metadata->>'title' AS title,
    coalesce(ac.nickname,ac.masked_number) AS account,CASE WHEN e.entry_type='capital_allocated' THEN 'deposit' ELSE 'withdrawal' END AS direction,
    abs(sum(e.cash_delta))::text AS amount,'USD' AS currency,max(e.occurred_at) AS at,'Robinhood' AS venue
   FROM strategy_attribution_entries e JOIN strategy_allocation_transactions t ON t.id=e.transaction_id
   JOIN strategy_allocations a ON a.id=e.allocation_id JOIN linked_accounts ac ON ac.id=a.account_id
   JOIN strategy_versions v ON v.id=a.applied_version_id
   WHERE e.entry_type IN ('capital_allocated','capital_released') AND t.outcome IS NULL
    AND t.kind IN ('investment','contribution','redemption','exit','cash_release')
    AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries r WHERE r.reversal_of=e.id)
    AND (e.entry_type='capital_released' OR EXISTS(SELECT 1 FROM strategy_executions l WHERE l.transaction_id=t.id AND l.status='filled'))
    AND NOT EXISTS(SELECT 1 FROM strategy_executions l WHERE l.transaction_id=t.id AND l.status NOT IN ('filled','cancelled'))
   GROUP BY t.id,e.entry_type,a.strategy_id,v.metadata,ac.nickname,ac.masked_number HAVING sum(e.cash_delta)<>0
   UNION ALL
   SELECT e.id::text,a.strategy_id,t.title,coalesce(c.label,ac.nickname,ac.masked_number),
    CASE WHEN e.kind='capital' THEN 'deposit' ELSE 'withdrawal' END,abs(e.quantity)::text,e.asset,e.occurred_at,'Coinbase'
   FROM coinbase_allocation_entries e JOIN coinbase_allocations a ON a.id=e.allocation_id
   JOIN takes t ON t.strategy_id=a.strategy_id JOIN linked_accounts ac ON ac.id=a.account_id
   LEFT JOIN coinbase_connection_details c ON c.connection_id=ac.connection_id
   WHERE e.quantity<>0 AND e.asset IN ('USD','USDC') AND (
    (e.kind='release' AND e.cause LIKE 'withdrawal-return:%') OR
    (e.kind='capital' AND EXISTS(SELECT 1 FROM coinbase_investments i JOIN coinbase_order_reviews r ON r.id=i.order_review_id
      WHERE e.cause='capital:member:'||i.capital_review_id::text AND i.state='dispatched' AND r.state='settled'
       AND NOT EXISTS(SELECT 1 FROM coinbase_allocation_entries refund WHERE refund.cause='investment-return:'||i.id::text||':'||i.capital_review_id::text)
       AND EXISTS(SELECT 1 FROM coinbase_allocation_entries f JOIN coinbase_allocation_orders o ON o.id=f.order_id
        WHERE o.cause LIKE 'review:'||r.id::text||':%' AND f.kind='fill'))))
  `)).rows;
  for(const row of rows){
   const amount=`$${Number(row.amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
   const payload:NotificationInput={account:{venue:row.venue==='Coinbase'?'coinbase':'robinhood',label:row.account,takeTitle:row.title},kind:'capital_update',context:{strategyId:row.strategyId},source:{type:'take_event',id:row.id},eventKey:'cash-receipt',tier:'know_today',requiresAction:false,
    occurredAt:new Date(row.at).toISOString(),title:`${row.direction==='deposit'?'Deposited':'Withdrew'} ${amount}`,body:[row.title,row.account,row.venue].filter(Boolean).join(' · ').slice(0,240)};
   await tx.query('SELECT record_local_notification($1::jsonb,$2)',[JSON.stringify(payload),recovery]);
   // Refresh receipt labels without redelivering it or changing its read state.
   await tx.query("UPDATE notifications SET payload=jsonb_set(jsonb_set(payload,'{body}',to_jsonb($2::text)),'{account}',$4::jsonb) WHERE payload->>'kind'='capital_update' AND payload->'source'->>'id'=$1 AND payload->'context'->>'strategyId'=$3",[row.id,payload.body,row.strategyId,JSON.stringify(payload.account)]);
  }
 });
}
