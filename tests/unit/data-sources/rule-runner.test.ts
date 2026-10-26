import {createObservationStorage} from '../../../src/main/data-sources/storage';
import {readRuleEventInbox,journalRuleEventGap} from '../../../src/main/data-sources/event-inbox';
import {createNotifications,type NativeAlert} from '../../../src/main/notifications';
import {coinbaseSourceId,defaultCoinbaseSourceConfig} from '../../../src/shared/coinbase-source';
import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createTakeInputs} from '../../../src/main/data-sources/take-inputs';
import {createRuleDrafts} from '../../../src/main/strategies/rule-drafts';
import {createRuleRunner} from '../../../src/main/strategies/rule-runner';
import {dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import {payloadSchema} from '../../../src/main/data-sources/contracts';
// Trade rules are threshold-only today; the funding skip is exercised by forcing eligibility.
const funding=vi.hoisted(()=>({issue:null as string|null,trade:false}));
vi.mock('../../../src/main/strategies/rule-trades',async original=>{const actual=await original<typeof import('../../../src/main/strategies/rule-trades')>();return {...actual,ruleTradeFundingIssue:async(...args:Parameters<typeof actual.ruleTradeFundingIssue>)=>funding.issue??actual.ruleTradeFundingIssue(...args)};});
vi.mock('../../../src/shared/strategy-rules',async original=>{const actual=await original<typeof import('../../../src/shared/strategy-rules')>();return {...actual,supportsRuleTrade:(rule:Parameters<typeof actual.supportsRuleTrade>[0])=>funding.trade||actual.supportsRuleTrade(rule)};});
async function until(check:()=>Promise<boolean>|boolean,poke?:()=>void){for(let i=0;i<400;i++){if(await check())return;poke?.();await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out');}
import type {DataSnapshot} from '../../../src/shared/data-sources';
async function fixture(event=false,withContext=false,coinbase=false,queued=false,notify=false,durable=false){
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const take=randomUUID(),strategy=randomUUID(),version=randomUUID(),source=coinbase?coinbaseSourceId:randomUUID(),feedId=coinbase?'price:BTC-USD':'price';let now=Date.now(),value='11',eventId='A',allowed=true,epoch=1,stale=false,onRead:(()=>Promise<void>)|null=null;
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
 await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
 const config=coinbase?defaultCoinbaseSourceConfig:{name:'Price',endpoint:'https://example.com/price',collection:'when-open',pollIntervalMs:15000,feeds:[{id:'price',name:'Price',unit:'USD',mapping:event?{kind:'event',fields:{value:{path:['value'],type:'number'},id:{path:['id'],type:'string'}}}:{kind:'metric',valuePath:['value']},storage:{mode:'live',fields:['value'],sampleEveryMs:60000,retentionDays:7}}]};
 await db.transaction(async tx=>{await tx.query('INSERT INTO data_sources(id,owner_id,current_revision,enabled,validated) SELECT $1,id,1,true,true FROM local_owners',[source]);await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,1,$2)',[source,JSON.stringify(config)]);});
 const inputs=createTakeInputs(database,(refs:unknown[])=>refs.map(()=>({quality:stale?'stale':'fresh',connection:'live',issue:null,lastReceivedAt:now,latest:{sourceId:source,feedId,configVersion:1,schemaVersion:1,epoch,unit:'USD',receivedAt:now,eventTime:now,timeBasis:'provider',clockSkewMs:0,origin:'live',adapterId:'fixture',adapterVersion:'1',payload:event?{kind:'event',fields:{value:Number(value),id:eventId}}:{kind:'metric',value}}} as DataSnapshot)),()=>now);
 const initial=await inputs.load(take);await inputs.save({...initial,config:{inputs:[{key:'price',sourceId:source,sourceRevision:1,feedId,field:'value',kind:event?'event':'metric',unit:'USD',maxAgeMs:15000}],maxSkewMs:withContext?10000:1000}});
 const drafts=createRuleDrafts(database,inputs.snapshot);const base=dataSourceThresholdPreset(randomUUID(),'price','10',{kind:'agent',instructions:{format:'prompt',text:'Review this event'},capabilities:{tools:[],accountIds:[],actions:['request_review']},budget:{maxDurationMs:1000,maxToolCalls:1,maxCostUsd:'1'}});
 const rule={...base,...(notify?{action:{kind:'notify' as const,message:'Price crossed the threshold'}}:{}),context:withContext?[{kind:'fetch' as const,input:'price',output:'other',freshness:'next' as const,timeoutMs:1000},{kind:'derive' as const,operation:'difference' as const,inputs:['price','other'],output:'spread'}]:[],conditions:withContext?{all:[{kind:'numeric' as const,input:'spread',operator:'gt' as const,value:'1'}]}:base.conditions,trigger:event?{kind:'event' as const,input:'price',eventIdField:'id',equals:1}:base.trigger,policy:{...base.policy,maxRuns:10,cooldownMs:0,expiresAfterMs:withContext?10000:1000}};
 const draft=await drafts.save({...await drafts.load(take),config:{schemaVersion:1,rules:[rule]}});
 const queue:import('../../../src/shared/data-sources').DataObservation[]=[];let queueVersion=0,gap=false;
 const events={sync:vi.fn((_take:string,subscriptions:unknown[])=>{if(!subscriptions.length){queue.length=0;queueVersion++;}}),read:()=>{const version=queueVersion,observations=gap?[]:queue.slice(0,8);return {gap,observations,snapshot:{quality:gap?'gap' as const:'fresh' as const,connection:'live' as const,latest:queue.at(-1)??null,lastReceivedAt:now,issue:gap?'capacity' as const:null},valid:()=>version===queueVersion,ack:()=>{if(version!==queueVersion)return false;queue.splice(0,gap?queue.length:observations.length);gap=false;queueVersion++;return true;}};}};
 const ready=vi.fn(),demand=vi.fn(),errors=vi.fn(),fetch=vi.fn(async(binding)=>{const value=(await inputs.snapshot(take,[binding.key])).inputs[0];return {...value,value:'7',observation:{...value.observation!,payload:{kind:'metric' as const,value:'7'}}};});const make=()=>{const created=createRuleRunner(database,inputs.snapshot,demand,()=>allowed,()=>now,errors,fetch,durable?{sync:vi.fn(),read:async(_take,ruleId)=>{const revision=(await db.query<{draft_revision:number}>('SELECT draft_revision FROM strategy_rule_shadow WHERE take_id=$1',[take])).rows[0]?.draft_revision??draft.revision;const batch=await readRuleEventInbox(db,take,revision,ruleId);const hook=onRead;onRead=null;await hook?.();return batch;}}:queued?events:undefined,ready);
  // configure() enrolls only the accepted revision; shadow-mode enables in these fixtures stand for member acceptance.
  const configure=created.configure;return Object.assign(created,{configure:async(raw:any)=>{if(raw.enabled&&(raw.delivery??'shadow')==='shadow')await accept(raw.draftRevision);return configure(raw);}});};
 const accept=(revision:number)=>db.query('INSERT INTO strategy_rule_accepted(take_id,revision) VALUES($1,$2) ON CONFLICT(take_id) DO UPDATE SET trading_rule_ids=CASE WHEN strategy_rule_accepted.revision=excluded.revision THEN strategy_rule_accepted.trading_rule_ids ELSE ARRAY[]::uuid[] END,trading_enabled=strategy_rule_accepted.trading_enabled AND strategy_rule_accepted.revision=excluded.revision,revision=excluded.revision',[take,revision]);let runner=make();
 const step=async(next:string,id='A')=>{now+=2000;value=next;eventId=id;await runner.tick();};
 return {ready,db,database,advance:(ms:number)=>{now+=ms;},time:()=>now,runner,fetch,draft,queue,overflow:()=>{gap=true;queueVersion++;},emit:async(next:string,id:string)=>{if(durable)now=Math.max(now+1,Date.now()+1);value=next;eventId=id;const o=(await inputs.snapshot(take)).inputs[0].observation!;if(durable){const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;const storage=createObservationStorage(database,{automatic:false,now:()=>now});storage.enqueue(owner,{...o,adapterId:'custom-http'});await storage.close();}else queue.push(o);},epoch:(value:number)=>{epoch=value;},take,source,demand,errors,step,drafts,rule,allowed:(v:boolean)=>{allowed=v;},accept,inputs,onRead:(hook:()=>Promise<void>)=>{onRead=hook;},snapshot:inputs.snapshot,stale:(v:boolean)=>{stale=v;},owner:async()=>(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id,restart:async()=>{await runner.close();runner=make();return runner;},close:async()=>{await runner.close();await db.close();}};
}
test('shadow firing is atomic, deduplicated, restart-safe and creates no agent run; unapproved drafts preserve accepted enrollment',async()=>{
 const f=await fixture();try{
  await f.runner.tick();expect(f.demand).not.toHaveBeenCalled();
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});await f.step('11');
  // Fail state advancement after request insertion: the transaction must roll back both.
  await f.db.exec("CREATE FUNCTION fixture_fail_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fixture_fail_state BEFORE INSERT OR UPDATE ON strategy_rule_state FOR EACH ROW EXECUTE FUNCTION fixture_fail_state();");
  await f.step('9');expect(f.errors).toHaveBeenCalledTimes(1);expect((await f.db.query('SELECT * FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  await f.db.exec('DROP TRIGGER fixture_fail_state ON strategy_rule_state;');
  await f.step('9');await f.step('11');await f.step('9');await f.step('9');
  let requests=(await f.db.query<{status:string;action:{kind:string};evidence:unknown}>('SELECT status,action,evidence FROM strategy_rule_action_requests')).rows;
  expect(requests).toHaveLength(1);expect(requests[0].action.kind).toBe('agent');expect(requests[0].evidence).toBeTruthy();
  const restarted=await f.restart();await f.step('9');expect((await f.db.query('SELECT * FROM strategy_rule_action_requests')).rows).toHaveLength(1);
  await f.step('11');await f.step('9');expect((await f.db.query('SELECT * FROM strategy_rule_action_requests')).rows).toHaveLength(2);
  f.allowed(false);await f.step('11');expect(f.demand).toHaveBeenLastCalledWith(f.take,[]);f.allowed(true);await f.step('9');expect((await f.db.query('SELECT * FROM strategy_rule_action_requests')).rows).toHaveLength(2);
  await f.drafts.save({...f.draft,config:{schemaVersion:1,rules:[{...f.rule,name:'Edited'}]}});await f.step('11');
  expect((await restarted.inspect(f.take)).enrollment).toMatchObject({enabled:true,draft_revision:f.draft.revision});
  expect((await f.db.query('SELECT * FROM take_runs')).rows).toHaveLength(0);
 }finally{await f.close();}
});
test('a firing wakes action workers; a non-firing evaluation does not',async()=>{
 const f=await fixture();try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});await f.step('11');
  expect(f.ready).not.toHaveBeenCalled();
  await f.step('9');expect((await f.db.query('SELECT 1 FROM strategy_rule_action_requests')).rows).toHaveLength(1);expect(f.ready).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
});
test('event firing IDs deduplicate replay beyond the immediately previous sample',async()=>{
 const f=await fixture(true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('0','A');await f.step('1','B');await f.step('0','C');await f.step('1','B');
  expect((await f.db.query('SELECT * FROM strategy_rule_action_requests')).rows).toHaveLength(1);
  expect((await f.runner.inspect(f.take)).states[0]).toMatchObject({reason:'duplicate_event'});
  await f.db.query('UPDATE data_sources SET enabled=false WHERE id=$1',[f.source]);await f.step('1','D');
  expect((await f.db.query('SELECT * FROM strategy_rule_action_requests')).rows).toHaveLength(1);expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('conditional context fetch runs only after a trigger and records derived evidence without an agent call',async()=>{
 const f=await fixture(false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');expect(f.fetch).not.toHaveBeenCalled();
  await f.step('9');await f.step('9');
  const rows=(await f.db.query<{status:string;evidence:any}>('SELECT status,evidence FROM strategy_rule_action_requests')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].status).toBe('shadow');expect(rows[0].evidence.context.values.spread.value).toBe('2');expect(f.fetch).toHaveBeenCalledTimes(1);
  await f.step('9');expect(f.fetch).toHaveBeenCalledTimes(1);expect((await f.db.query('SELECT * FROM take_runs')).rows).toHaveLength(0);expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});
test('accepting a rule while a conditional fetch runs supersedes its request',async()=>{
 const f=await fixture(false,true);try{
  const read=f.fetch.getMockImplementation()!;f.fetch.mockImplementationOnce(async binding=>{const accepted=await f.drafts.save({...f.draft,config:{schemaVersion:1,rules:[{...f.rule,name:'Edited during fetch'}]}});await f.runner.configure({takeId:f.take,draftRevision:accepted.revision,enabled:true});return read(binding);});
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');await f.step('9');
  expect((await f.db.query('SELECT status FROM strategy_rule_action_requests')).rows).toEqual([{status:'superseded'}]);
 }finally{await f.close();}
});
test('false context conditions do not consume successful-run limits or reuse firing identity',async()=>{
 const f=await fixture(false,true);try{
  const draft=await f.drafts.save({...f.draft,config:{schemaVersion:1,rules:[{...f.rule,policy:{...f.rule.policy,maxRuns:1}}]}});
  const read=f.fetch.getMockImplementation()!;f.fetch.mockImplementationOnce(async binding=>{const value=await read(binding);return {...value,value:'10',observation:{...value.observation!,payload:{kind:'metric',value:'10'}}};});
  await f.runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:true});await f.step('11');await f.step('9');await f.step('9');
  expect((await f.db.query('SELECT status FROM strategy_rule_action_requests')).rows).toEqual([{status:'conditions_false'}]);
  expect((await f.db.query<{state:any}>('SELECT state FROM strategy_rule_state')).rows[0].state.runs).toBe(0);
  await f.step('11');await f.step('9');await f.step('9');
  expect((await f.db.query('SELECT status,firing_key FROM strategy_rule_action_requests ORDER BY created_at')).rows).toEqual([{status:'conditions_false',firing_key:'run:1'},{status:'shadow',firing_key:'run:2'}]);
  expect((await f.db.query<{state:any}>('SELECT state FROM strategy_rule_state')).rows[0].state.runs).toBe(1);expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('context cannot bridge a connection epoch change even when it refetches the trigger input',async()=>{
 const f=await fixture(false,true);try{
  const read=f.fetch.getMockImplementation()!;f.fetch.mockImplementationOnce(async binding=>{f.epoch(2);return read(binding);});
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');await f.step('9');
  const row=(await f.db.query<{status:string;evidence:any}>('SELECT status,evidence FROM strategy_rule_action_requests')).rows[0];
  expect(row.status).toBe('context_failed');expect(row.evidence.context.reason).toBe('context_changed');
 }finally{await f.close();}
});

test('rolling windows warm before triggers and freeze evidence before later observations',async()=>{
 const f=await fixture(false,true);try{
  const rule={...f.rule,context:[{kind:'window' as const,input:'price',output:'average',operation:'mean' as const,windowMs:4000,minSamples:3,maxGapMs:2000}],conditions:{all:[{kind:'numeric' as const,input:'average',operator:'gt' as const,value:'9'}]}};
  const draft=await f.drafts.save({...f.draft,config:{schemaVersion:1,rules:[rule]}});
  await f.runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:true});
  await f.step('11');await f.step('11');await f.step('9');await f.step('100');
  const rows=(await f.db.query<{status:string;evidence:any}>('SELECT status,evidence FROM strategy_rule_action_requests')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].status).toBe('shadow');
  expect(rows[0].evidence.context.values.average.value).toBe('10.333333333333333333333333333333333333');
  expect(rows[0].evidence.context.values.average.window.end).toBe(rows[0].evidence.evaluatedAt);
  expect(f.fetch).not.toHaveBeenCalled();expect(f.errors).not.toHaveBeenCalled();
  const runner=await f.restart();await runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:true});
  await f.step('11');await f.step('9');await f.step('9');
  const next=(await f.db.query<{status:string;evidence:any}>('SELECT status,evidence FROM strategy_rule_action_requests ORDER BY created_at')).rows;
  expect(next[1].status).toBe('context_failed');expect(next[1].evidence.context.reason).toBe('window_warming');
 }finally{await f.close();}
});

test('evidence reads expose frozen context and paginate tied timestamps without executing work',async()=>{
 const f=await fixture(false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');await f.step('9');
  const original=(await f.db.query<{id:string}>('SELECT id FROM strategy_rule_action_requests')).rows[0].id;
  for(const id of ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'])await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence)
   SELECT $1::uuid,take_id,draft_revision,rule_id,$1::uuid::text,created_at,expires_at,status,action,evidence FROM strategy_rule_action_requests WHERE id=$2`,[id,original]);
  const expected=(await f.db.query<{id:string}>('SELECT id FROM strategy_rule_action_requests ORDER BY created_at DESC,id DESC')).rows.map(row=>row.id);
  const first=await f.runner.evidence({action:'rule-evidence-list',takeId:f.take,limit:2});
  if(!('items' in first))throw Error('Expected page');
  expect(first.items.map(item=>item.id)).toEqual(expected.slice(0,2));expect(first.next).not.toBeNull();
  expect(first.items[0]).toMatchObject({action_kind:'agent',context_status:'ready',context_reason:null});
  expect(first.items[0]).not.toHaveProperty('evidence');expect(first.items[0]).not.toHaveProperty('action');
  const second=await f.runner.evidence({action:'rule-evidence-list',takeId:f.take,limit:2,before:first.next});
  if(!('items' in second))throw Error('Expected page');expect(second.items.map(item=>item.id)).toEqual(expected.slice(2));expect(second.next).toBeNull();
  const detail=await f.runner.evidence({action:'rule-evidence-read',takeId:f.take,requestId:original});
  expect(detail).toMatchObject({mode:'shadow',deliveryEnabled:false,request:{id:original,evidence:{context:{values:{spread:{value:'2'}}}}}});
  expect(f.fetch).toHaveBeenCalledTimes(1);expect((await f.db.query('SELECT * FROM take_runs')).rows).toHaveLength(0);
 }finally{await f.close();}
});

test('evidence access is scoped to its owned Take, bounded, and remains available after archival',async()=>{
 const f=await fixture(false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');await f.step('9');
  const requestId=(await f.db.query<{id:string}>('SELECT id FROM strategy_rule_action_requests')).rows[0].id;
  const other=randomUUID(),otherStrategy=randomUUID();await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[otherStrategy]);
  await f.db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Other','{}',$2 FROM local_owners",[other,otherStrategy]);
  await expect(f.runner.evidence({action:'rule-evidence-read',takeId:other,requestId})).rejects.toThrow('Rule history unavailable');
  await expect(f.runner.evidence({action:'rule-evidence-list',takeId:randomUUID()})).rejects.toThrow('Rule history unavailable');
  for(const limit of [0,51,1.5])await expect(f.runner.evidence({action:'rule-evidence-list',takeId:f.take,limit})).rejects.toThrow();
  await expect(f.runner.evidence({action:'rule-evidence-read',takeId:f.take,requestId,execute:true})).rejects.toThrow();
  await f.db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[f.take]);
  expect(await f.runner.evidence({action:'rule-evidence-read',takeId:f.take,requestId})).toMatchObject({request:{id:requestId}});
  expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('Coinbase market bindings validate and drive the same shadow evaluator with source revision fencing',async()=>{
 const f=await fixture(false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');
  expect(f.demand).toHaveBeenLastCalledWith(f.take,[{sourceId:coinbaseSourceId,feedId:'price:BTC-USD',configVersion:1,schemaVersion:1}]);
  const row=(await f.db.query<{evidence:any}>('SELECT evidence FROM strategy_rule_action_requests')).rows[0];
  expect(row.evidence.snapshot.inputs[0]).toMatchObject({quality:'fresh',value:'9',binding:{sourceId:coinbaseSourceId,feedId:'price:BTC-USD'}});
  await f.db.query('UPDATE data_sources SET enabled=false WHERE id=$1',[coinbaseSourceId]);await f.step('11');await f.step('9');
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('queued events catch an intermediate match, acknowledge only after commit and deduplicate replay',async()=>{
 const f=await fixture(true,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});
  await f.emit('0','A');await f.emit('1','B');await f.emit('0','C');
  await f.db.exec("CREATE FUNCTION fixture_fail_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fixture_fail_queue BEFORE INSERT OR UPDATE ON strategy_rule_state FOR EACH ROW EXECUTE FUNCTION fixture_fail_queue();");
  await f.step('0','C');expect(f.queue).toHaveLength(3);expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  await f.db.exec('DROP TRIGGER fixture_fail_queue ON strategy_rule_state');await f.step('0','C');
  expect(f.queue).toHaveLength(0);
  const rows=(await f.db.query<{evidence:any}>('SELECT evidence FROM strategy_rule_action_requests')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].evidence.delivery).toBe('queued_event');expect(rows[0].evidence.snapshot.inputs[0].observation.payload.fields.id).toBe('B');
  await f.emit('1','B');await f.step('1','B');expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
  expect((await f.runner.inspect(f.take)).states[0]).toMatchObject({reason:'duplicate_event'});expect(f.errors).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
});

test('queued overflow blocks a batch; a new live event after the gap may fire, and restart drops memory backlog',async()=>{
 const f=await fixture(true,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.emit('1','lost');f.overflow();await f.step('1','lost');
  expect((await f.runner.inspect(f.take)).states[0]).toMatchObject({reason:'event_overflow'});expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  await f.emit('1','new');await f.step('1','new');expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
  await f.emit('1','offline');await f.restart();expect(f.queue).toHaveLength(0);await f.step('1','offline');
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
  await f.emit('1','stale');f.queue[0].eventTime!-=20000;await f.step('1','stale');
  expect(f.queue).toHaveLength(0);expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
 }finally{await f.close();}
});

test('shadow firing continues beyond one thousand retained records',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence)
   SELECT gen_random_uuid(),$1,1,$2,'fixture:'||n,now(),now(),'expired','{}','{}' FROM generate_series(1,1001) n`,[f.take,f.rule.id]);
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');
  expect((await f.db.query<{count:number}>('SELECT count(*)::int AS count FROM strategy_rule_action_requests')).rows[0].count).toBe(1002);
  expect((await f.runner.inspect(f.take)).states[0]).toMatchObject({reason:'fired'});expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});

 test('notification mode delivers a threshold match to the inbox and native adapter once, preserves cooldown and restart state',async()=>{
 const f=await fixture(false,false,false,false,true);let notifications:ReturnType<typeof createNotifications>|undefined;
 try{
  const draft=await f.drafts.save({...f.draft,config:{schemaVersion:1,rules:[{...f.rule,policy:{...f.rule.policy,cooldownMs:10000}}]}});
  await f.runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:true});
  await f.runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:true,delivery:'notifications'});
  await f.step('11');await f.step('9');await f.step('9');
  expect((await f.db.query('SELECT status FROM strategy_rule_action_requests')).rows).toEqual([{status:'notified'}]);
  const alerts:NativeAlert[]=[];notifications=createNotifications(f.database,{now:f.time,deliver:a=>alerts.push(a),badge:()=>{},openDesktop:()=>{}});
  await notifications.tick();const page=await notifications.list();expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({kind:'rule_notification',body:'Price crossed the threshold'});
  expect(await notifications.target(page.items[0].id)).toEqual({type:'take',takeId:f.take});expect(alerts).toHaveLength(1);
  await f.step('11');await f.step('9');expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(1);
  const runner=await f.restart();await f.step('9');await notifications.tick();expect(alerts).toHaveLength(1);
  await f.step('11');await f.step('9');expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(2);
  await runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:false,delivery:'notifications'});
  await f.step('11');await f.step('9');expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(2);
  expect(f.errors).not.toHaveBeenCalled();expect((await f.db.query('SELECT id FROM take_runs')).rows).toHaveLength(0);
 }finally{await notifications?.stop();await f.close();}
});
test('preview matches are not delivered retroactively and stale sources cannot notify',async()=>{
 const f=await fixture(false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');await f.step('9');
  expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(0);
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true,delivery:'notifications'});
  await f.step('9');expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(0);
  await f.step('11');await f.db.query('UPDATE data_sources SET enabled=false WHERE id=$1',[f.source]);await f.step('9');
  expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(0);expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});
