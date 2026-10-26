import type {DatabaseClient} from '../database-client';
import type {NotificationInput} from '../../shared/notifications';
import {strategyRule} from '../../shared/strategy-rules';

/** Called inside the evaluator transaction, after source/revision/expiry checks.
 * The inbox entry and decision receipt commit together; native delivery belongs
 * to the existing notification service, never to the rule worker. */
export async function deliverRuleNotifications(tx:Pick<DatabaseClient,'query'>,takeId:string,revision:number,now:number){
 const enrollment=(await tx.query<{enabled:boolean;notifications_enabled:boolean;draft_revision:number}>('SELECT enabled,notifications_enabled,draft_revision FROM strategy_rule_shadow WHERE take_id=$1 FOR UPDATE',[takeId])).rows[0];
 if(!enrollment?.enabled||!enrollment.notifications_enabled||enrollment.draft_revision!==revision)return;
 const rows=(await tx.query<{id:string;created_at:Date;evidence:{rule:unknown}}>(`SELECT id,created_at,evidence FROM strategy_rule_action_requests
 WHERE take_id=$1 AND draft_revision=$2 AND status='shadow' AND action->>'kind'='notify' AND expires_at>$3 FOR UPDATE`,[takeId,revision,new Date(now)])).rows;
 for(const row of rows){
  const rule=strategyRule.parse(row.evidence.rule);if(rule.action.kind!=='notify')continue;
  const notification:NotificationInput={kind:'rule_notification',tier:'know_today',requiresAction:false,eventKey:row.id,context:{takeId},source:{type:'rule',id:row.id},occurredAt:row.created_at.toISOString(),title:rule.name,body:rule.action.message.slice(0,240)};
  await tx.query('SELECT record_local_notification($1::jsonb,false)',[JSON.stringify(notification)]);
  await tx.query("UPDATE strategy_rule_action_requests SET status='notified' WHERE id=$1",[row.id]);
 }
}
