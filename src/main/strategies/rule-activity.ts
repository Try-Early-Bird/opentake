import type {DatabaseClient} from '../database-client';
import type {RuleActivityItem} from '../../shared/rule-proposals';
import {ruleTradeReasonSql} from './rule-evidence';

/** One rule's recent firings with what came of each: its action job, rule trade, the
 *  orders that filled and the agent run it started. Read only; newest first. */
export async function readRuleActivity(tx:Pick<DatabaseClient,'query'>,takeId:string,ruleId:string,limit=20):Promise<RuleActivityItem[]>{
 const rows=(await tx.query<{id:string;created_at:Date;status:string;action_kind:string;job_kind:string|null;job_state:string|null;job_reason:string|null;waiting_for:string|null;run_id:string|null;trade_state:string|null;trade_reason:string|null;fills:{side:string;product:string;quantity:string}[]}>(`
 SELECT r.id,r.created_at,r.status,r.action->>'kind' AS action_kind,a.kind AS job_kind,a.state AS job_state,a.reason AS job_reason,a.waiting_for,a.adapter_state->>'runId' AS run_id,
 j.state AS trade_state,${ruleTradeReasonSql('j')} AS trade_reason,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('side',o.side,'product',o.product,'quantity',p.data->>'filledQuantity') ORDER BY v.created_at,o.id),'[]')
  FROM coinbase_order_reviews v JOIN coinbase_allocation_orders o ON o.account_id=v.account_id AND o.cause LIKE 'review:'||v.id::text||':%'
  JOIN account_orders p ON p.account_id=o.account_id AND p.provider='coinbase' AND p.provider_ref=o.provider_order_ref
  WHERE v.take_id=r.take_id AND v.payload->'rebalance'->>'ruleRequestId'=r.id::text AND coalesce((p.data->>'filledQuantity')::numeric,0)>0) AS fills
 FROM strategy_rule_action_requests r
 LEFT JOIN action_jobs a ON a.origin='rule' AND a.origin_id=r.id
 LEFT JOIN strategy_rule_trades j ON j.request_id=r.id
 WHERE r.take_id=$1 AND r.rule_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT $3`,[takeId,ruleId,limit])).rows;
 return rows.map(row=>({requestId:row.id,at:row.created_at.toISOString(),status:row.status,actionKind:row.action_kind,
  ...(row.job_state?{job:{kind:row.job_kind!,state:row.job_state,reason:row.job_reason,waitingFor:row.waiting_for}}:{}),
  ...(row.trade_state?{trade:{state:row.trade_state,reason:row.trade_reason}}:{}),
  ...(row.run_id?{runId:row.run_id}:{}),fills:row.fills}));
}
