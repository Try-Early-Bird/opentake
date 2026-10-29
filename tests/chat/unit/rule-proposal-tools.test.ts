import Ajv from 'ajv';
import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createRuleProposals} from '../../../src/main/strategies/rule-proposals';
import {createRuleRunner} from '../../../src/main/strategies/rule-runner';
import {createTakeInputs} from '../../../src/main/data-sources/take-inputs';
import {dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import {callOpentakeTool} from '../../../src/main/opentake-mcp/server';
import {toolCatalog} from '../../../src/main/opentake-mcp/catalog';
async function fixture(){
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const take=randomUUID(),strategy=randomUUID(),version=randomUUID(),run=randomUUID(),message=randomUUID(),source=randomUUID();let active=true;
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
 await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
 await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,take,randomUUID()]);
 await db.query('INSERT INTO take_messages(id,take_id,sequence,data) VALUES($1,$2,1,$3)',[message,take,JSON.stringify({role:'assistant',runId:run})]);
 await db.transaction(async tx=>{await tx.query('INSERT INTO data_sources(id,owner_id,current_revision,enabled,validated) SELECT $1,id,1,true,true FROM local_owners',[source]);await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,1,$2)',[source,JSON.stringify({name:'Price',endpoint:'https://example.com/price',collection:'automatic',pollIntervalMs:15000,feeds:[{id:'price',name:'Price',unit:'USD',mapping:{kind:'metric',valuePath:['value']},storage:{mode:'live',fields:['value'],sampleEveryMs:60000,retentionDays:7}}]})]);});
 const service=createRuleProposals(database,()=>active),inputs=createTakeInputs(database,()=>[null]);
 const runner=createRuleRunner(database,inputs.snapshot,vi.fn(),()=>true);
 const rule=dataSourceThresholdPreset(randomUUID(),'btc','80000',{kind:'notify',message:'BTC price drop'});
 const propose=async(config={schemaVersion:1 as const,rules:[rule]})=>{const current=await service.read(take);return {operationId:randomUUID(),expectedRevision:current.revision,expectedVersion:current.version,expectedInputRevision:current.inputRevision,config,inputs:{inputs:[{key:'btc',sourceId:source,sourceRevision:1,feedId:'price',field:'value',kind:'metric' as const,unit:'USD',maxAgeMs:15000}],maxSkewMs:5000}};};
 return {db,service,inputs,runner,take,run,message,source,rule,propose,setActive:(v:boolean)=>active=v,close:async()=>{await runner.close();await db.close();}};
}
test('chat proposals preserve accepted rules until atomic approval, and support multiple rules, edits and removal',async()=>{
 const f=await fixture();try{
  const second={...f.rule,id:randomUUID(),name:'Second rule'};const input=await f.propose({schemaVersion:1,rules:[f.rule,second]});
  const p=await f.service.propose(f.run,input);expect((await f.service.propose(f.run,input)).proposal.id).toBe(p.proposal.id);
  expect((await f.service.read(f.take)).config.rules).toHaveLength(0);expect((await f.inputs.load(f.take)).revision).toBe(0);
  expect((await f.service.message(f.message))).toHaveLength(1);
  await f.db.exec("CREATE FUNCTION fixture_reject_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fixture_reject_approval BEFORE INSERT ON strategy_rule_accepted FOR EACH ROW EXECUTE FUNCTION fixture_reject_approval();");
  await expect(f.service.decide(p.proposal.id,'accept')).rejects.toThrow();expect((await f.inputs.load(f.take)).revision).toBe(0);expect((await f.db.query('SELECT * FROM strategy_rule_draft_revisions')).rows).toHaveLength(0);expect((await f.service.message(f.message))[0].status).toBe('pending');
  await f.db.exec('DROP TRIGGER fixture_reject_approval ON strategy_rule_accepted;');
  const accepted=await f.service.decide(p.proposal.id,'accept');expect(accepted.config.rules).toHaveLength(2);expect(accepted.inputRevision).toBe(1);
  const policyRead=await f.service.agentRead(f.run);expect(policyRead.actionPolicies).toHaveLength(2);expect(policyRead.actionPolicies[0]).toMatchObject({approval:'not_required',reason:'notifications_enabled'});expect(policyRead.proposalApproval.takeChanges).toBe('member_acceptance');
  // Accepting is activation: the accepted revision is enrolled with alerts on.
  expect((await f.db.query('SELECT draft_revision,enabled,notifications_enabled FROM strategy_rule_shadow')).rows).toEqual([{draft_revision:accepted.revision,enabled:true,notifications_enabled:true}]);
  await f.runner.configure({takeId:f.take,draftRevision:accepted.revision,enabled:true});
  const edit=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[{...f.rule,name:'Updated'},second]}));
  await f.runner.tick();expect((await f.runner.inspect(f.take)).enrollment).toMatchObject({enabled:true,draft_revision:accepted.revision});expect((await f.service.read(f.take)).config.rules[0].name).toBe(f.rule.name);
  await f.service.decide(edit.proposal.id,'dismiss');expect((await f.service.read(f.take)).revision).toBe(accepted.revision);
  // The agent sees what the member turned down, so it does not propose it again without a new reason.
  expect((await f.service.agentRead(f.run)).dismissedProposals).toEqual([{id:edit.proposal.id,proposedAt:expect.any(String),rules:[{name:'Updated',action:f.rule.action.kind},{name:second.name,action:second.action.kind}]}]);
  const next=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[second]}));await f.service.decide(next.proposal.id,'accept');
  const updated=await f.service.read(f.take);expect(updated.config.rules.map(r=>r.id)).toEqual([second.id]);expect((await f.runner.inspect(f.take)).enrollment).toMatchObject({enabled:true,draft_revision:updated.revision});
  expect((await f.service.decide(next.proposal.id,'accept')).revision).toBe(updated.revision);
  expect((await f.db.query('SELECT * FROM take_runs')).rows).toHaveLength(1);
 }finally{await f.close();}
});
test('rule approval rejects superseded proposals, changed sources, stale bindings, stopped runs and operation collisions',async()=>{
 const f=await fixture();try{
  const first=await f.propose();const p=await f.service.propose(f.run,first);
  await expect(f.service.propose(f.run,{...first,config:{schemaVersion:1,rules:[]}})).rejects.toThrow('Operation');
  const q=await f.service.propose(f.run,await f.propose());await expect(f.service.decide(p.proposal.id,'accept')).rejects.toThrow('pending');
  await f.db.query('UPDATE data_sources SET enabled=false WHERE id=$1',[f.source]);await expect(f.service.decide(q.proposal.id,'accept')).rejects.toThrow('Source');expect((await f.inputs.load(f.take)).revision).toBe(0);
  await f.db.query('UPDATE data_sources SET enabled=true WHERE id=$1',[f.source]);
  await f.inputs.save({...await f.inputs.load(f.take),config:first.inputs});await expect(f.service.decide(q.proposal.id,'accept')).rejects.toThrow('changed');
  f.setActive(false);await expect(f.service.propose(f.run,await f.propose())).rejects.toThrow('stopped');await expect(f.service.agentRead(f.run)).rejects.toThrow('stopped');f.setActive(true);
  await f.db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[f.take]);await expect(f.service.decide(q.proposal.id,'accept')).rejects.toThrow();
 }finally{await f.close();}
});
test('rule tools expose proposals only, reject target overrides and never expose an acceptance tool',async()=>{
 const rules=vi.fn(async()=>({execution:'preview_only'})),services={rules,status:vi.fn(),read:vi.fn()};
 expect(toolCatalog().find(t=>t.name==='opentake_propose_rules')?.annotations.readOnlyHint).toBe(false);
 expect(toolCatalog().some(t=>/accept.*rule|execute.*rule/.test(t.name))).toBe(false);
 expect((await callOpentakeTool(services,'opentake_read_rules',{})).isError).not.toBe(true);
 expect((await callOpentakeTool(services,'opentake_read_rules',{targetTakeId:randomUUID()})).isError).toBe(true);
 expect((await callOpentakeTool(services,'opentake_propose_rules',{decision:'accept'})).isError).toBe(true);expect(rules).toHaveBeenCalledTimes(1);
});

