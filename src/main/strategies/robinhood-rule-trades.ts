// A rule's rebalance, deploy cash (a buy-only plan spending at most its
// amount; October 25, 2026) or reduce on a Robinhood Take, as an action adapter. It previews
// the orders without placing anything (planner dry run, or the withdrawal
// preview), stores that preview for the member's approval when the rule asks first or
// "Confirm every trade" is on (one approval flow for both venues), then has the existing
// Robinhood planner and executor place the orders, confirmed. Never resends: placement,
// lost-order recovery and market hours stay with the executor; this follows its legs.
import {strategyRule,ruleDraftConfig,supportsRuleTrade} from '../../shared/strategy-rules';
import type {ActionAdapter,ActionOutcome} from '../venues/types';
import type {PlanOptions} from '../execution/contracts';
import {agentTradeEvidence,agentTradeSuspected} from './rule-trades';
import {decimalToScaledInteger,scaledIntegerToDecimal} from '../allocations/decimal';
import {APPROVAL_DRIFT_BPS,APPROVAL_DRIFT_FLOOR,withinApproved} from '../execution/dispatch-authorization';
import {evaluateRule,initialRuleState} from './rule-evaluator';
import type {StrategyRule} from '../../shared/strategy-rules';
import type {TakeInputSnapshot} from '../../shared/take-inputs';
import type {createDatabaseLifecycle} from '../database';
import type {DatabaseClient} from '../database-client';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<DatabaseClient,'query'>;
export type RobinhoodTradeKind='rebalance_to_target'|'deploy_cash'|'reduce';
export interface PreviewOrder {symbol:string;side:'buy'|'sell';amountUsd:string|null}
export interface RobinhoodRuleTradeDeps {
 /** Planner dry run: the orders a manual rebalance would place now; writes nothing. */
 previewRebalance(allocationId:string,options?:PlanOptions):Promise<{disposition:string;reasonCode:string|null;sleeves:{symbol:string;disposition:string;side:'buy'|'sell'|null;amount:string|null;notionalUsd?:string|null}[]}>;
 previewReduce(allocationId:string,amountUsd:string):Promise<{ok:boolean;legs:{symbol:string;notional:string}[];reasons:{code:string}[]}>;
 /** Plan and place, the member having approved (no second hold). */
 rebalance(allocationId:string,options?:PlanOptions):Promise<{planId:string|null;disposition:string;reasonCode:string|null}>;
 reduce(allocationId:string,amountUsd:string,operationId:string):Promise<{disposition:string;reasonCode:string|null;instruction:{id:string}}>;
 tradingEnabled():boolean;
 /** The Take's bound inputs now (as the Coinbase path re-checks a rule before submitting). */
 snapshot(tx:Query,takeId:string,keys:string[]):Promise<TakeInputSnapshot>;
 notify?(input:{takeId:string;requestId:string;title:string;body:string;attention:boolean}):Promise<void>;
}
type Row={request_id:string;take_id:string;account_id:string;allocation_id:string;kind:RobinhoodTradeKind;amount:string|null;state:string;preview:{orders:PreviewOrder[];at:string;approvalRequired?:boolean};transaction_id:string|null;reason:string|null};

const APPROVAL_RECHECK_MS=15_000,MARKET_RECHECK_MS=15*60_000,FOLLOW_MS=5_000;
const totalUsd=(orders:PreviewOrder[])=>orders.reduce((sum,o)=>sum+decimalToScaledInteger(o.amountUsd!),0n);
// The approval tolerance is the core's (`execution/dispatch-authorization.ts`), the same on every venue.
export {withinApproved};
const deployOptions=(kind:RobinhoodTradeKind,amount:string|null):PlanOptions|undefined=>kind==='deploy_cash'?{buysOnly:true,cashCapUsd:amount!}:undefined;
const OPEN=['queued','reviewed','submitting','submitted','partially_filled'],UNCERTAIN=['placement_unknown','reconciliation_required'];