test('notification mode leaves agent actions in shadow and rejects an unaccepted revision',async()=>{
 const f=await fixture();try{
  await expect(f.runner.configure({takeId:f.take,draftRevision:1,enabled:true,delivery:'notifications'})).rejects.toThrow();
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true,delivery:'notifications'});
  await f.step('11');await f.step('9');expect((await f.db.query('SELECT status FROM strategy_rule_action_requests')).rows).toEqual([{status:'shadow'}]);expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(0);
 }finally{await f.close();}
});
test('notification insertion failure rolls back decision and state; a later valid crossing delivers once',async()=>{
 const f=await fixture(false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true,delivery:'notifications'});
  await f.step('11');await f.db.exec("CREATE FUNCTION fail_rule_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$; CREATE TRIGGER fail_rule_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fail_rule_notice();");
  await f.step('9');expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  await f.db.exec('DROP TRIGGER fail_rule_notice ON notifications;');await f.step('11');await f.step('9');await f.step('9');expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(1);
 }finally{await f.close();}
});
test('conditional notification waits for successful context and event duplicates do not redeliver',async()=>{
 const f=await fixture(false,true,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true,delivery:'notifications'});
  await f.step('11');await f.step('9');await f.step('9');expect((await f.db.query('SELECT status FROM strategy_rule_action_requests')).rows).toEqual([{status:'notified'}]);expect((await f.db.query('SELECT id FROM notifications')).rows).toHaveLength(1);
 }finally{await f.close();}
 const e=await fixture(true,false,false,false,true);try{
  await e.runner.configure({takeId:e.take,draftRevision:1,enabled:true});await e.runner.configure({takeId:e.take,draftRevision:1,enabled:true,delivery:'notifications'});
  await e.step('0','A');await e.step('1','B');await e.step('0','C');await e.step('1','B');expect((await e.db.query('SELECT id FROM notifications')).rows).toHaveLength(1);
 }finally{await e.close();}
});


