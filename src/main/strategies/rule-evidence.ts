import {ruleHistoryPolicy} from './rule-retention';
import {ruleEvidenceRequest} from '../../shared/strategy-rules';
import type {createDatabaseLifecycle} from '../database';
import type {DatabaseClient} from '../database-client';
import type {z} from 'zod';

// Legacy sell-only runs reached the buy phase, then incorrectly recorded a no-op.
// This projection preserves stored evidence while reporting their completed fills.
export function ruleTradeReasonSql(alias:''|'j'=''){
 const prefix=alias?`${alias}.`:'';
 return `CASE WHEN ${prefix}state='completed' AND ${prefix}phase='buy' AND ${prefix}reason='already_on_target' THEN 'filled' ELSE ${prefix}reason END`;
}
const tradeOutcomeColumns=`
 (SELECT state FROM strategy_rule_trades WHERE request_id=strategy_rule_action_requests.id) AS trade_state,
 (SELECT ${ruleTradeReasonSql()} FROM strategy_rule_trades WHERE request_id=strategy_rule_action_requests.id) AS trade_reason`;

/** Shared read path: callers own their transaction and authorization scope. */
export async function readRuleEvidence(tx:Pick<DatabaseClient,'query'>,request:z.output<typeof ruleEvidenceRequest>){
   const owned=(await tx.query(`SELECT t.id FROM takes t JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
    WHERE t.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1)`,[request.takeId])).rows.length;
   if(!owned)throw Error('Rule history unavailable');
   const enrollment=(await tx.query<{enabled:boolean;notifications_enabled:boolean}>('SELECT enabled,notifications_enabled FROM strategy_rule_shadow WHERE take_id=$1',[request.takeId])).rows[0];
   const deliveryEnabled=!!enrollment?.enabled&&enrollment.notifications_enabled;
   const mode=deliveryEnabled?'notifications' as const:'shadow' as const;
   if(request.action==='rule-evidence-read'){
    const row=(await tx.query<{id:string;[key:string]:unknown}>(`SELECT id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence,assessment,${tradeOutcomeColumns}
     FROM strategy_rule_action_requests WHERE take_id=$1 AND id=$2`,[request.takeId,request.requestId])).rows[0];
    if(!row)throw Error('Rule history unavailable');
    return {retention:{...ruleHistoryPolicy,pendingProtected:true,deduplicationRetained:true},mode,deliveryEnabled,request:row};
   }
   type Row={id:string;created_at:Date;[key:string]:unknown};
   const rows=(await tx.query<Row>(`SELECT id,draft_revision,rule_id,created_at,expires_at,status,
    action->>'kind' AS action_kind,evidence->>'reason' AS trigger_reason,evidence->'rule'->>'name' AS rule_name,
    ${tradeOutcomeColumns},
    evidence->'context'->>'status' AS context_status,evidence->'context'->>'reason' AS context_reason,
    assessment->>'verdict' AS verdict,assessment->>'summary' AS summary
    FROM strategy_rule_action_requests WHERE take_id=$1
    AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
    ORDER BY created_at DESC,id DESC LIMIT $4`,[request.takeId,request.before?.createdAt??null,request.before?.id??null,request.limit+1])).rows;
   const more=rows.length>request.limit,items=rows.slice(0,request.limit),last=items.at(-1);
   return {retention:{...ruleHistoryPolicy,pendingProtected:true,deduplicationRetained:true},mode,deliveryEnabled,items,next:more&&last?{createdAt:last.created_at.toISOString(),id:last.id}:null};
}
/** Read-only history, including archived Takes and superseded draft revisions. */
export function createRuleEvidence(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>){
 return async(raw:unknown)=>{const request=ruleEvidenceRequest.parse(raw);return database.use(db=>db.transaction(tx=>readRuleEvidence(tx,request)));};
}
