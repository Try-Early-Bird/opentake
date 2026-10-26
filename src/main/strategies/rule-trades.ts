import {z} from 'zod';
import type {DatabaseClient} from '../database-client';
import type {AccountQueues} from '../execution/account-queues';
import type {createDatabaseLifecycle} from '../database';
import type {TakeInputSnapshot} from '../../shared/take-inputs';
import {strategyRule,ruleDraftConfig,supportsRuleTrade,type StrategyRule,ruleTradeKinds} from '../../shared/strategy-rules';
import type {CoinbaseOrderReview} from '../../shared/coinbase-orders';
import type {CoinbaseReviewRow} from '../coinbase/order-reviews';
import {NoCoinbaseOrdersError,ruleTradeHoldsTake} from '../coinbase/order-reviews';
import {evaluateRule,initialRuleState} from './rule-evaluator';
import type {NotificationWriter,NotificationKey} from '../../shared/notifications';
type Query=Pick<DatabaseClient,'query'>;
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;

/** Local ledger preflight only: never fetch brokerage data while evaluating a rule. */
export async function ruleTradeFundingIssue(tx:Query,takeId:string,accountId:string){
 // A Robinhood Take is funded when it has an active investment on that account.
 const venue=(await tx.query<{venue:string}>('SELECT c.venue FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE a.id=$1',[accountId])).rows[0]?.venue;
 if(venue==='robinhood')return (await tx.query(`SELECT 1 FROM takes t JOIN strategy_allocations a ON a.strategy_id=t.strategy_id AND a.account_id=$2 AND a.status='active' WHERE t.id=$1`,[takeId,accountId])).rows.length?null:'take_unfunded';
 const row=(await tx.query<{id:string;funded:boolean;quote:boolean;routed:boolean;current:boolean}>(`SELECT ca.id,ca.version_id=s.current_version_id AS current,
  EXISTS(SELECT 1 FROM coinbase_allocation_entries e WHERE e.allocation_id=ca.id GROUP BY asset HAVING sum(quantity)>0) AS funded,
  EXISTS(SELECT 1 FROM coinbase_allocation_entries e WHERE e.allocation_id=ca.id AND kind='capital' AND asset IN ('USD','USDC')) AS quote,
  EXISTS(SELECT 1 FROM strategy_account_routes r WHERE r.strategy_id=s.id AND r.venue='coinbase' AND r.account_id=ca.account_id) AS routed
  FROM takes t JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
  JOIN coinbase_allocations ca ON ca.strategy_id=s.id AND ca.account_id=$2
  WHERE t.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1)`,[takeId,accountId])).rows[0];
 if(!row?.funded)return 'take_unfunded';
 if(!row.current)return 'allocation_version_changed';
 if(!row.quote)return 'funding_currency_unavailable';
 if(!row.routed)return 'account_route_changed';
 return null;
}
class RuleTradeValidationError extends Error{
 constructor(readonly reason:string,message:string){super(message);}
}
/** What a rule trade does; only a rebalance has a buy phase after its sells. */
const unsupportedTradeKinds:string[]=[];
export type RuleTradeAction={kind:'rebalance_to_target'}|{kind:'deploy_cash'|'reduce';amount:{value:string;currency:'USD'|'USDC'}};
type Job={request_id:string;take_id:string;account_id:string;phase:'initial'|'buy';state:string;review_id:string|null;approval_pending:boolean;reason?:string|null};
// A confirmed approval ends only when the firing itself is invalidated (request, rule,
// Take, route, versions or funding). Anything else, including connection/sync gaps,
// source continuity and database errors, keeps waiting; submission rechecks the guard.
const definitiveApprovalReasons=['request_inactive','request_expired','trade_eligibility_changed','take_unfunded','allocation_version_changed','funding_currency_unavailable','account_route_changed','rule_action_changed','unsupported_rule_trade','rule_review_changed','rule_inputs_changed'];
const partialNotice={buy:'Sells completed but the buy step did not run. Open this Take to review its cash and rebalance it.',fill:'Some orders filled but the rest were not sent. Open this Take to review its cash and rebalance it.'};
interface Dependencies{
 enabled():boolean;
 snapshot(tx:Query,takeId:string,keys:string[]):Promise<TakeInputSnapshot>;
 /** Rebalance (in phases), deploy cash (buy-only, up to the amount) or reduce (a withdrawal). */
 preview(takeId:string,quote:'USD'|'USDC',requestId:string,phase:'initial'|'buy',action?:RuleTradeAction):Promise<CoinbaseOrderReview>;
 view(id:string):Promise<CoinbaseOrderReview>;
 confirm(id:string):Promise<CoinbaseOrderReview>;
 submit(id:string):Promise<CoinbaseOrderReview>;
 refresh(id:string):Promise<CoinbaseOrderReview>;
 cancelPrepared(id:string):Promise<unknown>;
 notifications?:NotificationWriter;
 /** Asks for another pass soon, e.g. to start a buy phase right after its sells filled. */
 wake?():void;
 /** Serializes each job with other money-moving work on its account. */
 accounts?:AccountQueues;
 /** Receives an unexpected pass failure; without it tick() rejects. */
 report?(error:unknown):void;
}
/** One identity per firing, two sequential phases. The existing order executor
 * owns irreversible claims and uncertain outcomes; this worker never resends. */