export function createRobinhoodRuleTrades(database:Database,deps:RobinhoodRuleTradeDeps,clock:()=>number=Date.now){
 const load=async(requestId:string)=>(await database.use(db=>db.query<Row>('SELECT request_id,take_id,account_id,allocation_id,kind,amount::text,state,preview,transaction_id,reason FROM robinhood_rule_trades WHERE request_id=$1',[requestId]))).rows[0]??null;
 const setState=(requestId:string,state:string,reason:string|null=null,transactionId?:string)=>database.use(db=>db.query('UPDATE robinhood_rule_trades SET state=$2,reason=$3,transaction_id=coalesce($4,transaction_id),updated_at=now() WHERE request_id=$1',[requestId,state,reason,transactionId??null]));
 /** The firing ends: executed on success, blocked otherwise. */
 const endRequest=(requestId:string,ok:boolean)=>database.use(db=>db.query("UPDATE strategy_rule_action_requests SET status=$2 WHERE id=$1 AND status='shadow'",[requestId,ok?'executed':'action_blocked']));

 /** Structural checks, every step: the firing, its accepted and granted rule, the route. */
 async function guard(tx:Query,requestId:string,approved:boolean){
  if(!deps.tradingEnabled())return {issue:'trading_disabled'} as const;
  const row=(await tx.query<{take_id:string;rule_id:string;status:string;expired:boolean;action:{kind:string;scope?:{accountId:string};amount?:{value:string}};evidence:{agent?:unknown;snapshot?:TakeInputSnapshot};config:unknown;input_revision:number;version:string;granted:boolean;disabled:boolean;current:boolean;strategy_id:string;confirm_trades:boolean}>(`SELECT r.take_id,r.rule_id,r.status,r.expires_at<=now() AS expired,r.action,r.evidence,d.config,d.input_revision,d.accepted_version AS version,
   (a.trading_enabled AND r.rule_id=ANY(a.trading_rule_ids)) AS granted,r.rule_id=ANY(a.disabled_rule_ids) AS disabled,t.strategy_id,
   -- Rules are accepted against one Take version; a newer committed version makes them stale (as on Coinbase).
   d.accepted_version IS NOT DISTINCT FROM (SELECT current_version_id FROM strategies WHERE id=t.strategy_id) AS current,
   coalesce((SELECT confirm_trades FROM trading_preferences WHERE owner_id=t.owner_id),false) AS confirm_trades
   FROM strategy_rule_action_requests r JOIN takes t ON t.id=r.take_id AND t.archived_at IS NULL
   JOIN strategy_rule_accepted a ON a.take_id=r.take_id AND a.revision=r.draft_revision
   JOIN strategy_rule_shadow sh ON sh.take_id=r.take_id AND sh.enabled AND sh.draft_revision=a.revision
   JOIN strategy_rule_draft_revisions d ON d.take_id=a.take_id AND d.revision=a.revision WHERE r.id=$1`,[requestId])).rows[0];
  if(!row||row.status!=='shadow')return {issue:'request_inactive'} as const;
  // An approval, once asked for, stays open until decided, as on Coinbase.
  if(row.expired&&!approved)return {issue:'request_expired'} as const;
  if(!row.current)return {issue:'take_version_changed'} as const;
  if(!row.granted)return {issue:'trading_not_granted'} as const;
  if(row.disabled)return {issue:'rule_off'} as const;
  const rule=ruleDraftConfig.parse(row.config).rules.find(r=>r.id===row.rule_id);
  if(!rule)return {issue:'rule_action_changed'} as const;
  // An agent run's request is a child firing: within the agent rule's accounts and actions.
  const agent=agentTradeEvidence.safeParse(row.evidence.agent).success;
  let accountId:string,ceiling:string|null=null;
  if(agent){
   const kind=row.action.kind,account=row.action.scope?.accountId;
   if(rule.action.kind!=='agent'||!['rebalance_to_target','deploy_cash','reduce'].includes(kind)||!rule.action.capabilities.actions.includes(kind as 'reduce')||!account||!rule.action.capabilities.accountIds.includes(account))return {issue:'agent_outside_ceiling'} as const;
   accountId=account;ceiling=rule.action.capabilities.maxTradeNotionalUsd??null;
   if(ceiling===null)return {issue:'agent_outside_ceiling'} as const;
  }else{
   if(JSON.stringify(strategyRule.parse({...rule,action:row.action}).action)!==JSON.stringify(rule.action)||!supportsRuleTrade(rule)||!('scope' in rule.action))return {issue:'rule_action_changed'} as const;
   accountId=rule.action.scope.accountId;
  }
  const allocation=(await tx.query<{id:string}>(`SELECT a.id FROM strategy_allocations a JOIN linked_accounts la ON la.id=a.account_id
   WHERE a.strategy_id=$1 AND a.account_id=$2 AND a.status='active' AND NOT a.restore_required AND la.available`,[row.strategy_id,accountId])).rows[0];
  if(!allocation)return {issue:'account_unavailable'} as const;
  return {rule,action:row.action,ceiling,allocationId:allocation.id,takeId:row.take_id,accountId,agent,evidence:row.evidence,inputRevision:row.input_revision,version:row.version,needsApproval:rule.policy.approval==='ask'||row.confirm_trades||agent&&agentTradeSuspected(row.evidence.agent)};
 }

 async function finish(requestId:string,state:'completed'|'blocked'|'declined',reason:string):Promise<ActionOutcome>{
  await setState(requestId,state,reason);await endRequest(requestId,state==='completed');
  return state==='completed'?{state:'succeeded',reason}:state==='declined'?{state:'cancelled',reason}:{state:'blocked',reason};
 }

 /** The orders a rebalance or deploy-cash would place now, in USD on both sides; writes nothing. */
 async function previewOrders(allocationId:string,kind:RobinhoodTradeKind,amount:string|null){
  const plan=await deps.previewRebalance(allocationId,deployOptions(kind,amount));
  const orders:PreviewOrder[]=plan.sleeves.filter(s=>s.disposition==='order'&&s.side).map(s=>({symbol:s.symbol,side:s.side!,amountUsd:s.notionalUsd??null}));
  return {plan,orders};
 }
 /** The firing's ceiling on previewed orders; an order without a known USD value never passes a ceiling. */
 const aboveCeiling=(orders:PreviewOrder[],ceiling:string|null)=>ceiling!==null&&(orders.some(o=>o.amountUsd===null)||totalUsd(orders)>decimalToScaledInteger(ceiling));
 const describe=(kind:RobinhoodTradeKind,amount:string|null,orders:PreviewOrder[])=>`${kind==='reduce'?`Reduce by $${amount}`:kind==='deploy_cash'?`Invest up to $${amount} of cash`:'Rebalance'} on Robinhood: ${orders.map(o=>`${o.side} ${o.symbol}${o.amountUsd?` $${o.amountUsd}`:''}`).join(', ')}.`;

 /** Before placing, a rule's own trigger and conditions must still hold on the Take's current inputs
  *  (as on Coinbase): an approval given later, or a firing that waited for the open, does not trade
  *  on a reason that has passed. An agent's request carries its own reason and is not re-evaluated. */
 async function triggerStillHolds(tx:Query,g:{rule:StrategyRule;takeId:string;evidence:{snapshot?:TakeInputSnapshot};inputRevision:number;version:string}):Promise<'ok'|'stale'|string>{
  const keys=[...new Set([g.rule.trigger.input,...g.rule.conditions.all.map(c=>c.input)])];
  const snapshot=await deps.snapshot(tx,g.takeId,keys);
  if(snapshot.acceptedVersion!==g.version||snapshot.bindingRevision!==g.inputRevision)return 'rule_inputs_changed';
  if(snapshot.inputs.some(input=>{const original=g.evidence.snapshot?.inputs.find(old=>old.binding.key===input.binding.key);return !original?.observation||original.observation.epoch!==input.observation?.epoch||original.observation.runtimeId!==input.observation?.runtimeId;}))return 'source_continuity_changed';
  if(snapshot.status==='blocked'&&snapshot.inputs.length===keys.length&&snapshot.inputs.every(input=>['fresh','stale'].includes(input.quality))&&(snapshot.reason==='time-skew'||snapshot.inputs.some(input=>input.quality==='stale')))return 'stale';
  const t=g.rule.trigger,current={...g.rule,trigger:t.kind==='threshold'?{...t,kind:'threshold' as const,operator:t.operator.endsWith('above')?'above' as const:'below' as const}:t,policy:{...g.rule.policy,holdMs:0}} as StrategyRule;
  return evaluateRule(current,initialRuleState('submission'),snapshot,clock(),'submission',false).fire?'ok':'conditions_no_longer_hold';
 }

 /** One step of one Robinhood rule trade. */
 async function step(requestId:string):Promise<ActionOutcome>{
  let row=await load(requestId);
  if(row&&['completed','blocked','declined'].includes(row.state))return row.state==='completed'?{state:'succeeded',reason:row.reason??'filled'}:{state:row.state==='declined'?'cancelled':'blocked',reason:row.reason??'blocked'};
  if(!row||row.state==='awaiting_approval'||row.state==='approved'){
   const g=await database.use(db=>guard(db,requestId,!!row));
   if('issue' in g){
    if(row)return finish(requestId,'blocked',g.issue!);
    await endRequest(requestId,false);return {state:'blocked',reason:g.issue!};
   }
   if(!row){
    // The firing's own action: the rule's, or what an agent run requested.
    const kind=g.action.kind as RobinhoodTradeKind,amount=kind==='rebalance_to_target'?null:g.action.amount?.value??null;
    let orders:PreviewOrder[];
    if(kind!=='reduce'){
     const preview=await previewOrders(g.allocationId,kind,amount),plan=preview.plan;
     if(plan.reasonCode==='market_closed')return {state:'waiting',waitingFor:'market_open',reason:'market_closed',retryInMs:MARKET_RECHECK_MS};
     orders=preview.orders;
     if(!orders.length){await endRequest(requestId,plan.disposition==='up_to_date'||!plan.reasonCode);return plan.disposition==='up_to_date'||!plan.reasonCode?{state:'succeeded',reason:'already_on_target'}:{state:'blocked',reason:plan.reasonCode};}
    }else{
     const preview=await deps.previewReduce(g.allocationId,amount!);
     if(!preview.ok){await endRequest(requestId,false);return {state:'blocked',reason:preview.reasons[0]?.code??'reduce_unavailable'};}
     orders=preview.legs.map(l=>({symbol:l.symbol,side:'sell',amountUsd:l.notional}));
    }
    // An agent's per-trade ceiling applies to the previewed orders (as on Coinbase).
    if(aboveCeiling(orders,g.ceiling)){await endRequest(requestId,false);return {state:'blocked',reason:'agent_notional_ceiling'};}
    const state=g.needsApproval?'awaiting_approval':'approved';
    await database.use(db=>db.query(`INSERT INTO robinhood_rule_trades(request_id,take_id,account_id,allocation_id,kind,amount,state,preview) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
     [requestId,g.takeId,g.accountId,g.allocationId,kind,amount,state,JSON.stringify({orders,at:new Date(clock()).toISOString(),approvalRequired:g.needsApproval})]));
    if(g.needsApproval){
     await deps.notify?.({takeId:g.takeId,requestId,title:`Rule “${g.rule.name}” wants to trade`,body:`${describe(kind,amount,orders)} Approve or decline it in the Take.`,attention:true}).catch(()=>{});
     return {state:'waiting',waitingFor:'approval',retryInMs:APPROVAL_RECHECK_MS};
    }
    row=(await load(requestId))!;
   }
   if(row.state==='awaiting_approval')return {state:'waiting',waitingFor:'approval',retryInMs:APPROVAL_RECHECK_MS};
   // Approved (or no approval needed): plan fresh and place, confirmed. The rule's reason must still
   // hold, and the fresh plan must stay within what the member approved and the agent's ceiling;
   // otherwise the member is asked again.
   if(!g.agent){
    const holds=await database.use(db=>triggerStillHolds(db,g));
    if(holds==='stale')return {state:'waiting',waitingFor:'inputs',reason:'inputs_temporarily_stale',retryInMs:APPROVAL_RECHECK_MS};
    if(holds!=='ok')return finish(requestId,'blocked',holds);
   }
   try{
    if(row.kind!=='reduce'){
     const fresh=await previewOrders(row.allocation_id,row.kind,row.amount);
     if(fresh.plan.reasonCode==='market_closed')return {state:'waiting',waitingFor:'market_open',reason:'market_closed',retryInMs:MARKET_RECHECK_MS};
     if(!fresh.orders.length)return finish(requestId,fresh.plan.disposition==='up_to_date'||!fresh.plan.reasonCode?'completed':'blocked',fresh.plan.disposition==='up_to_date'||!fresh.plan.reasonCode?'already_on_target':fresh.plan.reasonCode!);
     if(aboveCeiling(fresh.orders,g.ceiling))return finish(requestId,'blocked','agent_notional_ceiling');
     const approvalRequired=row.preview.approvalRequired??true;
     if(approvalRequired&&!withinApproved(fresh.orders,row.preview.orders)){
      await database.use(db=>db.query("UPDATE robinhood_rule_trades SET state='awaiting_approval',preview=$2,updated_at=now() WHERE request_id=$1",[requestId,JSON.stringify({orders:fresh.orders,at:new Date(clock()).toISOString(),approvalRequired})]));
      await deps.notify?.({takeId:row.take_id,requestId,title:`Rule “${g.rule.name}” trade changed`,body:`${describe(row.kind,row.amount,fresh.orders)} The orders changed since you approved; approve or decline again in the Take.`,attention:true}).catch(()=>{});
      return {state:'waiting',waitingFor:'approval',retryInMs:APPROVAL_RECHECK_MS};
     }
     // The planner refuses outright if its own fresh plan exceeds what was just checked.
     const fence=approvalRequired?totalUsd(row.preview.orders)*(10_000n+APPROVAL_DRIFT_BPS)/10_000n+APPROVAL_DRIFT_FLOOR:null,ceiling=g.ceiling===null?null:decimalToScaledInteger(g.ceiling);
     const cap=fence===null?ceiling:ceiling===null||fence<ceiling?fence:ceiling;
     const result=await deps.rebalance(row.allocation_id,{...deployOptions(row.kind,row.amount),...(cap===null?{}:{maxNotionalUsd:scaledIntegerToDecimal(cap)})});
     if(result.reasonCode==='notional_cap')return finish(requestId,'blocked','notional_cap');
     if(result.reasonCode==='market_closed')return {state:'waiting',waitingFor:'market_open',reason:'market_closed',retryInMs:MARKET_RECHECK_MS};
     if(result.disposition==='up_to_date')return finish(requestId,'completed','already_on_target');
     if(result.disposition!=='planned'||!result.planId)return finish(requestId,'blocked',result.reasonCode??'not_planned');
     await setState(requestId,'executing',null,result.planId);
    }else{
     const result=await deps.reduce(row.allocation_id,row.amount!,requestId);
     if(result.disposition!=='planned'&&result.reasonCode!=='market_closed')return finish(requestId,'blocked',result.reasonCode??'not_planned');
     await setState(requestId,'executing',null,result.instruction.id);
    }
   }catch(error){
    const code=(error as {code?:string}).code;
    return finish(requestId,'blocked',code&&/^[a-z][a-z0-9_]{1,63}$/.test(code)?code:'validation_failed');
   }
   row=(await load(requestId))!;
  }
  // Executing: follow the legs the executor placed for this plan or withdrawal.
  const legs=(await database.use(db=>db.query<{status:string}>('SELECT status FROM strategy_executions WHERE plan_id=$1 OR transaction_id=$1',[row!.transaction_id]))).rows;
  if(legs.some(l=>UNCERTAIN.includes(l.status))){await setState(requestId,'attention','order_needs_attention');return {state:'needs_attention',reason:'order_needs_attention'};}
  if(!legs.length||legs.some(l=>OPEN.includes(l.status))){
   const parked=(await database.use(db=>db.query<{planning_reason_code:string|null}>('SELECT planning_reason_code FROM strategy_allocations WHERE id=$1',[row!.allocation_id]))).rows[0]?.planning_reason_code;
   return parked==='market_closed'?{state:'waiting',waitingFor:'market_open',reason:'market_closed',retryInMs:MARKET_RECHECK_MS}:{state:'running',retryInMs:FOLLOW_MS};
  }
  return legs.every(l=>l.status==='filled')?finish(requestId,'completed','filled'):finish(requestId,'blocked','order_failed');
 }

 const adapter=(kind:RobinhoodTradeKind):ActionAdapter<Record<string,never>>=>({
  kind,
  parse:raw=>raw as Record<string,never>,
  advance:job=>step(job.originId),
  // Before anything is placed the member can cancel; once orders are out they run on.
  async cancel(job){const row=await load(job.originId);if(row?.state==='executing'||row?.state==='attention')return step(job.originId);return finish(job.originId,'declined','member_cancelled');},
 });
 return {
  adapters:{rebalance_to_target:adapter('rebalance_to_target'),deploy_cash:adapter('deploy_cash'),reduce:adapter('reduce')},
  step,
  /** Firings on Robinhood accounts become action jobs for this adapter. */
  async enqueue(){
   const created=await database.use(db=>db.query(`INSERT INTO action_jobs(id,kind,origin,origin_id,take_id,account_id,venue,idempotency_key)
    SELECT gen_random_uuid(),r.action->>'kind','rule',r.id,r.take_id,la.id,'robinhood','rule:'||r.id::text FROM strategy_rule_action_requests r
    JOIN strategy_rule_accepted a ON a.take_id=r.take_id AND a.revision=r.draft_revision AND a.trading_enabled AND r.rule_id=ANY(a.trading_rule_ids) AND NOT r.rule_id=ANY(a.disabled_rule_ids)
    JOIN linked_accounts la ON la.id::text=r.action->'scope'->>'accountId' JOIN platform_connections c ON c.id=la.connection_id AND c.venue='robinhood'
    WHERE r.status='shadow' AND r.action->>'kind' IN ('rebalance_to_target','deploy_cash','reduce') AND r.expires_at>now() ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`));
   return {created:created.rows.length};
  },
  /** The member decides a waiting trade (the shared approval card). */
  async decide(requestId:string,approve:boolean){
   const row=await load(requestId);if(!row||row.state!=='awaiting_approval')throw new Error('This trade is no longer waiting for approval.');
   if(approve)await setState(requestId,'approved');else await finish(requestId,'declined','member_declined');
  },
  /** Trades waiting for the member on a Take, with their previewed orders. */
  pending:(takeId:string)=>database.use(async db=>(await db.query<{request_id:string;kind:string;amount:string|null;preview:{orders:PreviewOrder[];at:string};rule_name:string|null;created_at:Date}>(`SELECT t.request_id,t.kind,t.amount::text,t.preview,r.evidence->'rule'->>'name' AS rule_name,t.created_at
   FROM robinhood_rule_trades t JOIN strategy_rule_action_requests r ON r.id=t.request_id WHERE t.take_id=$1 AND t.state='awaiting_approval' ORDER BY t.created_at`,[takeId])).rows),
 };
}
