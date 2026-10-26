// Automatic rule runs in a Take's thread. Synthetic executor only.
import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createTakes,type RuleRunInput} from '../../../src/main/takes';
import type {TakeExecutor} from '../../../src/main/take-runtime';

const selection={provider:'claude' as const,model:'sonnet'};
const models=async()=>({ok:true as const,source:'runtime' as const,models:[{value:'sonnet',label:'Sonnet',imageInput:true}]});
const tools=async()=>[{name:'opentake_read_rules',policy:'allowed'},{name:'opentake_read_strategy',policy:'ask'},{name:'opentake_propose_rules',policy:'ask'},{name:'unlisted_tool',policy:'allowed'}];
async function settle(service:ReturnType<typeof createTakes>){for(let i=0;i<300;i++){if(!service.busy())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Did not settle');}
async function fixture(execute:TakeExecutor=async i=>{i.text('Analysis');}){
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const service=createTakes(lifecycle,execute,models,tools);await service.start();
 const id=await service.create();
 const input=(over:Partial<RuleRunInput>={}):RuleRunInput=>({requestId:randomUUID(),takeId:id,ruleId:randomUUID(),ruleName:'BTC drop',text:'Rule “BTC drop” fired.',
  tools:['opentake_read_rules','opentake_read_strategy','opentake_propose_rules'],limits:{inferenceMs:60_000,absoluteMs:60_000,toolCalls:5},maxCostUsd:0.5,...over});
 const run=async(requestId:string)=>(await db.query<{configuration:Record<string,any>}>('SELECT configuration FROM take_runs WHERE request_id=$1',[requestId])).rows[0]?.configuration;
 return {db,service,id,input,run,close:async()=>{await service.close();await db.close();}};
}

test('a rule run starts in the Take thread with its own limits and only allowed listed tools, keeps the draft, and never runs twice',async()=>{
 const f=await fixture();try{
  await f.service.send({requestId:randomUUID(),takeId:f.id,parentId:null,text:'Watch BTC',selection});await settle(f.service);
  await f.service.update(f.id,{draft:'Unsent thought'});
  const request=f.input(),started=await f.service.ruleRun(request);
  expect(started.status).toBe('started');expect(started.status==='started'&&await started.done).toBe('completed');
  const config=await f.run(request.requestId);
  // A listed proposal tool set to Ask is offered; other Ask tools are not.
  expect(config.tools).toEqual([{name:'opentake_read_rules',policy:'allowed'},{name:'opentake_propose_rules',policy:'ask'}]);
  expect(config).toMatchObject({unattended:true,limits:request.limits,rule:{requestId:request.requestId,ruleName:'BTC drop'},budgets:{claudeCostUsd:0.5,opencodeCostUsd:0.5,outputTokens:null}});
  const take=await f.service.load(f.id);
  expect(take.draft).toBe('Unsent thought');
  const turn=take.messages.find(m=>m.ruleRun);expect(turn).toMatchObject({role:'user',text:'Rule “BTC drop” fired.',ruleRun:{requestId:request.requestId,limits:{durationMs:60_000,toolCalls:5,costUsd:0.5}}});
  expect(take.messages.find(m=>m.id===take.headId)).toMatchObject({role:'assistant',text:'Analysis',state:'completed'});
  expect(await f.service.ruleRun(request)).toMatchObject({status:'exists'});
  expect((await f.db.query('SELECT 1 FROM take_runs WHERE request_id=$1',[request.requestId])).rows).toHaveLength(1);
 }finally{await f.close();}
});

test('a rule run waits for a busy Take, offers no tools in an ask-mode Take, gates Codex and Grok by tokens, and refuses a missing model',async()=>{
 const f=await fixture(async i=>{await new Promise<void>(resolve=>i.signal.addEventListener('abort',()=>resolve(),{once:true}));});try{
  await f.service.send({requestId:randomUUID(),takeId:f.id,parentId:null,text:'Long question',selection});
  expect(await f.service.ruleRun(f.input())).toEqual({status:'busy'});
  await f.service.stop(f.id);
  await f.service.update(f.id,{permissionMode:'ask'});
  const asked=f.input(),started=await f.service.ruleRun(asked);expect(started.status).toBe('started');
  expect((await f.run(asked.requestId)).tools).toEqual([]);
  await f.service.stop(f.id);
  // Codex and Grok report tokens but not cost: they run only under the rule's token gate.
  await f.service.update(f.id,{permissionMode:'auto'});
  for(const provider of ['chatgpt','grok'] as const){
   await f.db.query('UPDATE takes SET selection=$2 WHERE id=$1',[f.id,JSON.stringify({provider,model:'sonnet'})]);
   expect(await f.service.ruleRun(f.input())).toEqual({status:'blocked',reason:'token_limit_required'});
   const gated=f.input({maxOutputTokens:20_000});expect((await f.service.ruleRun(gated)).status).toBe('started');
   expect((await f.run(gated.requestId)).budgets).toEqual({claudeCostUsd:0.5,opencodeCostUsd:0.5,outputTokens:20_000,...(provider==='grok'?{requireCompleteUsage:true}:{})});
   await f.service.stop(f.id);
  }
  await f.db.query('UPDATE takes SET selection=$2 WHERE id=$1',[f.id,JSON.stringify({provider:'claude',model:'retired'})]);
  expect(await f.service.ruleRun(f.input())).toEqual({status:'blocked',reason:'model_unavailable'});
 }finally{await f.close();}
});

test('automatic run limits default sensibly, save within bounds, and reject anything outside them',async()=>{
 const f=await fixture();try{
  expect(await f.service.automaticLimits()).toEqual({durationMs:300_000,toolCalls:20,modelTurns:20,costUsd:1,outputTokens:50_000});
  const next={durationMs:120_000,toolCalls:10,modelTurns:8,costUsd:0.25,outputTokens:20_000};
  expect(await f.service.saveAutomaticLimits(next)).toEqual(next);expect(await f.service.automaticLimits()).toEqual(next);
  for(const bad of [{...next,modelTurns:21},{...next,toolCalls:0},{...next,costUsd:0},{...next,durationMs:999},{...next,extra:1}])
   await expect(f.service.saveAutomaticLimits(bad)).rejects.toThrow();
  expect(await f.service.automaticLimits()).toEqual(next);
 }finally{await f.close();}
});