test('durable event inbox survives runner restart and acknowledges atomically with firing',async()=>{
 const f=await fixture(true,false,false,false,false,true);
 try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  await f.emit('1','persisted');
  expect((await f.db.query('SELECT id FROM strategy_rule_event_inbox WHERE handled_at IS NULL')).rows).toHaveLength(1);
  const restarted=await f.restart();
  await f.db.exec("CREATE FUNCTION fixture_fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fixture_fail_inbox BEFORE UPDATE ON strategy_rule_event_inbox FOR EACH ROW EXECUTE FUNCTION fixture_fail_inbox();");
  await restarted.tick();
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  expect((await f.db.query('SELECT id FROM strategy_rule_event_inbox WHERE handled_at IS NULL')).rows).toHaveLength(1);
  await f.db.exec('DROP TRIGGER fixture_fail_inbox ON strategy_rule_event_inbox');
  await restarted.tick();await restarted.tick();
  const requests=(await f.db.query<{evidence:{delivery:string}}>('SELECT evidence FROM strategy_rule_action_requests')).rows;
  expect(requests).toHaveLength(1);expect(requests[0].evidence.delivery).toBe('durable_event');
  expect((await f.db.query('SELECT id FROM strategy_rule_event_inbox WHERE handled_at IS NULL')).rows).toHaveLength(0);
  await f.emit('1','persisted');await restarted.tick();
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
 }finally{await f.close();}
});