test('rule activity is current-Take scoped, paginated, read-only and includes recorded evidence and notification status',async()=>{
 const f=await fixture();try{
  const p=await f.service.propose(f.run,await f.propose());const accepted=await f.service.decide(p.proposal.id,'accept');
  const ids=[randomUUID(),randomUUID()];
  for(const [index,id] of ids.entries())await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,'notified',$8,$9)`,[id,f.take,accepted.revision,f.rule.id,`fixture:${index}`,new Date(1700000000000+index*1000),new Date(1700000300000+index*1000),JSON.stringify(f.rule.action),JSON.stringify({rule:f.rule,reason:'matched',snapshot:{price:'79000'}})]);
  await f.db.query('SELECT record_local_notification($1::jsonb,false)',[JSON.stringify({kind:'rule_notification',context:{takeId:f.take},source:{type:'rule',id:ids[1]},eventKey:ids[1],title:'Fixture',body:'Matched',tier:'know_today',requiresAction:false,occurredAt:new Date().toISOString()})]);
  const first=await f.service.agentActivity(f.run,{limit:1});expect('items' in first.history&&first.history.items.map(r=>r.id)).toEqual([ids[1]]);expect(first.notifications).toMatchObject([{request_id:ids[1],delivery:'pending',seen:false}]);
  const next=await f.service.agentActivity(f.run,{limit:1,before:'next' in first.history?first.history.next:undefined});expect('items' in next.history&&next.history.items.map(r=>r.id)).toEqual([ids[0]]);
  const detail=await f.service.agentActivity(f.run,{requestId:ids[1]});expect('request' in detail.history&&detail.history.request.evidence).toMatchObject({snapshot:{price:'79000'}});
  expect((await f.db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(2);expect((await f.db.query('SELECT delivery FROM notifications')).rows).toEqual([{delivery:'pending'}]);expect((await f.db.query('SELECT id FROM take_runs')).rows).toHaveLength(1);
  const other=randomUUID(),foreign=randomUUID(),otherStrategy=randomUUID();
  await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[otherStrategy]);
  await f.db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,owner_id,'Other','{}',$3 FROM takes WHERE id=$2",[other,f.take,otherStrategy]);
  await f.db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) SELECT $1,revision,accepted_version,input_revision,config FROM strategy_rule_draft_revisions WHERE take_id=$2',[other,f.take]);
  await f.db.query("INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) SELECT $1,$2,draft_revision,rule_id,'foreign',created_at,expires_at,status,action,evidence FROM strategy_rule_action_requests WHERE id=$3",[foreign,other,ids[0]]);
  await expect(f.service.agentActivity(f.run,{requestId:foreign})).rejects.toThrow('unavailable');expect(()=>f.service.agentActivity(f.run,{takeId:other})).toThrow();
  f.setActive(false);await expect(f.service.agentActivity(f.run,{})).rejects.toThrow('stopped');
 }finally{await f.close();}
});
test('rule activity tool is read-only, validates bounded arguments and cannot target another Take',async()=>{
 const rules=vi.fn(async()=>({history:{items:[]}})),services={rules,status:vi.fn(),read:vi.fn()};
 expect(toolCatalog().find(t=>t.name==='opentake_read_rule_activity')?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
 expect((await callOpentakeTool(services,'opentake_read_rule_activity',{})).isError).not.toBe(true);expect(rules).toHaveBeenCalledWith('opentake_read_rule_activity',{limit:10});
 for(const args of [{takeId:randomUUID()},{limit:21},{requestId:'bad'},{decision:'accept'}])expect((await callOpentakeTool(services,'opentake_read_rule_activity',args)).isError).toBe(true);
 expect(rules).toHaveBeenCalledTimes(1);expect(services.read).not.toHaveBeenCalled();
});

test('rule activity schema compiles in the actual MCP validator and preserves optional default inputs',()=>{
 const schema=toolCatalog().find(t=>t.name==='opentake_read_rule_activity')!.inputSchema;
 const validate=new Ajv({strict:false,allErrors:false}).compile(schema);
 expect(validate({})).toBe(true);expect(validate({limit:10})).toBe(true);
 expect(validate({requestId:randomUUID()})).toBe(true);
 expect(validate({limit:21})).toBe(false);expect(validate({takeId:randomUUID()})).toBe(false);
});
test('rename-only acceptance carries pending inbox events and firing receipts to the new revision',async()=>{
 const f=await fixture();try{
  const p=await f.service.propose(f.run,await f.propose());const accepted=await f.service.decide(p.proposal.id,'accept');
  await f.runner.configure({takeId:f.take,draftRevision:accepted.revision,enabled:true});
  await f.db.query(`INSERT INTO strategy_rule_firing_receipts(take_id,draft_revision,rule_id,firing_key,created_at) VALUES($1,$2,$3,'event-key',now())`,[f.take,accepted.revision,f.rule.id]);
  await f.db.query(`INSERT INTO strategy_rule_event_inbox(take_id,draft_revision,rule_id,receipt,observation,received_at) VALUES($1,$2,$3,'pending-event','{}',now())`,[f.take,accepted.revision,f.rule.id]);
  const rename=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[{...f.rule,name:'Renamed'}]}));
  const renamed=await f.service.decide(rename.proposal.id,'accept');expect(renamed.revision).toBe(accepted.revision+1);expect(renamed.config.rules[0].name).toBe('Renamed');
  expect((await f.db.query('SELECT draft_revision FROM strategy_rule_event_inbox WHERE handled_at IS NULL')).rows).toEqual([{draft_revision:renamed.revision}]);
  expect((await f.db.query("SELECT draft_revision FROM strategy_rule_firing_receipts WHERE firing_key='event-key' ORDER BY draft_revision")).rows).toEqual([{draft_revision:accepted.revision},{draft_revision:renamed.revision}]);
  // A replayed firing under the new revision is still deduplicated.
  const replay=await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES(gen_random_uuid(),$1,$2,$3,'event-key',now(),now(),'expired','{}','{}') RETURNING id`,[f.take,renamed.revision,f.rule.id]);
  expect(replay.rows).toHaveLength(0);
  expect((await f.runner.inspect(f.take)).enrollment).toMatchObject({enabled:true,draft_revision:renamed.revision});
 }finally{await f.close();}
});
test('accepting other rule edits keeps an unchanged rule finished instead of granting another run',async()=>{
 const f=await fixture();try{
  const p=await f.service.propose(f.run,await f.propose());const accepted=await f.service.decide(p.proposal.id,'accept');
  await f.db.query(`INSERT INTO strategy_rule_state(take_id,draft_revision,rule_id,state,reason,updated_at) VALUES($1,$2,$3,$4,'fired',now())`,[f.take,accepted.revision,f.rule.id,JSON.stringify({runs:f.rule.policy.maxRuns,attempts:1,baseline:true,armed:true,candidateAt:null,session:'s',lastFiredAt:1})]);
  await f.db.query(`INSERT INTO strategy_rule_firing_receipts(take_id,draft_revision,rule_id,firing_key,created_at) VALUES($1,$2,$3,'event-key',now())`,[f.take,accepted.revision,f.rule.id]);
  expect((await f.service.read(f.take)).lifecycle[f.rule.id].status).toBe('Finished');
  const added={...f.rule,id:randomUUID(),name:'Added rule'};
  const edit=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[f.rule,added]}));
  const next=await f.service.decide(edit.proposal.id,'accept');expect(next.revision).toBe(accepted.revision+1);
  expect(next.lifecycle[f.rule.id].status).toBe('Finished');expect(next.lifecycle[added.id].status).toBe('Waiting');
  expect((await f.db.query('SELECT state FROM strategy_rule_state WHERE take_id=$1 AND draft_revision=$2',[f.take,next.revision])).rows).toEqual([{state:expect.objectContaining({runs:f.rule.policy.maxRuns,lastFiredAt:1,baseline:false,armed:false})}]);
  expect((await f.db.query('SELECT rule_id FROM strategy_rule_firing_receipts WHERE draft_revision=$1',[next.revision])).rows).toEqual([{rule_id:f.rule.id}]);
  // A changed definition is a new rule and starts fresh.
  const changed=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[{...f.rule,policy:{...f.rule.policy,cooldownMs:f.rule.policy.cooldownMs+1000}},added]}));
  const last=await f.service.decide(changed.proposal.id,'accept');expect(last.lifecycle[f.rule.id].status).toBe('Waiting');
 }finally{await f.close();}
});
test('configure enrolls only the accepted revision, never a newer unreviewed draft',async()=>{
 const f=await fixture();try{
  const p=await f.service.propose(f.run,await f.propose());const accepted=await f.service.decide(p.proposal.id,'accept');
  await f.db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) SELECT take_id,revision+1,accepted_version,input_revision,config FROM strategy_rule_draft_revisions WHERE take_id=$1 AND revision=$2',[f.take,accepted.revision]);
  for(const delivery of ['shadow','notifications'] as const)await expect(f.runner.configure({takeId:f.take,draftRevision:accepted.revision+1,enabled:true,delivery})).rejects.toThrow('changed');
  expect((await f.db.query('SELECT revision FROM strategy_rule_accepted WHERE take_id=$1',[f.take])).rows).toEqual([{revision:accepted.revision}]);
  // The unreviewed draft never replaces the accepted revision's enrollment.
  expect((await f.db.query('SELECT draft_revision FROM strategy_rule_shadow')).rows).toEqual([{draft_revision:accepted.revision}]);
  await f.runner.configure({takeId:f.take,draftRevision:accepted.revision,enabled:true});
  expect((await f.runner.inspect(f.take)).enrollment).toMatchObject({enabled:true,draft_revision:accepted.revision});
 }finally{await f.close();}
});
test('accepting rules activates them; pausing stops them until the next acceptance; accepting none deactivates',async()=>{
 const f=await fixture();try{
  const shadow=async()=>(await f.db.query<{enabled:boolean;notifications_enabled:boolean;draft_revision:number}>('SELECT enabled,notifications_enabled,draft_revision FROM strategy_rule_shadow WHERE take_id=$1',[f.take])).rows[0];
  const p=await f.service.propose(f.run,await f.propose());const accepted=await f.service.decide(p.proposal.id,'accept');
  expect(await shadow()).toEqual({enabled:true,notifications_enabled:true,draft_revision:accepted.revision});
  await f.runner.configure({takeId:f.take,draftRevision:accepted.revision,enabled:false,delivery:'notifications'});
  expect(await shadow()).toMatchObject({enabled:false,notifications_enabled:false});
  const edit=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[{...f.rule,policy:{...f.rule.policy,cooldownMs:f.rule.policy.cooldownMs+1000}}]}));
  const next=await f.service.decide(edit.proposal.id,'accept');
  expect(await shadow()).toEqual({enabled:true,notifications_enabled:true,draft_revision:next.revision});
  const none=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[]}));await f.service.decide(none.proposal.id,'accept');
  expect(await shadow()).toMatchObject({enabled:false,notifications_enabled:false});
 }finally{await f.close();}
});
test('each rule switches on and off on its own; an off rule is not evaluated, keeps its state and stays off across other edits',async()=>{
 const f=await fixture();try{
  const second={...f.rule,id:randomUUID(),name:'Second rule'};
  const p=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[f.rule,second]}));const accepted=await f.service.decide(p.proposal.id,'accept');
  const state={runs:1,attempts:1,baseline:true,armed:true,candidateAt:null,session:'s',lastFiredAt:1};
  await f.db.query(`INSERT INTO strategy_rule_state(take_id,draft_revision,rule_id,state,reason,updated_at) VALUES($1,$2,$3,$4,'fired','2026-01-01T00:00:00Z')`,[f.take,accepted.revision,f.rule.id,JSON.stringify(state)]);
  const request=randomUUID();
  await f.db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,$3,$4,'k',now(),now()+interval '1 hour','shadow',$5,'{}')`,[request,f.take,accepted.revision,f.rule.id,JSON.stringify(f.rule.action)]);
  await expect(f.service.setRuleEnabled(f.take,randomUUID(),false)).rejects.toThrow('Rule unavailable');
  const off=await f.service.setRuleEnabled(f.take,f.rule.id,false);
  expect(off.disabledRuleIds).toEqual([f.rule.id]);expect(off.revision).toBe(accepted.revision);
  expect((await f.service.setRuleEnabled(f.take,f.rule.id,false)).disabledRuleIds).toEqual([f.rule.id]);
  expect((await f.db.query('SELECT status FROM strategy_rule_action_requests WHERE id=$1',[request])).rows).toEqual([{status:'superseded'}]);
  expect((await f.service.activity(f.take,f.rule.id)).map(i=>({id:i.requestId,status:i.status}))).toEqual([{id:request,status:'superseded'}]);
  // The runner evaluates only the rule that is on; the off rule's stored state waits unchanged.
  await f.runner.tick();
  const rows=async(revision:number)=>(await f.db.query<{rule_id:string;state:typeof state;updated_at:Date}>('SELECT rule_id,state,updated_at FROM strategy_rule_state WHERE take_id=$1 AND draft_revision=$2',[f.take,revision])).rows;
  const after=await rows(accepted.revision);
  expect(after.find(r=>r.rule_id===f.rule.id)).toMatchObject({state,updated_at:new Date('2026-01-01T00:00:00Z')});expect(after.some(r=>r.rule_id===second.id)).toBe(true);
  // An edit to the other rule keeps this one off; changing this one turns it on.
  const edit=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[f.rule,{...second,policy:{...second.policy,cooldownMs:second.policy.cooldownMs+1000}}]}));
  const edited=await f.service.decide(edit.proposal.id,'accept');expect(edited.disabledRuleIds).toEqual([f.rule.id]);
  const on=await f.service.setRuleEnabled(f.take,f.rule.id,true);expect(on.disabledRuleIds).toEqual([]);
  expect((await rows(edited.revision)).find(r=>r.rule_id===f.rule.id)?.state).toMatchObject({runs:1,lastFiredAt:1,baseline:false,armed:false});
  await f.service.setRuleEnabled(f.take,f.rule.id,false);
  const changed=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[{...f.rule,policy:{...f.rule.policy,cooldownMs:f.rule.policy.cooldownMs+1000}},second]}));
  expect((await f.service.decide(changed.proposal.id,'accept')).disabledRuleIds).toEqual([]);
 }finally{await f.close();}
});
test('deleting a rule makes a new revision without it, keeps the other rules running and supersedes pending proposals',async()=>{
 const f=await fixture();try{
  const second={...f.rule,id:randomUUID(),name:'Second rule'};
  const p=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[f.rule,second]}));const accepted=await f.service.decide(p.proposal.id,'accept');
  await f.db.query(`INSERT INTO strategy_rule_state(take_id,draft_revision,rule_id,state,reason,updated_at) VALUES($1,$2,$3,$4,'fired',now())`,[f.take,accepted.revision,second.id,JSON.stringify({runs:1,attempts:1,baseline:true,armed:true,candidateAt:null,session:'s',lastFiredAt:1})]);
  await f.service.setRuleEnabled(f.take,second.id,false);
  const pending=await f.service.propose(f.run,await f.propose({schemaVersion:1,rules:[second]}));
  await expect(f.service.removeRule(f.take,randomUUID())).rejects.toThrow('Rule unavailable');
  const removed=await f.service.removeRule(f.take,f.rule.id);
  expect(removed.revision).toBe(accepted.revision+1);expect(removed.config.rules.map(r=>r.id)).toEqual([second.id]);
  expect(removed.disabledRuleIds).toEqual([second.id]);expect(removed.lifecycle[second.id]).toMatchObject({runs:1});
  expect((await f.db.query('SELECT status FROM strategy_rule_proposals WHERE id=$1',[pending.proposal.id])).rows).toEqual([{status:'superseded'}]);
  expect((await f.db.query('SELECT draft_revision,enabled FROM strategy_rule_shadow WHERE take_id=$1',[f.take])).rows).toEqual([{draft_revision:removed.revision,enabled:true}]);
  const last=await f.service.removeRule(f.take,second.id);expect(last.config.rules).toEqual([]);
  expect((await f.db.query('SELECT enabled FROM strategy_rule_shadow WHERE take_id=$1',[f.take])).rows).toEqual([{enabled:false}]);
 }finally{await f.close();}
});
