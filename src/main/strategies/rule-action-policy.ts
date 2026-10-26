import type {DatabaseClient} from '../database-client';
import {supportsRuleTrade,type StrategyRule} from '../../shared/strategy-rules';
import type {ToolPolicy} from '../../shared/mcp-management';
import {restrictPolicies} from '../tool-governance';

type Query=Pick<DatabaseClient,'query'>;
export interface RuleActionPolicy {
 ruleId:string;
 action:StrategyRule['action']['kind'];
 approval:'not_required'|'required'|'blocked';
 reason:string;
 /** Approval policy is not execution authority or a passed broker risk check. */
 execution:'notifications_only'|'preview_only'|'trading';
 tools?:{name:string;policy:ToolPolicy}[];
}

/** Read the same settings as tool governance and trading execution. No new policy
 * settings, implicit grants, broker calls, or proposal acceptance happen here.
 * Call this again at the eventual dispatch boundary, never trust a saved result. */
export async function readRuleActionPolicies(tx:Query,takeId:string,rules:StrategyRule[],tradingEnabled=false):Promise<RuleActionPolicy[]>{
 const take=(await tx.query<{permission_mode:'auto'|'ask';archived_at:Date|null}>(`SELECT permission_mode,archived_at FROM takes WHERE id=$1 AND owner_id=(SELECT id FROM local_owners LIMIT 1)`,[takeId])).rows[0];
 if(!take)throw Error('Take unavailable');
 const preferences=(await tx.query<{confirm_trades:boolean}>('SELECT p.confirm_trades FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1')).rows[0];
 const scopes=(await tx.query<{server_id:string;tool_name:string;policy:ToolPolicy}>('SELECT server_id,tool_name,policy FROM take_tool_permissions WHERE take_id=$1',[takeId])).rows;
 const tools=(await tx.query<{server_id:string;name:string;tool_policy:ToolPolicy;server_policy:ToolPolicy;enabled:boolean}>(`SELECT t.server_id,t.name,t.policy AS tool_policy,s.policy AS server_policy,s.enabled FROM mcp_tools t JOIN mcp_servers s ON s.id=t.server_id`)).rows;
 const notifications=(await tx.query<{enabled:boolean;notifications_enabled:boolean}>('SELECT enabled,notifications_enabled FROM strategy_rule_shadow WHERE take_id=$1',[takeId])).rows[0];
 function toolPolicy(name:string):ToolPolicy{
  // Rule capabilities currently carry tool names, not MCP aliases. Ambiguity
  // cannot select a different server with broader permissions.
  const matches=tools.filter(t=>t.name===name);
  if(matches.length!==1||!matches[0].enabled)return 'blocked';
  const tool=matches[0];
  return restrictPolicies(tool.tool_policy,tool.server_policy,take!.permission_mode==='ask'?'ask':'allowed',...scopes.filter(s=>s.server_id===tool.server_id&&(!s.tool_name||s.tool_name===name)).map(s=>s.policy));
 }
 const live=(await tx.query<{account_id:string;trading_rule_ids:string[]}>(`SELECT route.account_id,a.trading_rule_ids FROM strategy_rule_accepted a JOIN strategy_rule_shadow sh ON sh.take_id=a.take_id AND sh.draft_revision=a.revision AND sh.enabled JOIN takes t ON t.id=a.take_id JOIN strategy_account_routes route ON route.strategy_id=t.strategy_id AND route.venue='coinbase' WHERE a.take_id=$1 AND a.trading_enabled`,[takeId])).rows;
 return rules.map(rule=>{
  const base={ruleId:rule.id,action:rule.action.kind,execution:'preview_only' as const};
  if(take.archived_at)return {...base,approval:'blocked',reason:'take_archived'};
  if(rule.action.kind==='notify')return {...base,execution:notifications?.enabled&&notifications.notifications_enabled?'notifications_only':'preview_only',approval:notifications?.enabled&&notifications.notifications_enabled?'not_required':'blocked',reason:notifications?.enabled&&notifications.notifications_enabled?'notifications_enabled':'notifications_disabled'};
  if(rule.action.kind==='request_review')return {...base,approval:'blocked',reason:'concrete_proposal_required'};
  if(rule.action.kind==='agent'){
   const requested=rule.action.capabilities.tools.map(name=>({name,policy:toolPolicy(name)}));
   const policy=restrictPolicies(...requested.map(t=>t.policy),take.permission_mode==='ask'?'ask':'allowed',rule.policy.approval==='ask'?'ask':'allowed');
   return {...base,tools:requested,approval:policy==='blocked'?'blocked':policy==='ask'?'required':'not_required',reason:policy==='blocked'?'tool_unavailable_or_blocked':policy==='ask'?'chat_or_tool_confirmation':'chat_tools_allowed'};
  }
  if(rule.action.kind==='pause_self')return {...base,approval:'required',reason:'take_change_requires_acceptance'};
  // Buy/trim/exit suggest a new target; the member applies and commits it. No trading needed.
  if(['buy','trim','exit'].includes(rule.action.kind))return {...base,approval:'required',reason:'target_change_suggestion'};
  if(!tradingEnabled)return {...base,approval:'blocked',reason:'trading_disabled'};
  // Chat Auto deliberately does not participate in trading confirmation.
  const confirmation=(preferences?.confirm_trades??false)||rule.policy.approval==='ask';
  return {...base,execution:supportsRuleTrade(rule)&&'scope' in rule.action&&live.filter(a=>a.trading_rule_ids.includes(rule.id)).map(a=>a.account_id).includes(rule.action.scope.accountId)?'trading':'preview_only',approval:confirmation?'required':'not_required',reason:preferences?.confirm_trades?'confirm_every_trade':rule.policy.approval==='ask'?'rule_requires_confirmation':'existing_trading_policy'};
 });
}