test('durable replay records stale events without firing an action',async()=>{
 const f=await fixture(true,false,false,false,false,true);
 try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  await f.emit('1','too-old');f.advance(16000);
  await (await f.restart()).tick();
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  expect((await f.db.query('SELECT id FROM strategy_rule_event_inbox WHERE handled_at IS NULL')).rows).toHaveLength(0);
  expect((await f.db.query<{reason:string}>('SELECT reason FROM strategy_rule_state')).rows[0].reason).toBe('inputs_unavailable');
  expect((await f.db.query<{outcome:string}>('SELECT outcome FROM strategy_rule_event_inbox')).rows[0].outcome).toBe('inputs_unavailable');
 }finally{await f.close();}
});

const pendingInbox=async(f:Awaited<ReturnType<typeof fixture>>)=>(await f.db.query<{receipt:string;outcome:string|null;observation:any}>('SELECT receipt,outcome,observation FROM strategy_rule_event_inbox WHERE handled_at IS NULL ORDER BY id')).rows;
const ruleReason=async(f:Awaited<ReturnType<typeof fixture>>)=>(await f.db.query<{reason:string}>('SELECT reason FROM strategy_rule_state WHERE take_id=$1',[f.take])).rows[0]?.reason;

test('inbox capacity drops with one overflow marker instead of failing shared storage; it reports event_overflow',async()=>{
 const f=await fixture(true,false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  await f.db.query(`INSERT INTO strategy_rule_event_inbox(take_id,draft_revision,rule_id,receipt,observation,received_at) SELECT $1,$2,$3,md5(n::text),'{}',now() FROM generate_series(1,10000) n`,[f.take,f.draft.revision,f.rule.id]);
  // emit() closes its storage queue, which rejects if the shared transaction failed.
  await f.emit('1','dropped-1');await f.emit('1','dropped-2');
  const markers=(await f.db.query<{observation:any}>("SELECT observation FROM strategy_rule_event_inbox WHERE receipt LIKE 'overflow:%' AND handled_at IS NULL")).rows;
  expect(markers).toHaveLength(1);expect(markers[0].observation.marker).toEqual({kind:'overflow',dropped:2});
  expect((await f.db.query<{count:number}>('SELECT count(*)::int AS count FROM strategy_rule_event_inbox WHERE handled_at IS NULL')).rows[0].count).toBe(10001);
  await f.db.query("UPDATE strategy_rule_event_inbox SET handled_at=now(),outcome='fixture' WHERE receipt NOT LIKE 'overflow:%'");
  await f.runner.tick();
  expect(await ruleReason(f)).toBe('event_overflow');expect(await pendingInbox(f)).toHaveLength(0);
  expect((await f.db.query("SELECT outcome FROM strategy_rule_event_inbox WHERE receipt LIKE 'overflow:%'")).rows).toEqual([{outcome:'event_overflow'}]);
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
 }finally{await f.close();}
});

