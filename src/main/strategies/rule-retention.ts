import type {DatabaseClient} from '../database-client';
import {ruleTradeHoldsTake} from '../coinbase/order-reviews';
export const ruleHistoryPolicy={retentionDays:30,batchSize:250,intervalMs:60000} as const;
/** Age-based retention: unexpired pending work and compact firing receipts are never evicted; a finished partial rebalance is history like any other outcome.
 * Requests named by an order review are kept with their trade job; notification links are kept until the notification is pruned. */
export async function pruneRuleHistory(tx:Pick<DatabaseClient,'query'>,now:number,policy:{retentionDays:number;batchSize:number}=ruleHistoryPolicy){
 if(!Number.isSafeInteger(now)||now<0||!Number.isInteger(policy.retentionDays)||policy.retentionDays<1||!Number.isInteger(policy.batchSize)||policy.batchSize<1||policy.batchSize>1000)throw Error('Invalid rule retention policy');
 await tx.query(`UPDATE strategy_rule_action_requests SET status='expired' WHERE status IN ('shadow','context_pending') AND expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM strategy_rule_trades j WHERE j.request_id=strategy_rule_action_requests.id AND ${ruleTradeHoldsTake('j')})`,[new Date(now)]);
 // Keep recent history regardless of its size; prune only expired retention windows.
 const result=await tx.query<{id:string}>(`WITH doomed AS (
  SELECT id FROM strategy_rule_action_requests
  WHERE status NOT IN ('shadow','context_pending') AND created_at<$1
   AND NOT EXISTS(SELECT 1 FROM strategy_rule_trades j WHERE j.request_id=strategy_rule_action_requests.id AND (j.state='pending' OR ${ruleTradeHoldsTake('j')}))
   -- Keep requests that order reviews or live notifications still name; deleting would cascade the trade job.
   AND NOT EXISTS(SELECT 1 FROM coinbase_order_reviews v WHERE v.payload->'rebalance'->>'ruleRequestId'=strategy_rule_action_requests.id::text)
   AND id::text NOT IN(SELECT payload->'source'->>'id' FROM notifications WHERE NOT pruned AND payload->'source'->>'type' IN ('rule','trading_queue') AND payload->'source'->>'id' IS NOT NULL)
  ORDER BY created_at,id LIMIT $2
 ) DELETE FROM strategy_rule_action_requests r USING doomed WHERE r.id=doomed.id RETURNING r.id`,[new Date(now-policy.retentionDays*86400000),policy.batchSize]);
 // Their action jobs go with them; job events cascade.
 if(result.rows.length)await tx.query("DELETE FROM action_jobs WHERE origin='rule' AND origin_id=ANY($1::uuid[])",[result.rows.map(r=>r.id)]);
 return {deleted:result.rows.length};
}
