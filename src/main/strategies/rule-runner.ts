import {ruleTradeFundingIssue} from './rule-trades';
import {deliverRuleNotifications} from './rule-notifications';
import {pruneRuleHistory,ruleHistoryPolicy} from './rule-retention';
import {evaluateTakeInput} from '../data-sources/take-inputs';
import type {RuleEvents,RuleEventBatch} from '../data-sources/rule-events';
import {createRuleEvidence} from './rule-evidence';
import {createRuleWindows} from './rule-windows';
import {runRuleContext,type ContextValue,type ContextFetch} from './rule-context';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ruleDraftConfig,strategyRule,supportsRuleTrade} from '../../shared/strategy-rules';
import {takeInputsConfigSchema,type TakeInputSnapshot,type TakeInputValue} from '../../shared/take-inputs';
import type {DataFeedRef} from '../../shared/data-sources';
import type {createDatabaseLifecycle} from '../database';
import type {DatabaseClient} from '../database-client';
import {backgroundDatabaseWork} from '../database-client';
import {evaluateRule,initialRuleState,ruleStateSchema,type RuleState} from './rule-evaluator';
type Query=Pick<DatabaseClient,'query'>;
const ruleCounterMax=100000;
export const shadowSetting=z.object({takeId:z.uuid(),draftRevision:z.number().int().positive(),enabled:z.boolean(),delivery:z.enum(['shadow','notifications']).default('shadow')}).strict();
export function createRuleRunner(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,snapshot:(id:string,keys?:string[])=>Promise<TakeInputSnapshot>,demand:(id:string,refs:DataFeedRef[])=>void,allowed:()=>boolean,now=Date.now,onError:()=>void=()=>{},fetchContext?:ContextFetch,events?:RuleEvents,
 /** A request became ready for its action (it may still commit later); wakes action workers. */
 ready?:()=>void){
 let lastCleanup:number|null=null;
 const windows=new Map<string,{revision:number;store:ReturnType<typeof createRuleWindows>}>();
 // Recent sampled condition values, so queued events use the sample current at their own time.
 const samples=new Map<string,Map<string,TakeInputValue[]>>();
 const demanded=new Set<string>(),sessions=new Map<string,string>();let session=randomUUID(),closed=false,work:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined,contextWork:Promise<void>|undefined;let contextAbort=new AbortController();
 async function context(tx:Query,id:string,latest=false){
  const row=(await tx.query<{version:string;draft_revision:number;accepted_version:string;input_revision:number;config:unknown;binding_revision:number|null;binding_version:string|null;bindings:unknown;disabled:string[]}>(`SELECT s.current_version_id AS version,d.revision AS draft_revision,d.accepted_version,d.input_revision,d.config,i.revision AS binding_revision,i.accepted_version AS binding_version,i.config AS bindings,coalesce(a.disabled_rule_ids,'{}') AS disabled
   FROM takes t JOIN strategies s ON s.id=t.strategy_id AND s.owner_id=t.owner_id
   JOIN LATERAL (SELECT * FROM strategy_rule_draft_revisions WHERE take_id=t.id AND ($2 OR revision=(SELECT revision FROM strategy_rule_accepted WHERE take_id=t.id)) ORDER BY revision DESC LIMIT 1) d ON true
   LEFT JOIN LATERAL (SELECT * FROM take_input_revisions WHERE take_id=t.id ORDER BY revision DESC LIMIT 1) i ON true
   LEFT JOIN strategy_rule_accepted a ON a.take_id=t.id AND a.revision=d.revision
   WHERE t.id=$1 AND t.owner_id=(SELECT id FROM local_owners LIMIT 1) AND t.archived_at IS NULL AND s.archived_at IS NULL FOR UPDATE OF t,s`,[id,latest])).rows[0];
  if(!row)return null;
  // A rule switched off is not evaluated; its stored state waits for it unchanged.
  const config=ruleDraftConfig.parse(row.config);
  return {...row,config:{...config,rules:config.rules.filter(rule=>!row.disabled.includes(rule.id))},bindings:row.bindings?takeInputsConfigSchema.parse(row.bindings):{inputs:[],maxSkewMs:5000}};
 }
 // A per-Take failure re-baselines only that Take; suspension replaces the global session.
 const sessionOf=(id:string)=>sessions.get(id)??session;
 // Request rows owned by a live trade job belong to its trade worker (H1): Coinbase working/attention,
 // Robinhood from its approval card on. Each worker's guard re-checks the rule, version and grant every step.
 const tradeOwned="NOT EXISTS(SELECT 1 FROM strategy_rule_trades j WHERE j.request_id=strategy_rule_action_requests.id AND j.state IN ('working','attention')) AND NOT EXISTS(SELECT 1 FROM robinhood_rule_trades h WHERE h.request_id=strategy_rule_action_requests.id AND h.state IN ('awaiting_approval','approved','executing','attention'))";
 const valid=(c:Awaited<ReturnType<typeof context>>,revision:number)=>!!c&&c.draft_revision===revision&&c.accepted_version===c.version&&c.input_revision===c.binding_revision&&c.binding_version===c.version;
 function drop(id:string){events?.sync(id,[]);windows.delete(id);samples.delete(id);demand(id,[]);demanded.delete(id);}
 async function process(id:string,revision:number){
  const config=await database.use(db=>db.transaction(tx=>context(tx,id)));
  if(!valid(config,revision)){drop(id);await invalidate(id,revision);return;}
  const wanted=[...new Set(config!.config.rules.flatMap(rule=>rule.context.length?[rule.trigger.input,...rule.context.flatMap(step=>step.kind==='window'?[step.input]:[])]:[rule.trigger.input,...rule.conditions.all.map(condition=>condition.input)]))];
  demanded.add(id);
  events?.sync(id,config!.config.rules.flatMap(rule=>{
   const binding=config!.bindings.inputs.find(input=>input.key===rule.trigger.input);
   return rule.trigger.kind==='event'&&binding?[{ruleId:rule.id,revision,ref:{sourceId:binding.sourceId,feedId:binding.feedId,configVersion:binding.sourceRevision,schemaVersion:1}}]:[];
  }));
  demand(id,config!.bindings.inputs.filter(input=>wanted.includes(input.key)).map(input=>({sourceId:input.sourceId,feedId:input.feedId,configVersion:input.sourceRevision,schemaVersion:1})));
  const observation=await snapshot(id,wanted);
  const batches=new Map<string,RuleEventBatch|null>(await Promise.all(config!.config.rules.filter(rule=>rule.trigger.kind==='event'&&events).map(async rule=>[rule.id,await events!.read(id,rule.id)] as const)));
  let deliverableEvent=false;
  const committed=await database.use(db=>db.transaction(async tx=>{
   const c=await context(tx,id);
   const enrolled=(await tx.query<{enabled:boolean;draft_revision:number}>('SELECT enabled,draft_revision FROM strategy_rule_shadow WHERE take_id=$1 FOR UPDATE',[id])).rows[0];
   if(!allowed()||closed||!enrolled?.enabled||enrolled.draft_revision!==revision||!valid(c,revision))return false;
   // Enrollment is locked: re-check that every read event is still on this side of re-enrollment.
   for(const batch of batches.values()){const verify=(batch as {verify?:(tx:Query)=>Promise<boolean>}|null)?.verify;if(verify&&!await verify.call(batch,tx))return false;}
   const time=now(),session=sessionOf(id);
   let windowState=windows.get(id);if(!windowState||windowState.revision!==revision){windowState={revision,store:createRuleWindows()};windows.set(id,windowState);}
   // Exact source revisions are fenced alongside state/evidence creation.
   const sources=(await tx.query<{id:string;current_revision:number;enabled:boolean;validated:boolean;collection:string;config:unknown}>(`SELECT s.id,s.current_revision,s.enabled,s.validated,r.config,r.config->>'collection' AS collection FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.owner_id=(SELECT id FROM local_owners LIMIT 1) AND s.id=ANY($1::uuid[]) FOR SHARE OF s`,[c!.bindings.inputs.map(input=>input.sourceId)])).rows;
   const sourceValid=c!.bindings.inputs.every(input=>sources.some(s=>s.id===input.sourceId&&s.current_revision===input.sourceRevision&&s.enabled&&s.validated&&s.collection!=='off'));
   const structural=!sourceValid||observation.acceptedVersion!==c!.version||observation.bindingRevision!==c!.input_revision;
   const checked=sourceValid&&observation.acceptedVersion===c!.version&&observation.bindingRevision===c!.input_revision?observation:{...observation,status:'blocked' as const,reason:'inputs-unavailable' as const};
   if(!sourceValid||observation.acceptedVersion!==c!.version||observation.bindingRevision!==c!.input_revision)windowState.store.clear();
   else for(const input of observation.inputs)if(c!.config.rules.some(rule=>rule.context.some(step=>step.kind==='window'&&step.input===input.binding.key)))windowState.store.observe(input,time);
   const history=samples.get(id)??new Map<string,TakeInputValue[]>();samples.set(id,history);
   if(structural)history.clear();
   else for(const input of observation.inputs){const o=input.observation;if(input.quality!=='fresh'||!o)continue;const list=history.get(input.binding.key)??[],last=list.at(-1)?.observation;
    if(last&&(last.receivedAt>o.receivedAt||last.runtimeId!==o.runtimeId||last.epoch!==o.epoch))list.length=0;
    if(!last||last.receivedAt!==o.receivedAt||list.length===0)list.push(input);
    while(list.length>64||list.length>1&&time-list[0].observation!.receivedAt>300000)list.shift();history.set(input.binding.key,list);}
   await tx.query(`UPDATE strategy_rule_action_requests SET status='expired' WHERE take_id=$1 AND status IN ('shadow','context_pending') AND expires_at<=$2 AND ${tradeOwned}`,[id,new Date(time)]);
   // A temporary freshness lapse must not destroy any trade request (rebalance, deploy cash, reduce) awaiting approval.
   // Submission still revalidates fresh inputs; structural changes invalidate it.
   const transientInputs=sourceValid&&observation.acceptedVersion===c!.version&&observation.bindingRevision===c!.input_revision&&checked.inputs.length>0&&checked.inputs.every(input=>['fresh','stale'].includes(input.quality))&&(checked.reason==='time-skew'||checked.inputs.some(input=>input.quality==='stale'));
   // Context jobs re-verify their own inputs; only structural changes supersede them here.
   if(checked.status!=='ready')await tx.query(`UPDATE strategy_rule_action_requests SET status='superseded' WHERE take_id=$1 AND (status='shadow' AND (NOT $2 OR action->>'kind' NOT IN ('rebalance_to_target','deploy_cash','reduce')) OR status='context_pending' AND $3) AND ${tradeOwned}`,[id,transientInputs,structural]);
   const trading=(await tx.query<{trading_enabled:boolean;trading_rule_ids:string[]}>('SELECT trading_enabled,trading_rule_ids FROM strategy_rule_accepted WHERE take_id=$1 AND revision=$2',[id,revision])).rows[0];
   for(const rule of c!.config.rules){
    if(trading?.trading_enabled&&trading.trading_rule_ids.includes(rule.id)&&supportsRuleTrade(rule)&&'scope' in rule.action){
     const issue=await ruleTradeFundingIssue(tx,id,rule.action.scope.accountId);
     if(issue){
      // Keep the existing edge/cooldown/run state. No firing or allowance is
      // consumed while the selected account has no funded allocation.
      await tx.query(`INSERT INTO strategy_rule_state(take_id,draft_revision,rule_id,state,reason,updated_at) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(take_id,draft_revision,rule_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at`,[id,revision,rule.id,JSON.stringify(initialRuleState(session)),issue,new Date(time)]);
      // Durable events are acknowledged with the explicit funding reason, never as not_evaluated.
      const skipped=batches.get(rule.id);if(skipped)for(const event of skipped.observations)skipped.record?.(event,issue);
      continue;
     }
    }
    const queued=!!events&&rule.trigger.kind==='event',batch=batches.get(rule.id);
    if(queued&&batch&&!batch.gap&&!batch.observations.length)continue;
    for(const event of queued&&batch&&!batch.gap?batch.observations:[null]){
    const stored=(await tx.query<{state:RuleState}>('SELECT state FROM strategy_rule_state WHERE take_id=$1 AND draft_revision=$2 AND rule_id=$3',[id,revision,rule.id])).rows[0]?.state;
    const previous=stored?{...stored,runs:Math.min(stored.runs,ruleCounterMax),...(typeof stored.attempts==='number'?{attempts:Math.min(stored.attempts,ruleCounterMax)}:{})}:initialRuleState(session);
    const pending=(await tx.query("SELECT id FROM strategy_rule_action_requests WHERE take_id=$1 AND draft_revision=$2 AND rule_id=$3 AND status IN ('shadow','context_pending') LIMIT 1",[id,revision,rule.id])).rows.length>0;
    const keys=rule.context.length?[rule.trigger.input]:[rule.trigger.input,...rule.conditions.all.map(condition=>condition.input)];
    const inputs=checked.inputs.filter(input=>keys.includes(input.binding.key)).map(input=>{
     if(!queued||!event)return input;
     // Burst/replayed events: a condition uses the sample that was current at the event's own receipt.
     if(input.binding.key!==rule.trigger.input)return [...(history.get(input.binding.key)??[])].reverse().find(sample=>sample.observation!.receivedAt<=event.receivedAt)??input;
     const source=sources.find(source=>source.id===input.binding.sourceId);
     return evaluateTakeInput(input.binding,source,batch?{...batch.snapshot,latest:event}:null,time);
    });
    const times=inputs.flatMap(input=>input.observation?[input.observation.eventTime??input.observation.receivedAt]:[]);
    const unavailable=queued&&(!batch||batch.gap)||!sourceValid||inputs.length!==new Set(keys).size||inputs.some(input=>input.quality!=='fresh')||observation.acceptedVersion!==c!.version||observation.bindingRevision!==c!.input_revision;
    const skew=times.length&&Math.max(...times)-Math.min(...times)>c!.bindings.maxSkewMs;
    // Trigger freshness stays wall-clock (above); the rule itself is judged at the event's observation time.
    const clock=event?Math.min(time,Math.max(event.receivedAt,...inputs.flatMap(input=>input.observation?[input.observation.receivedAt]:[]))):time;
    const selected={...checked,capturedAt:event?clock:checked.capturedAt,inputs,status:unavailable||skew?'blocked' as const:'ready' as const,reason:unavailable?'inputs-unavailable' as const:skew?'time-skew' as const:null};
    if(batch?.durable&&selected.status==='ready')deliverableEvent=true;
    const oversized=Buffer.byteLength(JSON.stringify(selected))>128000;
    if(oversized){selected.status='blocked';selected.reason='inputs-unavailable';}
    const result=evaluateRule(rule.context.length?{...rule,conditions:{all:[]}}:rule,ruleStateSchema.parse(previous),selected,clock,session,pending,queued);
    if(oversized)result.reason='evidence_size';
    if(queued&&(!batch||batch.gap))result.reason=!batch?'event_queue_unavailable':batch.snapshot.issue==='capacity'?'event_overflow':'event_gap';
    if(result.fire){
     const key=result.eventKey?createHash('sha256').update(result.eventKey).digest('hex'):result.state.attempts<ruleCounterMax?`run:${result.state.attempts+1}`:`run:at:${time}`;
     let capturedWindows:Record<string,ContextValue|string>=Object.fromEntries(rule.context.flatMap(step=>step.kind==='window'?[[step.output,windowState!.store.read(step,time)]]:[]));
     if(Buffer.byteLength(JSON.stringify(capturedWindows))>64000)capturedWindows=Object.fromEntries(Object.keys(capturedWindows).map(key=>[key,'window_capacity']));
     const inserted=await tx.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(take_id,draft_revision,rule_id,firing_key) DO NOTHING RETURNING id`,[randomUUID(),id,revision,rule.id,key,new Date(time),new Date(time+rule.policy.expiresAfterMs),rule.context.length?'context_pending':'shadow',JSON.stringify(rule.action),JSON.stringify({rule,snapshot:selected,evaluatedAt:time,reason:result.reason,delivery:batch?.durable?'durable_event':queued?'queued_event':'sampled_state',windows:capturedWindows})]);
     // Counters saturate at the schema maximum instead of failing every later tick.
     if(inserted.rows.length){result.state.attempts=Math.min(result.state.attempts+1,ruleCounterMax);if(!rule.context.length){result.state.runs=Math.min(result.state.runs+1,ruleCounterMax);ready?.();}result.state.lastFiredAt=clock;}else result.reason='duplicate_event';
    }
    if(event)batch?.record?.(event,result.reason);
    await tx.query(`INSERT INTO strategy_rule_state(take_id,draft_revision,rule_id,state,reason,updated_at) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(take_id,draft_revision,rule_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at`,[id,revision,rule.id,JSON.stringify(result.state),result.reason,new Date(time)]);
   }
   }
   if(!allowed()||closed||[...batches.values()].some(batch=>batch&&!batch.valid()))throw Error('Rule evaluation suspended');
   if(checked.status==='ready'||deliverableEvent)await deliverRuleNotifications(tx,id,revision,time);
   if(!allowed()||closed||[...batches.values()].some(batch=>batch&&!batch.valid()))throw Error('Rule evaluation suspended');
   for(const batch of batches.values())await batch?.commit?.(tx);
   return true;
  }));
  if(committed)for(const batch of batches.values())batch?.ack();
 }
 async function invalidate(id:string,revision:number){await database.use(db=>db.transaction(async tx=>{
  await tx.query('UPDATE strategy_rule_shadow SET enabled=false WHERE take_id=$1 AND draft_revision=$2',[id,revision]);
  await tx.query(`UPDATE strategy_rule_action_requests SET status='superseded' WHERE take_id=$1 AND draft_revision=$2 AND status IN ('shadow','context_pending') AND ${tradeOwned}`,[id,revision]);
 }));}
 async function flush(){
  if(!allowed()){contextAbort.abort();contextAbort=new AbortController();session=randomUUID();sessions.clear();for(const id of [...demanded])drop(id);return;}
  const time=now();if(lastCleanup===null||time<lastCleanup||time-lastCleanup>=ruleHistoryPolicy.intervalMs){await database.use(db=>db.transaction(tx=>pruneRuleHistory(tx,time)));lastCleanup=time;}
  const rows=(await database.use(db=>db.query<{take_id:string;draft_revision:number}>('SELECT take_id,draft_revision FROM strategy_rule_shadow WHERE enabled ORDER BY take_id LIMIT 32'))).rows;
  for(const id of [...demanded])if(!rows.some(row=>row.take_id===id))drop(id);
  for(const id of [...sessions.keys()])if(!rows.some(row=>row.take_id===id))sessions.delete(id);
  for(const row of rows){if(closed||!allowed())break;try{await process(row.take_id,row.draft_revision);}catch{sessions.set(row.take_id,randomUUID());windows.delete(row.take_id);samples.delete(row.take_id);onError();}}
 }
 async function contexts(){
  if(closed||!allowed())return;
  type Job={id:string;take_id:string;draft_revision:number;rule_id:string;expires_at:Date;evidence:{rule:unknown;snapshot:TakeInputSnapshot;evaluatedAt:number;reason:string;windows?:Record<string,ContextValue|string>}};
  const jobs=(await database.use(db=>db.query<Job>("SELECT id,take_id,draft_revision,rule_id,expires_at,evidence FROM strategy_rule_action_requests WHERE status='context_pending' ORDER BY created_at,id LIMIT 4"))).rows;
  for(const job of jobs){
   if(closed||!allowed())break;
   const verify=()=>database.use(db=>db.transaction(async tx=>{
    const c=await context(tx,job.take_id),enrolled=(await tx.query<{enabled:boolean;draft_revision:number}>('SELECT enabled,draft_revision FROM strategy_rule_shadow WHERE take_id=$1',[job.take_id])).rows[0];
    if(!valid(c,job.draft_revision)||!enrolled?.enabled||enrolled.draft_revision!==job.draft_revision||!allowed()||closed)return null;
    const pending=(await tx.query("SELECT id FROM strategy_rule_action_requests WHERE id=$1 AND status='context_pending' AND expires_at>$2",[job.id,new Date(now())])).rows.length;
    if(!pending)return null;
    const sources=(await tx.query<{id:string;current_revision:number;enabled:boolean;validated:boolean;collection:string}>(`SELECT s.id,s.current_revision,s.enabled,s.validated,r.config->>'collection' AS collection FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.id=ANY($1::uuid[])`,[c!.bindings.inputs.map(input=>input.sourceId)])).rows;
    if(!c!.bindings.inputs.every(input=>sources.some(source=>source.id===input.sourceId&&source.current_revision===input.sourceRevision&&source.enabled&&source.validated&&source.collection!=='off')))return null;
    return c;
   }));
   try{
    const c=await verify();
    if(!c){await database.use(db=>db.query("UPDATE strategy_rule_action_requests SET status=CASE WHEN expires_at<=$2 THEN 'expired' ELSE 'superseded' END WHERE id=$1 AND status='context_pending'",[job.id,new Date(now())]));continue;}
    if(now()>=job.expires_at.getTime()){await database.use(db=>db.query("UPDATE strategy_rule_action_requests SET status='expired' WHERE id=$1 AND status='context_pending'",[job.id]));continue;}
    const rule=c.config.rules.find(rule=>rule.id===job.rule_id);if(!rule)throw Error('Rule unavailable');
    const trigger=job.evidence.snapshot.inputs.find(input=>input.binding.key===rule.trigger.input);if(!trigger)throw Error('Trigger unavailable');
    const fetch:ContextFetch=async(binding,freshness,timeout,signal)=>{
     if(!await verify()||!fetchContext)throw Error('Context unavailable');
     return fetchContext(binding,freshness,timeout,signal);
    };
    let result=await runRuleContext(strategyRule.parse(rule),trigger,c.bindings.inputs,fetch,contextAbort.signal,job.expires_at.getTime(),c.bindings.maxSkewMs,now,job.evidence.windows);
    if(result.status==='ready'){
     const recorded=Object.values(result.values).flatMap(value=>value.inputs);
     const latest=await snapshot(job.take_id,[...new Set(recorded.map(input=>input.binding.key))]);
     if(latest.status!=='ready'||recorded.some(input=>!latest.inputs.some(current=>current.binding.key===input.binding.key&&current.quality==='fresh'&&current.observation?.epoch===input.observation?.epoch&&current.observation?.runtimeId===input.observation?.runtimeId)))result={status:'failed',values:{},steps:result.steps,reason:'context_changed'};
    }
    await database.use(db=>db.transaction(async tx=>{
     const current=await context(tx,job.take_id),enrolled=(await tx.query<{enabled:boolean;draft_revision:number}>('SELECT enabled,draft_revision FROM strategy_rule_shadow WHERE take_id=$1 FOR UPDATE',[job.take_id])).rows[0];
     const sources=(await tx.query<{id:string;current_revision:number;enabled:boolean;validated:boolean;collection:string}>(`SELECT s.id,s.current_revision,s.enabled,s.validated,r.config->>'collection' AS collection FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.id=ANY($1::uuid[]) FOR SHARE OF s`,[c.bindings.inputs.map(input=>input.sourceId)])).rows;
     const sourceValid=c.bindings.inputs.every(input=>sources.some(source=>source.id===input.sourceId&&source.current_revision===input.sourceRevision&&source.enabled&&source.validated&&source.collection!=='off'));
     if(result.status==='ready'&&Object.values(result.values).some(value=>value.observedAt>now()||value.receivedAt>now()||now()-value.observedAt>value.maxAgeMs||now()-value.receivedAt>value.maxAgeMs))result={status:'failed',values:{},steps:result.steps,reason:'stale_context'};
     let status=!allowed()||closed||!valid(current,job.draft_revision)||!enrolled?.enabled||enrolled.draft_revision!==job.draft_revision||!sourceValid?'superseded':now()>=job.expires_at.getTime()?'expired':result.status==='ready'?'shadow':result.status==='conditions_false'?'conditions_false':'context_failed';
     let evidence={...job.evidence,context:result};
     if(Buffer.byteLength(JSON.stringify(evidence))>196608){status='context_failed';evidence={...job.evidence,context:{status:'failed',values:{},steps:[],reason:'context_size'}};}
     const updated=await tx.query("UPDATE strategy_rule_action_requests SET status=$2,evidence=$3 WHERE id=$1 AND status='context_pending' RETURNING id",[job.id,status,JSON.stringify(evidence)]);
     if(status==='shadow'&&updated.rows.length)await tx.query(`UPDATE strategy_rule_state SET state=jsonb_set(state,'{runs}',to_jsonb(least((state->>'runs')::int+1,100000))) WHERE take_id=$1 AND draft_revision=$2 AND rule_id=$3`,[job.take_id,job.draft_revision,job.rule_id]);
     if(status==='shadow'&&updated.rows.length){await deliverRuleNotifications(tx,job.take_id,job.draft_revision,now());ready?.();}
     if(!allowed()||closed)throw Error('Rule evaluation suspended');
    }));
   }catch{onError();await database.use(db=>db.query("UPDATE strategy_rule_action_requests SET status='context_failed',evidence=evidence||jsonb_build_object('context',jsonb_build_object('status','failed','reason','context_unavailable')) WHERE id=$1 AND status='context_pending'",[job.id]));}
  }
 }
 function tick(){
  if(closed)return Promise.resolve();
  if(!work)work=backgroundDatabaseWork(flush).catch(onError).finally(()=>{work=undefined;});
  if(!contextWork)contextWork=backgroundDatabaseWork(contexts).catch(onError).finally(()=>{contextWork=undefined;});
  return Promise.all([work,contextWork]).then(()=>{});
 }
 return {
  evidence:createRuleEvidence(database),
  async inspect(raw:unknown){const id=z.uuid().parse(raw);return database.use(db=>db.transaction(async tx=>{
   if(!await context(tx,id))throw Error('Take unavailable');
   const enrollment=(await tx.query<{draft_revision:number;enabled:boolean;notifications_enabled:boolean}>('SELECT draft_revision,enabled,notifications_enabled FROM strategy_rule_shadow WHERE take_id=$1',[id])).rows[0]??null;
   const states=(await tx.query('SELECT draft_revision,rule_id,reason,updated_at FROM strategy_rule_state WHERE take_id=$1 ORDER BY updated_at DESC LIMIT 16',[id])).rows;
   const requests=(await tx.query('SELECT id,draft_revision,rule_id,created_at,expires_at,status FROM strategy_rule_action_requests WHERE take_id=$1 ORDER BY created_at DESC,id LIMIT 20',[id])).rows;
   return {mode:enrollment?.enabled&&enrollment.notifications_enabled?'notifications':'shadow',deliveryEnabled:!!enrollment?.enabled&&enrollment.notifications_enabled,enrollment,states,requests};
  }));},
  async configure(raw:unknown){const setting=shadowSetting.parse(raw);
   await database.use(db=>db.transaction(async tx=>{
    // Only the member-accepted revision can be enrolled; acceptance happens through rule proposals.
    const c=await context(tx,setting.takeId);if(!c||setting.enabled&&(!valid(c,setting.draftRevision)||!c.config.rules.length))throw Error('Rule draft or inputs changed');
    const trading=(await tx.query<{trading_enabled:boolean}>('SELECT trading_enabled FROM strategy_rule_accepted WHERE take_id=$1 AND revision=$2',[setting.takeId,setting.draftRevision])).rows[0]?.trading_enabled??false;
    // Serialize capacity admission across Takes using the owner row.
    await tx.query('SELECT id FROM local_owners FOR UPDATE');
    const others=(await tx.query<{count:number}>('SELECT count(*)::int AS count FROM strategy_rule_shadow WHERE enabled AND take_id<>$1',[setting.takeId])).rows[0].count;
    if(setting.enabled&&others>=32)throw Error('Shadow rule capacity reached');
    await tx.query(`INSERT INTO strategy_rule_shadow(take_id,draft_revision,enabled,notifications_enabled) VALUES($1,$2,$3,$4) ON CONFLICT(take_id) DO UPDATE SET draft_revision=excluded.draft_revision,enabled=excluded.enabled,notifications_enabled=excluded.notifications_enabled,updated_at=now()`,[setting.takeId,setting.draftRevision,setting.enabled||trading,setting.enabled&&setting.delivery==='notifications']);
    await tx.query(`UPDATE strategy_rule_action_requests SET status='superseded' WHERE take_id=$1 AND status IN ('shadow','context_pending') AND (NOT $2 OR action->>'kind'='notify') AND ${tradeOwned}`,[setting.takeId,trading]);
    // Re-enrollment must baseline again without resetting persisted cooldowns/run counts.
    await tx.query(`UPDATE strategy_rule_state SET state=state||'{"baseline":false,"armed":false,"candidateAt":null,"session":""}'::jsonb WHERE take_id=$1 AND (NOT $2 OR rule_id IN (SELECT (r->>'id')::uuid FROM strategy_rule_draft_revisions d,jsonb_array_elements(d.config->'rules') r WHERE d.take_id=$1 AND d.revision=$3 AND r->'action'->>'kind'='notify'))`,[setting.takeId,trading,setting.draftRevision]);
   }));
   if(setting.delivery==='shadow')drop(setting.takeId);return {...setting,mode:setting.delivery,deliveryEnabled:setting.enabled&&setting.delivery==='notifications'};
  },
  tick,start(){if(!closed&&!timer){void tick();timer=setInterval(()=>void tick(),1000);}},
  async close(){closed=true;contextAbort.abort();if(timer)clearInterval(timer);await Promise.all([work,contextWork]);for(const id of [...demanded])drop(id);},
 };
}