test('NUL payloads are rejected at the contract and reported to durable rules as event_gap',async()=>{
 expect(payloadSchema.safeParse({kind:'text',value:'a\u0000b'}).success).toBe(false);
 expect(payloadSchema.safeParse({kind:'event',fields:{id:'a\u0000'}}).success).toBe(false);
 expect(payloadSchema.safeParse({kind:'event',fields:{'k\u0000':1}}).success).toBe(false);
 const f=await fixture(true,false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  await f.emit('0','warmup');await f.runner.tick();
  const storage=createObservationStorage(f.database,{automatic:false,now:f.time});
  const o=(await f.snapshot(f.take)).inputs[0].observation!;
  expect(storage.enqueue(await f.owner(),{...o,adapterId:'custom-http',payload:{kind:'event',fields:{value:1,id:'bad\u0000id'}}})).toBe(false);
  await storage.flush();expect(storage.status()).toEqual({pending:0,failed:false});
  expect((await pendingInbox(f)).map(row=>row.observation.marker)).toEqual([{kind:'gap',dropped:1}]);
  await f.runner.tick();expect(await ruleReason(f)).toBe('event_gap');expect(await pendingInbox(f)).toHaveLength(0);
  await storage.close();
 }finally{await f.close();}
});

test('an item that cannot persist is quarantined after a failed batch; later items and other storage continue',async()=>{
 const f=await fixture(true,false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  await f.emit('0','warmup');await f.runner.tick();
  await f.db.exec("CREATE FUNCTION fixture_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.observation->'payload'->'fields'->>'id'='poison' THEN RAISE EXCEPTION 'poison'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_poison BEFORE INSERT ON strategy_rule_event_inbox FOR EACH ROW EXECUTE FUNCTION fixture_poison();");
  const storage=createObservationStorage(f.database,{automatic:false,now:f.time}),owner=await f.owner();
  const o=(await f.snapshot(f.take)).inputs[0].observation!;
  expect(storage.enqueue(owner,{...o,adapterId:'custom-http',payload:{kind:'event',fields:{value:1,id:'poison'}}})).toBe(true);
  expect(storage.enqueue(owner,{...o,adapterId:'custom-http',payload:{kind:'event',fields:{value:1,id:'good'}}})).toBe(true);
  await expect(storage.flush()).rejects.toThrow('Data source storage unavailable');expect(storage.status()).toEqual({pending:2,failed:true});
  await storage.flush();expect(storage.status()).toEqual({pending:0,failed:false});expect(storage.diagnostics().quarantined).toBe(1);
  // The later good item for the same feed committed: the feed no longer reports quarantine.
  expect(storage.quarantinedFeed(o)).toBe(0);
  const rows=await pendingInbox(f);expect(rows.map(row=>row.observation.payload?.fields.id??row.observation.marker.kind)).toEqual(['good','gap']);
  await f.runner.tick();expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
  await f.runner.tick();expect(await ruleReason(f)).toBe('event_gap');
  await storage.close();
 }finally{await f.close();}
});

