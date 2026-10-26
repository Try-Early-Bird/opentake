import type {DatabaseClient} from '../database-client';
import type {RuleDraftConfig} from '../../shared/strategy-rules';
import type {RuleLifecycle} from '../../shared/rule-proposals';

/** Presentation only: never resets counters or changes execution permissions. */
export async function readRuleLifecycle(tx:Pick<DatabaseClient,'query'>,takeId:string,revision:number,config:RuleDraftConfig):Promise<Record<string,RuleLifecycle>>{
 const rows=(await tx.query<{rule_id:string;runs:number;status:string|null;active:boolean;job:string|null;review_id:string|null;dispatched:boolean;approval:boolean;review_state:string|null;approval_pending:boolean;last_at:Date|null}>(`
 SELECT ids.rule_id,coalesce((s.state->>'runs')::int,0) AS runs,r.status,r.created_at AS last_at,
 coalesce(r.status IN ('shadow','context_pending') AND r.expires_at>now(),false) AS active,
 j.state AS job,j.review_id,j.approval_pending,v.state AS review_state,(r.approval OR coalesce((SELECT confirm_trades FROM trading_preferences WHERE owner_id=(SELECT id FROM local_owners LIMIT 1)),false)) AS approval,EXISTS(SELECT 1 FROM coinbase_order_dispatches d WHERE d.review_id=j.review_id) AS dispatched
 FROM unnest($3::uuid[]) AS ids(rule_id)
 LEFT JOIN strategy_rule_state s ON s.take_id=$1 AND s.draft_revision=$2 AND s.rule_id=ids.rule_id
 LEFT JOIN LATERAL (SELECT id,status,created_at,expires_at,evidence->'rule'->'policy'->>'approval'='ask' AS approval FROM strategy_rule_action_requests WHERE take_id=$1 AND rule_id=ids.rule_id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
 LEFT JOIN strategy_rule_trades j ON j.request_id=r.id
 LEFT JOIN coinbase_order_reviews v ON v.id=j.review_id`,[takeId,revision,config.rules.map(rule=>rule.id)])).rows;
 return Object.fromEntries(config.rules.map(rule=>{
  const row=rows.find(r=>r.rule_id===rule.id);
  const pending=!!row&&(row.active||['pending','working','attention'].includes(row.job??''));
  const finished=!!row&&row.runs>=rule.policy.maxRuns&&!pending;
  const status:RuleLifecycle['status']=row?.job==='attention'?'Needs attention':pending?(row?.job==='working'&&row.review_id&&row.review_state==='confirmed'&&!row.dispatched&&(row.approval||row.approval_pending)?'Awaiting approval':'In progress'):finished?'Finished':'Waiting';
  return [rule.id,{hidden:finished,status,runs:row?.runs??0,...(row?.last_at?{lastAt:row.last_at.toISOString()}:{}),...(status==='Awaiting approval'&&row?.review_id?{reviewId:row.review_id}:{})}];
 }));
}