// A locally closed, unfilled review needs no further approval or broker action.
function closedUnfilledReview(review:CoinbaseOrderReview):string|null{
 if(!['cancelled','settled'].includes(review.state)||!review.orders.length)return null;
 if(!review.orders.every(order=>['cancelled','rejected','expired'].includes(order.execution?.state??'')&&(order.filledQuantity!==undefined?Number(order.filledQuantity)===0:review.state==='cancelled')))return null;
 return review.orders.some(order=>order.execution?.state==='rejected')?'order_rejected':review.orders.some(order=>order.execution?.state==='expired')?'order_expired':'cancelled';
}
/** Marks a child firing created by an agent run's trade request. */
export const agentTradeEvidence=z.object({parentRequestId:z.uuid(),runId:z.uuid(),reason:z.string().max(1000),
 /** The requesting run read instruction-shaped content (prompt-injection screen): the trade always waits for the member. */
 suspicion:z.object({sources:z.array(z.string().max(80)).max(32),signals:z.array(z.string().max(40)).max(16)}).strict().optional()}).strict();
/** An agent-requested trade whose run was flagged by the prompt-injection screen. */
export const agentTradeSuspected=(agent:unknown)=>{const parsed=agentTradeEvidence.safeParse(agent);return parsed.success&&parsed.data.suspicion!==undefined;};
/** The agent rule's per-trade ceiling, on the previewed orders of each phase. */
function agentNotionalCheck(rule:StrategyRule,orders:readonly {notional:string}[]){
 if(rule.action.kind!=='agent')return;
 const ceiling=Number(rule.action.capabilities.maxTradeNotionalUsd),total=orders.reduce((sum,o)=>sum+Number(o.notional),0);
 if(!Number.isFinite(ceiling)||!(total<=ceiling))throw new RuleTradeValidationError('agent_notional_ceiling','Above the agent rule’s per-trade ceiling');
}
export function createRuleTrades(database:Database,deps:Dependencies,now=Date.now){
 async function agentCeiling(requestId:string,orders:readonly {notional:string}[]){
  const row=(await database.use(db=>db.query<{evidence:{agent?:unknown;rule?:unknown}}>('SELECT evidence FROM strategy_rule_action_requests WHERE id=$1',[requestId]))).rows[0];
  if(!row||!agentTradeEvidence.safeParse(row.evidence.agent).success)return;
  agentNotionalCheck(strategyRule.parse(row.evidence.rule),orders);
 }
 let work:Promise<void>|undefined;
 async function guard(tx:Query,requestId:string,manual=false,review?:CoinbaseReviewRow){
  if(!deps.enabled())throw new RuleTradeValidationError('trading_unavailable','Trading unavailable');
  const request=(await tx.query<{take_id:string;action:{scope?:{accountId?:string}};status:string;expires_at:Date}>('SELECT take_id,action,status,expires_at FROM strategy_rule_action_requests WHERE id=$1',[requestId])).rows[0];
  if(!request||request.status!=='shadow')throw new RuleTradeValidationError('request_inactive','Rule request is no longer active');
  const job=(await tx.query<{approval_pending:boolean;phase:string}>('SELECT approval_pending,phase FROM strategy_rule_trades WHERE request_id=$1',[requestId])).rows[0];
  // After sells settle the firing has committed to the rebalance: the buy phase
  // rechecks safety (account, source continuity, versions, confirmation) but not
  // trigger expiry or the threshold condition.
  const persistent=job?.approval_pending===true,buy=job?.phase==='buy',committed=persistent||buy;
  if(!committed&&request.expires_at.getTime()<=now())throw new RuleTradeValidationError('request_expired','Rule request expired');
  if(request.action.scope?.accountId){const issue=await ruleTradeFundingIssue(tx,request.take_id,request.action.scope.accountId);if(issue)throw new RuleTradeValidationError(issue,'Take funding or account route is unavailable');}
  // Live account availability (connection, sync, trade permission, allocation state) is
  // transient; the rest is the firing's structural eligibility.
  const eligible=(live:boolean)=>tx.query<{take_id:string;rule_id:string;action:unknown;draft_revision:number;expires_at:Date;status:string;evidence:{rule:unknown;snapshot:TakeInputSnapshot};version:string;config:unknown;input_revision:number;account_id:string;strategy_id:string;quote:string;confirm_trades:boolean}>(`SELECT r.take_id,r.rule_id,r.action,r.draft_revision,r.expires_at,r.status,r.evidence,s.current_version_id AS version,d.config,d.input_revision,ca.account_id,s.id AS strategy_id,
   (SELECT asset FROM coinbase_allocation_entries WHERE allocation_id=ca.id AND kind='capital' AND asset IN ('USD','USDC') ORDER BY occurred_at DESC LIMIT 1) AS quote,
   coalesce((SELECT confirm_trades FROM trading_preferences WHERE owner_id=t.owner_id),false) AS confirm_trades
   FROM strategy_rule_action_requests r JOIN takes t ON t.id=r.take_id JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
   JOIN strategy_versions v ON v.id=s.current_version_id AND v.source_proposal_id=s.draft_revision_id
   JOIN strategy_rule_accepted a ON a.take_id=t.id AND a.revision=r.draft_revision AND a.trading_enabled AND r.rule_id=ANY(a.trading_rule_ids)
   JOIN strategy_rule_shadow sh ON sh.take_id=t.id AND sh.enabled AND sh.draft_revision=a.revision
   JOIN strategy_rule_draft_revisions d ON d.take_id=t.id AND d.revision=a.revision AND d.accepted_version=s.current_version_id
   JOIN coinbase_allocations ca ON ca.strategy_id=s.id AND ca.account_id=(r.action->'scope'->>'accountId')::uuid AND ca.version_id=s.current_version_id
   JOIN strategy_account_routes route ON route.strategy_id=s.id AND route.venue='coinbase' AND route.account_id=ca.account_id${live?`
   JOIN linked_accounts la ON la.id=ca.account_id JOIN platform_connections c ON c.id=la.connection_id AND c.owner_id=t.owner_id AND c.venue='coinbase'
   JOIN coinbase_connection_details cd ON cd.connection_id=c.id`:''}
   WHERE r.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1) AND t.archived_at IS NULL AND s.archived_at IS NULL
    AND s.status='committed'${live?` AND ca.status='active' AND NOT ca.restore_required AND la.available AND c.status='connected' AND cd.can_trade`:''}
   FOR UPDATE OF t,s,a,sh`,[requestId]);
  const row=(await eligible(true)).rows[0];
  if(!row&&(await eligible(false)).rows.length)throw new RuleTradeValidationError('account_unavailable','Coinbase account is not ready to trade');
  if(!row||row.status!=='shadow'||(!committed&&row.expires_at.getTime()<=now())||!['USD','USDC'].includes(row.quote))throw new RuleTradeValidationError('trade_eligibility_changed','Rule trade unavailable or expired');
  const rule=strategyRule.parse(row.evidence.rule);
  const accepted=ruleDraftConfig.parse(row.config).rules.find(r=>r.id===row.rule_id);
  // A trade an agent run requested is a child firing of the agent's rule.
  const agent=agentTradeEvidence.safeParse((row.evidence as {agent?:unknown}).agent).success;
  if(!accepted||JSON.stringify(accepted)!==JSON.stringify(rule))throw new RuleTradeValidationError('rule_action_changed','Rule action changed');
  if(agent){
   const requested=row.action as {kind?:string;scope?:{accountId?:string}};
   if(rule.action.kind!=='agent'||!(ruleTradeKinds as readonly string[]).includes(requested.kind??'')||!rule.action.capabilities.actions.includes(requested.kind as 'rebalance_to_target')
    ||!rule.action.capabilities.accountIds.includes(row.account_id)||requested.scope?.accountId!==row.account_id)throw new RuleTradeValidationError('agent_outside_ceiling','Outside the agent rule’s accounts or actions');
   if(review)agentNotionalCheck(rule,review.payload.orders);
  }else{
   if(JSON.stringify(strategyRule.parse({...rule,action:row.action}).action)!==JSON.stringify(rule.action))throw new RuleTradeValidationError('rule_action_changed','Rule action changed');
   if(!supportsRuleTrade(rule)||!('scope' in rule.action)||rule.action.scope.accountId!==row.account_id)throw new RuleTradeValidationError('unsupported_rule_trade','Unsupported rule trade');
  }
  if(review&&(review.take_id!==row.take_id||review.account_id!==row.account_id||review.version_id!==row.version))throw new RuleTradeValidationError('rule_review_changed','Rule review changed');
  const keys=[...new Set([rule.trigger.input,...rule.conditions.all.map(c=>c.input)])];
  const snapshot=await deps.snapshot(tx,row.take_id,keys);
  if(snapshot.acceptedVersion!==row.version||snapshot.bindingRevision!==row.input_revision)throw new RuleTradeValidationError('rule_inputs_changed','Rule inputs changed');
  if(!agent&&snapshot.inputs.some(input=>{const original=row.evidence.snapshot.inputs.find(old=>old.binding.key===input.binding.key);return !original?.observation||original.observation.epoch!==input.observation?.epoch||original.observation.runtimeId!==input.observation?.runtimeId;}))throw new RuleTradeValidationError('source_continuity_changed','Source continuity changed');
  if(!agent&&!buy&&snapshot.status==='blocked'&&snapshot.inputs.length===keys.length&&snapshot.inputs.every(input=>['fresh','stale'].includes(input.quality))&&(snapshot.reason==='time-skew'||snapshot.inputs.some(input=>input.quality==='stale')))throw new RuleTradeValidationError('inputs_temporarily_stale','Waiting for fresh source data. Try again when prices update.');
  const current={...rule,trigger:{...rule.trigger,kind:'threshold' as const,operator:rule.trigger.kind==='threshold'&&rule.trigger.operator.endsWith('above')?'above' as const:'below' as const},policy:{...rule.policy,holdMs:0}} as StrategyRule;
  if(!agent&&!buy&&!evaluateRule(current,initialRuleState('submission'),snapshot,now(),'submission',false).fire)throw new RuleTradeValidationError('conditions_no_longer_hold','Rule conditions no longer hold');
  const needsConfirmation=persistent||row.confirm_trades||rule.policy.approval==='ask'||agent&&agentTradeSuspected((row.evidence as {agent?:unknown}).agent);
  if(review&&!manual&&needsConfirmation)throw new RuleTradeValidationError('confirmation_required','Trade confirmation required');
  return {...row,needsConfirmation};
 }
 async function validateSubmission(tx:Query,row:CoinbaseReviewRow,manual:boolean){
  const requestId=row.payload.rebalance?.ruleRequestId;if(!requestId)return;
  const job=(await tx.query<Job>('SELECT * FROM strategy_rule_trades WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
  if(!job||job.review_id!==row.id||job.state!=='working')throw Error('Rule trade unavailable');
  await guard(tx,requestId,manual,row);
 }
 async function finish(job:Job,state:'completed'|'blocked'|'attention',reason:string,releaseRun=false,partial:keyof typeof partialNotice='buy'){
  await database.use(db=>db.transaction(async tx=>{
   const transitioned=await tx.query(`UPDATE strategy_rule_trades SET state=$2,reason=$3,updated_at=$4 WHERE request_id=$1 AND state IN ('pending','working','attention') RETURNING request_id`,[job.request_id,state,reason,new Date(now())]);
   // Release only a pre-preparation failure, once. Preserve attempts, cooldown,
   // and trigger/reset state; a failed request must never replay automatically.
   if(releaseRun&&transitioned.rows.length)await tx.query(`UPDATE strategy_rule_state s SET state=jsonb_set(s.state,'{runs}',to_jsonb(greatest(0,(s.state->>'runs')::int-1)))
    FROM strategy_rule_action_requests r WHERE r.id=$1 AND s.take_id=r.take_id AND s.draft_revision=r.draft_revision AND s.rule_id=r.rule_id
    AND NOT EXISTS(SELECT 1 FROM coinbase_order_reviews v WHERE v.payload->'rebalance'->>'ruleRequestId'=r.id::text)`,[job.request_id]);
   // A partial rebalance holds no orders or reservations: it ends the firing so later firings,
   // schedules and retention proceed, while its act-now notice stays open for the member.
   if(state!=='attention'||reason==='partial_rebalance')await tx.query("UPDATE strategy_rule_action_requests SET status=$2 WHERE id=$1 AND status='shadow'",[job.request_id,state==='completed'?'executed':'action_blocked']);
  }));
  if(deps.notifications)try{const key=await noticeKey(job);if(state==='attention')await deps.notifications.record({...key,tier:'act_now',requiresAction:true,occurredAt:new Date(now()).toISOString(),title:'Rule rebalance needs attention',body:reason==='partial_rebalance'?partialNotice[partial]:'Open this Take to review its Coinbase orders. Uncertain orders will not be sent again.'});else await deps.notifications.resolve(key);}catch{/* A failed notice must not rewrite a settled execution outcome. */}
 }
 async function noticeKey(job:Job):Promise<NotificationKey>{
  const target=(await database.use(db=>db.query<{strategy_id:string}>('SELECT strategy_id FROM takes WHERE id=$1',[job.take_id]))).rows[0];
  return {kind:'trading_waiting',context:target?.strategy_id?{strategyId:target.strategy_id}:{takeId:job.take_id},source:{type:'trading_queue',id:job.request_id},eventKey:'rule-rebalance'};
 }
 /** Create jobs for new rule firings and mirror every rule trade into the shared action
  *  core; unsupported trading actions are recorded as blocked with a reason
  *  instead of silently expiring. Idempotent and crash-safe: each run fills what is missing. */
 async function enqueue(){
  // Repair partial rebalances recorded before they ended their firing.
  await database.use(db=>db.query("UPDATE strategy_rule_action_requests r SET status='action_blocked' FROM strategy_rule_trades j WHERE j.request_id=r.id AND r.status='shadow' AND j.state='attention' AND j.reason='partial_rebalance'"));
  await database.use(db=>db.query(`INSERT INTO strategy_rule_trades(request_id,take_id,account_id)
   SELECT r.id,r.take_id,(r.action->'scope'->>'accountId')::uuid FROM strategy_rule_action_requests r
   JOIN strategy_rule_accepted a ON a.take_id=r.take_id AND a.revision=r.draft_revision AND a.trading_enabled AND r.rule_id=ANY(a.trading_rule_ids) AND NOT r.rule_id=ANY(a.disabled_rule_ids)
   -- Robinhood accounts have their own adapter.
   JOIN linked_accounts la ON la.id::text=r.action->'scope'->>'accountId' JOIN platform_connections c ON c.id=la.connection_id AND c.venue='coinbase'
   WHERE r.status='shadow' AND r.action->>'kind' IN ('rebalance_to_target','deploy_cash','reduce') AND r.expires_at>$1 ON CONFLICT DO NOTHING`,[new Date(now())]));
  // Trading actions no venue executes yet, on a Take with trading on: blocked, with a reason.
  // Every rule trading kind has a handler (buy/trim/exit suggest a target).
  if(unsupportedTradeKinds.length)await database.use(db=>db.transaction(async tx=>{
   const blocked=(await tx.query<{id:string}>(`UPDATE strategy_rule_action_requests r SET status='action_blocked' FROM strategy_rule_accepted a
    WHERE a.take_id=r.take_id AND a.revision=r.draft_revision AND a.trading_enabled AND r.status='shadow' AND r.action->>'kind'=ANY($1::text[]) RETURNING r.id`,[unsupportedTradeKinds])).rows;
   if(blocked.length)await tx.query(`INSERT INTO action_jobs(id,kind,origin,origin_id,take_id,account_id,venue,idempotency_key,state,reason)
    SELECT gen_random_uuid(),r.action->>'kind','rule',r.id,r.take_id,la.id,c.venue,'rule:'||r.id::text,'blocked','action_unsupported'
    FROM strategy_rule_action_requests r LEFT JOIN linked_accounts la ON la.id::text=r.action->'scope'->>'accountId' LEFT JOIN platform_connections c ON c.id=la.connection_id
    WHERE r.id=ANY($1::uuid[]) ON CONFLICT(idempotency_key) DO NOTHING`,[blocked.map(b=>b.id)]);
  }));
  // Mirror rule trades (new ones and, on first run, existing ones) into action_jobs.
  const mirrored=await database.use(db=>db.query(`INSERT INTO action_jobs(id,kind,origin,origin_id,take_id,account_id,venue,idempotency_key,state,waiting_for,reason)
   SELECT gen_random_uuid(),coalesce((SELECT r.action->>'kind' FROM strategy_rule_action_requests r WHERE r.id=j.request_id),'rebalance_to_target'),'rule',j.request_id,j.take_id,j.account_id,'coinbase','rule:'||j.request_id::text,
    CASE WHEN j.state='pending' THEN 'queued' WHEN j.state='completed' THEN 'succeeded' WHEN j.state='blocked' THEN 'blocked'
     WHEN j.state='attention' AND j.reason='partial_rebalance' THEN 'needs_attention' WHEN j.state='attention' OR j.approval_pending THEN 'waiting' ELSE 'running' END,
    CASE WHEN j.state='attention' AND j.reason IS DISTINCT FROM 'partial_rebalance' THEN 'account' WHEN j.state='working' AND j.approval_pending THEN 'approval' END,
    CASE WHEN j.state IN ('completed','blocked','attention') THEN CASE WHEN j.reason ~ '^[a-z][a-z0-9_]{1,63}$' THEN j.reason ELSE 'unknown' END END
   FROM strategy_rule_trades j WHERE NOT EXISTS(SELECT 1 FROM action_jobs x WHERE x.idempotency_key='rule:'||j.request_id::text)
   ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`));
  return {created:mirrored.rows.length};
 }
 const actionOf=async(requestId:string):Promise<RuleTradeAction>=>{const a=(await database.use(db=>db.query<{action:RuleTradeAction}>('SELECT action FROM strategy_rule_action_requests WHERE id=$1',[requestId]))).rows[0]?.action;return a&&(a.kind==='deploy_cash'||a.kind==='reduce')?{kind:a.kind,amount:a.amount}:{kind:'rebalance_to_target'};};
 const load=async(requestId:string)=>(await database.use(db=>db.query<Job>('SELECT * FROM strategy_rule_trades WHERE request_id=$1',[requestId]))).rows[0]??null;
 /** One step of one rule trade, as the shared core's Coinbase rebalance adapter. */
 async function advance(requestId:string):Promise<Job|null>{
  const job=await load(requestId);if(!job)return null;
  if(job.state==='pending'||job.state==='working'||(job.state==='attention'&&job.reason!=='partial_rebalance'))await process(job);
  return load(requestId);
 }
 /** Member cancellation before any order went out; an order already sent keeps running. */
 async function cancel(requestId:string):Promise<Job|null>{
  const job=await load(requestId);if(!job||!['pending','working'].includes(job.state))return job;
  if(job.review_id){
   const review=await deps.view(job.review_id);
   if(review.orders.some(o=>o.execution&&!['reserved','reviewed'].includes(o.execution.state)))return job;
   if(review.state==='preview'||review.state==='confirmed'||review.state==='expired')await deps.cancelPrepared(job.review_id);
  }
  await finish(job,job.phase==='buy'?'attention':'blocked',job.phase==='buy'?'partial_rebalance':'member_cancelled');
  return load(requestId);
 }
 async function pass(signal?:AbortSignal){
  if(!deps.enabled())return;
  await enqueue();
  const jobs=(await database.use(db=>db.query<Job>(`SELECT * FROM strategy_rule_trades j WHERE j.state='pending' OR ${ruleTradeHoldsTake('j')} ORDER BY updated_at,request_id LIMIT 16`))).rows;
  for(const job of jobs){
   if(!deps.enabled()||signal?.aborted)break;
   // The account queue keeps this job apart from the scheduler, manual orders and
   // investments on the same account; jobs on other accounts are not held up.
   if(deps.accounts)await deps.accounts.run([job.account_id],()=>process(job),{label:'rule trade',signal});
   else await process(job);
  }
 }
 async function process(job:Job){
  await database.use(db=>db.query('UPDATE strategy_rule_trades SET updated_at=$2 WHERE request_id=$1',[job.request_id,new Date(now())]));
  let preparationStarted=!!job.review_id;
  try{
   // Recover a preview persisted just before a host crash; never prepare twice.
   if(!job.review_id){const existing=(await database.use(db=>db.query<{id:string}>("SELECT id FROM coinbase_order_reviews WHERE payload->'rebalance'->>'ruleRequestId'=$1 AND coalesce(payload->'rebalance'->>'phase','initial')=$2 AND coalesce(payload->'rebalance'->>'quoteRevision','0')='0'",[job.request_id,job.phase]))).rows[0];if(existing){job={...job,review_id:existing.id};await database.use(db=>db.query("UPDATE strategy_rule_trades SET review_id=$2,state='working' WHERE request_id=$1",[job.request_id,existing.id]));}}
   preparationStarted=!!job.review_id;
   let review=job.review_id?await deps.view(job.review_id):null;
   const closedReason=review?closedUnfilledReview(review):null;
   if(closedReason){await finish(job,job.phase==='buy'?'attention':'blocked',job.phase==='buy'?'partial_rebalance':closedReason);return;}
   // Recover old misclassified cancellations from local evidence only. Never
   // retry or dispatch an order whose result still needs reconciliation.
   if(job.state==='attention')return;
   if(review?.orders.some(o=>o.execution&&o.execution.state!=='reserved'&&o.execution.state!=='reviewed')){
    review=await deps.refresh(review.id);
    const terminalReason=closedUnfilledReview(review);
    if(terminalReason){await finish(job,job.phase==='buy'?'attention':'blocked',job.phase==='buy'?'partial_rebalance':terminalReason);return;}
    if(review.state==='settled'&&review.orders.every(o=>o.execution?.state==='filled')){
     if(review.phase==='sell'&&job.phase==='initial'&&(await actionOf(job.request_id)).kind==='rebalance_to_target'){await database.use(db=>db.query("UPDATE strategy_rule_trades SET phase='buy',review_id=NULL,state='working',updated_at=$2 WHERE request_id=$1",[job.request_id,new Date(now())]));deps.wake?.();return;}
     await finish(job,'completed','filled');return;
    }
    // Some orders filled and the unsent remainder was released: never resend, ask the member.
    if(review.state==='settled'&&review.orders.some(o=>o.execution?.state==='filled')&&review.orders.every(o=>o.execution?.state==='filled'||(['cancelled','rejected','expired'].includes(o.execution?.state??'')&&o.filledQuantity!==undefined&&Number(o.filledQuantity)===0))){await finish(job,'attention','partial_rebalance',false,'fill');return;}
    // A closed order known to have filled nothing (e.g. a released unsent remainder) is not uncertain.
    if(review.orders.some(o=>['unknown','reconciliation_required'].includes(o.execution?.state??'')||(['rejected','cancelled','expired'].includes(o.execution?.state??'')&&!(o.filledQuantity!==undefined&&Number(o.filledQuantity)===0)))){await finish(job,'attention','order_needs_attention');return;}
    return;
   }
   // A reserved manual approval is durable. Freshness, the condition, the account
   // and source continuity are checked on confirmation; only a definitive
   // invalidation (superseded/disabled rule, archived Take, removed route, changed
   // versions) ends it here (the catch path cancels and resolves).
   if(job.approval_pending&&review?.state==='confirmed'){
    try{await database.use(db=>db.transaction(tx=>guard(tx,job.request_id)));}
    catch(error){if(error instanceof RuleTradeValidationError&&definitiveApprovalReasons.includes(error.reason))throw error;if(!(error instanceof RuleTradeValidationError))deps.report?.(error);return;}
    return;
   }
   if(review&&Date.parse(review.expiresAt)<=now())throw new RuleTradeValidationError('review_expired','Review expired');
   const current=await database.use(db=>db.transaction(tx=>guard(tx,job.request_id)));
   if(!review){
    const conflicts=(await database.use(db=>db.query(`SELECT 1 FROM coinbase_rebalance_runs r JOIN coinbase_allocations a ON a.id=r.allocation_id WHERE a.strategy_id=$1 AND r.state IN ('pending','working','attention')
     UNION ALL SELECT 1 FROM strategy_rule_trades j WHERE take_id=$2 AND request_id<>$4 AND ${ruleTradeHoldsTake('j')}
     UNION ALL SELECT 1 FROM mixed_take_executions WHERE take_id=$2 AND state<>'completed'
     UNION ALL SELECT 1 FROM mixed_take_withdrawals WHERE take_id=$2 AND state IN ('running','attention')
     UNION ALL SELECT 1 FROM coinbase_order_reviews WHERE take_id=$2 AND (state='confirmed' OR state='preview' AND expires_at>$3) LIMIT 1`,[current.strategy_id,job.take_id,new Date(now()),job.request_id]))).rows.length;
    if(conflicts)return;
    preparationStarted=true;
    review=await deps.preview(job.take_id,current.quote as 'USD'|'USDC',job.request_id,job.phase,await actionOf(job.request_id));
    job={...job,review_id:review.id};await database.use(db=>db.query("UPDATE strategy_rule_trades SET review_id=$2,state='working',updated_at=$3 WHERE request_id=$1",[job.request_id,job.review_id,new Date(now())]));
   }
   if(Date.parse(review.expiresAt)<=now())throw new RuleTradeValidationError('review_expired','Review expired');
   if(review.state==='cancelled'){await finish(job,'blocked','cancelled');return;}
   if(review.state==='preview')review=await deps.confirm(review.id);
   if(review.state!=='confirmed')throw new RuleTradeValidationError('review_unavailable','Review unavailable');
   await agentCeiling(job.request_id,review.orders);
   const checked=await database.use(db=>db.transaction(tx=>guard(tx,job.request_id)));
   if(checked.needsConfirmation){
    await database.use(db=>db.query('UPDATE strategy_rule_trades SET approval_pending=true WHERE request_id=$1',[job.request_id]));
    // The durable approval is the outcome; the queue/bell sync repairs a lost notice.
    try{await deps.notifications?.record({...await noticeKey(job),tier:'act_now',requiresAction:true,occurredAt:new Date(now()).toISOString(),title:'Rule rebalance ready for review',body:'Review the Coinbase orders for this Take before submitting.'});}catch{/* keep the approval */}
    return;
   }
   await deps.submit(review.id);
  }catch(error){
   if(error instanceof RuleTradeValidationError&&error.reason==='inputs_temporarily_stale')return;
   // Reaching the buy phase means the sell orders already filled.
   if(error instanceof NoCoinbaseOrdersError){await finish(job,'completed',job.phase==='buy'?'filled':'already_on_target');return;}
   // Sells already filled: a blocked buy is a partial rebalance, never a silent stop.
   const blocked=job.phase==='buy'?{state:'attention' as const,reason:'partial_rebalance'}:null;
   if(job.review_id){
    try{
     const current=await deps.view(job.review_id);const closedReason=closedUnfilledReview(current);
     if(closedReason){await finish(job,blocked?.state??'blocked',blocked?.reason??closedReason);return;}
     if(current.orders.some(o=>o.execution&&!['reserved','reviewed'].includes(o.execution.state))){await finish(job,'attention','order_needs_attention');return;}
     // An unconfirmed preview reserved nothing; cancel() discards it. Confirmed reservations are released.
     if(current.state==='preview'||current.state==='confirmed'||current.state==='expired')await deps.cancelPrepared(job.review_id);
    }catch{await finish(job,'attention','review_needs_attention');return;}
   }
   if(blocked){await finish(job,blocked.state,blocked.reason);return;}
   await finish(job,'blocked',error instanceof RuleTradeValidationError?error.reason:'validation_failed',job.phase==='initial'&&!preparationStarted&&error instanceof RuleTradeValidationError);
  }
 }
 return {validateSubmission,enqueue,advance,cancel,tick(signal?:AbortSignal){
  // One failing pass must not reject into the host's execution loop when a reporter is wired.
  if(!work)work=pass(signal).catch(error=>{if(!deps.report)throw error;deps.report(error);}).finally(()=>{work=undefined;});return work;
 }};
}