test('one failing Take re-baselines only itself; saturated counters and unrelated large inputs do not fail ticks',async()=>{
 const f=await fixture();try{
  const other=randomUUID(),strategy=randomUUID(),version=randomUUID();
  await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await f.db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
  await f.db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
  await f.db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,owner_id,'Other','{}',$3 FROM takes WHERE id=$2",[other,f.take,strategy]);
  await f.db.query('INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) SELECT $1,revision,$3,config FROM take_input_revisions WHERE take_id=$2',[other,f.take,version]);
  await f.db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) SELECT $1,revision,$3,input_revision,config FROM strategy_rule_draft_revisions WHERE take_id=$2',[other,f.take,version]);
  await f.db.query('INSERT INTO strategy_rule_accepted(take_id,revision) VALUES($1,$2)',[other,f.draft.revision]);
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});await f.runner.configure({takeId:other,draftRevision:f.draft.revision,enabled:true});
  await f.step('11');await f.step('11');
  const session=async(take:string)=>(await f.db.query<{state:{session:string}}>('SELECT state FROM strategy_rule_state WHERE take_id=$1',[take])).rows[0].state.session;
  const before=await session(other);expect(await session(f.take)).toBe(before);
  await f.db.exec(`CREATE FUNCTION fixture_fail_take() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.take_id='${f.take}' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fail_take BEFORE INSERT OR UPDATE ON strategy_rule_state FOR EACH ROW EXECUTE FUNCTION fixture_fail_take();`);
  await f.step('11');expect(f.errors).toHaveBeenCalledTimes(1);
  await f.db.exec('DROP TRIGGER fixture_fail_take ON strategy_rule_state');await f.step('11');
  expect(await session(other)).toBe(before);expect(await session(f.take)).not.toBe(before);
  // A legacy over-limit attempts counter saturates instead of failing schema parsing every tick.
  await f.db.query(`UPDATE strategy_rule_state SET state=state||'{"attempts":150000,"runs":3}'::jsonb WHERE take_id=$1`,[f.take]);
  await f.step('9');
  const fired=(await f.db.query<{firing_key:string}>('SELECT firing_key FROM strategy_rule_action_requests WHERE take_id=$1',[f.take])).rows;
  expect(fired).toHaveLength(1);expect(fired[0].firing_key).toMatch(/^run:at:/);
  expect((await f.db.query<{state:any}>('SELECT state FROM strategy_rule_state WHERE take_id=$1',[f.take])).rows[0].state).toMatchObject({attempts:100000,runs:4});
  expect(f.errors).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
 const g=await fixture();try{
  await g.runner.configure({takeId:g.take,draftRevision:g.draft.revision,enabled:true});await g.runner.close();
  const errors=vi.fn();
  const runner=createRuleRunner(g.database,async(id,keys)=>{const s=await g.snapshot(id,keys);return {...s,inputs:[...s.inputs,{...s.inputs[0],binding:{...s.inputs[0].binding,key:'unused'},value:'x'.repeat(130000)}]};},vi.fn(),()=>true,g.time,errors);
  try{await g.step('11');await runner.tick();await g.step('9');await runner.tick();}finally{await runner.close();}
  expect(errors).not.toHaveBeenCalled();expect((await g.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(1);
 }finally{await g.db.close();}
});

