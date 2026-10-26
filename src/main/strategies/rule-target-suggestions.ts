// A firing of a buy / trim / exit rule becomes a suggested change to
// the Take's target (member decision, October 24, 2026). It places no order: the member
// applies and commits the suggestion, and the Take's own rebalancing gets it there. The
// note says what will keep the Take at the new target, from its calendar, drift band and
// rebalance rules that are on.
import {strategyRule,type StrategyRule} from '../../shared/strategy-rules';
import {targetChange,rebalanceKeepers,keepersNote} from './rule-targets';
import type {createDatabaseLifecycle} from '../database';
import type {ProposalPayload} from '../../shared/strategies';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Spec=ProposalPayload['spec'];
export interface RuleTargetDeps {
 suggest(input:{takeId:string;rule:{requestId:string;ruleId:string;ruleName:string};change:(spec:Spec)=>{spec:Spec;note:string}|{reason:string}}):Promise<{ok:true;proposalId:string}|{ok:false;reason:string}>;
 /** The Take's current value, for a dollar buy; null when unknown. */
 value(takeId:string):Promise<number|null>;
 notify?(input:{takeId:string;requestId:string;title:string;body:string;attention:boolean}):Promise<void>;
}
const reasons:Record<string,string>={market_unknown:'The asset is not in the Take, and its symbol is unknown.',amount_unsupported:'That amount cannot be expressed as a target weight.',
 value_unavailable:'The Take’s value is unavailable, so a dollar amount cannot be turned into a weight.',not_enough_cash:'The Take’s target has too little cash for that buy.',
 already_there:'The Take’s target already matches.',all_cash:'A Take holds at least one asset. To move everything to cash, withdraw or close the investment.',take_not_committed:'Commit the Take first.',take_changed:'The Take changed while the suggestion was being prepared.'};

export function createRuleTargetSuggestions(database:Database,deps:RuleTargetDeps){
 return {
  async pass(){
   const rows=(await database.use(db=>db.query<{id:string;take_id:string;rule_id:string;config:{rules:unknown[]};disabled:string[]}>(`SELECT r.id,r.take_id,r.rule_id,d.config,a.disabled_rule_ids AS disabled
    FROM strategy_rule_action_requests r
    JOIN strategy_rule_accepted a ON a.take_id=r.take_id AND a.revision=r.draft_revision AND NOT r.rule_id=ANY(a.disabled_rule_ids)
    JOIN strategy_rule_shadow sh ON sh.take_id=r.take_id AND sh.draft_revision=r.draft_revision AND sh.enabled
    JOIN strategy_rule_draft_revisions d ON d.take_id=a.take_id AND d.revision=a.revision
    WHERE r.status='shadow' AND r.action->>'kind' IN ('buy','trim','exit') AND r.expires_at>now() ORDER BY r.created_at LIMIT 8`))).rows;
   for(const row of rows){
    const rules=row.config.rules.flatMap(r=>{const parsed=strategyRule.safeParse(r);return parsed.success?[parsed.data]:[];});
    const rule=rules.find(r=>r.id===row.rule_id) as StrategyRule|undefined;
    const finish=(status:'executed'|'action_blocked',target:Record<string,unknown>)=>database.use(db=>db.query("UPDATE strategy_rule_action_requests SET status=$2,evidence=evidence||jsonb_build_object('target',$3::jsonb) WHERE id=$1 AND status='shadow'",[row.id,status,JSON.stringify(target)]));
    if(!rule){await finish('action_blocked',{reason:'rule_changed'});continue;}
    const value=rule.action.kind==='buy'&&rule.action.amount.kind==='notional'?await deps.value(row.take_id).catch(()=>null):null;
    let summary='';
    const result=await deps.suggest({takeId:row.take_id,rule:{requestId:row.id,ruleId:rule.id,ruleName:rule.name},change:spec=>{
     const change=targetChange(spec,rule.action,value);if(!change.ok)return {reason:change.reason};
     summary=change.summary;
     const keepers=rebalanceKeepers(change.spec,rules.map(r=>({name:r.name,action:r.action,on:!row.disabled.includes(r.id)})));
     return {spec:change.spec,note:keepersNote(keepers)};
    }});
    if(!result.ok){
     await finish('action_blocked',{reason:result.reason});
     if(result.reason!=='already_there')await deps.notify?.({takeId:row.take_id,requestId:row.id,title:`Rule “${rule.name}” could not suggest a change`,body:reasons[result.reason]??'The suggestion could not be prepared.',attention:true}).catch(()=>{});
     continue;
    }
    await finish('executed',{proposalId:result.proposalId,summary});
    await deps.notify?.({takeId:row.take_id,requestId:row.id,title:`Rule “${rule.name}” suggested a new target`,body:`${summary}. Review it in the Take; nothing changes until you apply and commit it.`,attention:false}).catch(()=>{});
   }
  },
 };
}