test('stale sampled inputs do not supersede an in-flight context job',async()=>{
 const f=await fixture(false,true);try{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const read=f.fetch.getMockImplementation()!;f.fetch.mockImplementationOnce(async binding=>{await gate;return read(binding);});
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');
  const status=async()=>(await f.db.query<{status:string}>('SELECT status FROM strategy_rule_action_requests')).rows[0]?.status;
  void f.step('9');
  await until(()=>f.fetch.mock.calls.length>0,()=>{void f.runner.tick();});
  expect(await status()).toBe('context_pending');
  f.stale(true);f.advance(2000);
  await until(async()=>await ruleReason(f)==='inputs_unavailable',()=>{void f.runner.tick();});
  expect(await status()).toBe('context_pending');
  release();await until(async()=>await status()!=='context_pending');
  expect(await status()).not.toBe('superseded');
 }finally{await f.close();}
});

test('funding gaps acknowledge durable events with the explicit funding reason',async()=>{
 const f=await fixture(true,false,false,false,false,true);try{
  await f.db.query(`INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) SELECT take_id,2,accepted_version,input_revision,jsonb_set(config,'{rules,0,action}',$2::jsonb) FROM strategy_rule_draft_revisions WHERE take_id=$1 AND revision=1`,[f.take,JSON.stringify({kind:'rebalance_to_target',scope:{accountId:randomUUID()}})]);
  await f.runner.configure({takeId:f.take,draftRevision:2,enabled:true});
  await f.db.query('UPDATE strategy_rule_accepted SET trading_enabled=true,trading_rule_ids=ARRAY[$2::uuid] WHERE take_id=$1',[f.take,f.rule.id]);
  funding.trade=true;funding.issue='allocation_unfunded';
  await f.emit('1','unfunded');await f.runner.tick();
  expect((await f.db.query('SELECT outcome FROM strategy_rule_event_inbox')).rows).toEqual([{outcome:'allocation_unfunded'}]);
  expect(await ruleReason(f)).toBe('allocation_unfunded');expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
 }finally{funding.trade=false;funding.issue=null;await f.close();}
});

test('a burst event uses the condition sample current at its own observation time',async()=>{
 const f=await fixture(true,false,false,true);try{
  const loaded=await f.inputs.load(f.take),price=loaded.config.inputs[0];
  const saved=await f.inputs.save({...loaded,config:{inputs:[price,{...price,key:'level'}],maxSkewMs:1000}});
  const draft=await f.drafts.save({...await f.drafts.load(f.take),inputRevision:saved.revision,config:{schemaVersion:1,rules:[{...f.rule,conditions:{all:[{kind:'numeric',input:'level',operator:'gte',value:'1'}]}}]}});
  await f.runner.configure({takeId:f.take,draftRevision:draft.revision,enabled:true});
  await f.step('1','sample');const sampledAt=f.time();
  const o=(await f.snapshot(f.take)).inputs[0].observation!;
  f.queue.push({...o,receivedAt:sampledAt+500,eventTime:sampledAt+500,payload:{kind:'event',fields:{value:1,id:'burst'}}});
  // 3.5s later the current condition sample is outside maxSkewMs of the event.
  f.advance(1500);await f.step('2','later');
  const rows=(await f.db.query<{evidence:any}>('SELECT evidence FROM strategy_rule_action_requests')).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].evidence.snapshot.inputs.find((input:any)=>input.binding.key==='level').observation.receivedAt).toBe(sampledAt);
  expect(f.errors).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('a re-enrollment between inbox read and commit excludes the read events',async()=>{
 const f=await fixture(true,false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  await f.emit('1','before-reenroll');
  f.onRead(async()=>{await new Promise(resolve=>setTimeout(resolve,5));await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});});
  await f.runner.tick();
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  expect((await f.db.query('SELECT outcome FROM strategy_rule_event_inbox')).rows).toEqual([{outcome:null}]);
  await f.runner.tick();expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
 }finally{await f.close();}
});

test('requests owned by a working or attention trade job are never expired or superseded by the runner',async()=>{
 const f=await fixture();try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');
  const connection=(await f.db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected',$1 FROM local_owners RETURNING id",[randomUUID()])).rows[0].id;
  const account=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,$2,'synthetic') RETURNING id",[connection,randomUUID()])).rows[0].id;
  const ids:string[]=[];
  for(const [key,state] of [['working','working'],['attention','attention'],['free',null]] as const){
   const id=randomUUID();ids.push(id);
   await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,$4,now(),now()-interval '1 second','shadow','{"kind":"rebalance_to_target"}','{}')`,[id,f.take,f.rule.id,key]);
   if(state)await f.db.query('INSERT INTO strategy_rule_trades(request_id,take_id,account_id,phase,state) VALUES($1,$2,$3,$4,$5)',[id,f.take,account,'buy',state]);
  }
  f.stale(true);await f.step('11');await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});
  const statuses=(await f.db.query<{id:string;status:string}>('SELECT id,status FROM strategy_rule_action_requests')).rows;
  expect(ids.map(id=>statuses.find(row=>row.id===id)!.status)).toEqual(['shadow','shadow','expired']);
 }finally{await f.close();}
});

test('a stale tick does not supersede a Robinhood trade awaiting approval or a reduce request; structural expiry still applies to free requests',async()=>{
 const f=await fixture();try{
  await f.runner.configure({takeId:f.take,draftRevision:1,enabled:true});await f.step('11');
  const {strategy_id:strategy,version}=(await f.db.query<{strategy_id:string;version:string}>('SELECT t.strategy_id,s.current_version_id AS version FROM takes t JOIN strategies s ON s.id=t.strategy_id WHERE t.id=$1',[f.take])).rows[0];
  const connection=(await f.db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id")).rows[0].id;
  const account=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,$2,'synthetic') RETURNING id",[connection,randomUUID()])).rows[0].id;
  const allocation=(await f.db.query<{id:string}>("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,'USD','active',now(),now()) RETURNING id",[account,strategy,version])).rows[0].id;
  const request=async(key:string,kind:string)=>{const id=randomUUID();await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,$4,now(),now()+interval '1 hour','shadow',$5,'{}')`,[id,f.take,f.rule.id,key,JSON.stringify({kind,scope:{accountId:account},amount:{value:'2',currency:'USD'}})]);return id;};
  const awaiting=await request('awaiting','reduce'),free=await request('free','reduce'),notice=await request('notice','notify');
  await f.db.query(`INSERT INTO robinhood_rule_trades(request_id,take_id,account_id,allocation_id,kind,amount,state,preview) VALUES($1,$2,$3,$4,'reduce',2,'awaiting_approval','{"orders":[]}')`,[awaiting,f.take,account,allocation]);
  f.stale(true);f.advance(2000);await f.step('11');
  const status=async(id:string)=>(await f.db.query<{status:string}>('SELECT status FROM strategy_rule_action_requests WHERE id=$1',[id])).rows[0].status;
  expect([await status(awaiting),await status(free),await status(notice)]).toEqual(['shadow','shadow','superseded']);
 }finally{await f.close();}
});

test('a drop after a real event gets its own marker in order; consecutive drops still share one',async()=>{
 const f=await fixture(true,false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  const owner=await f.owner(),ref={sourceId:f.source,feedId:'price',configVersion:1},gap=(at:number)=>f.db.transaction(tx=>journalRuleEventGap(tx,owner,ref,at));
  await f.emit('0','first');await gap(f.time()+1);await gap(f.time()+2);
  await f.emit('0','second');await gap(f.time()+1);
  expect((await pendingInbox(f)).map(row=>row.observation.marker??row.observation.payload.fields.id)).toEqual(['first',{kind:'gap',dropped:2},'second',{kind:'gap',dropped:1}]);
 }finally{await f.close();}
});
test('after re-enrollment a drop is recorded on a new visible marker, not an invisible earlier one',async()=>{
 const f=await fixture(true,false,false,false,false,true);try{
  await f.runner.configure({takeId:f.take,draftRevision:f.draft.revision,enabled:true});
  const owner=await f.owner(),ref={sourceId:f.source,feedId:'price',configVersion:1},gap=(at:number)=>f.db.transaction(tx=>journalRuleEventGap(tx,owner,ref,at));
  const before=Date.now()+1000;await gap(before);
  await f.db.query('UPDATE strategy_rule_shadow SET updated_at=$2 WHERE take_id=$1',[f.take,new Date(before+1000)]);
  await gap(before+2000);
  expect((await pendingInbox(f)).map(row=>row.observation.marker)).toEqual([{kind:'gap',dropped:1},{kind:'gap',dropped:1}]);
  const batch=await readRuleEventInbox(f.db,f.take,f.draft.revision,f.rule.id);
  expect(batch).toMatchObject({gap:true,observations:[]});
 }finally{await f.close();}
});
