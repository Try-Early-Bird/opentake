import { test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, migrations } from '../../../src/main/migrations';
import { createTakes } from '../../../src/main/takes';
import { visibleMessages } from '../../../src/shared/takes';
import type { TakeExecutor } from '../../../src/main/take-runtime';
import { RunLimitError } from '../../../src/main/run-budget';
import { BudgetLimitError } from '../../../src/main/usage-budget';
const selection={provider:'claude' as const,model:'sonnet'};
const models=async()=>({ok:true as const,source:'runtime' as const,models:[{value:'sonnet',label:'Sonnet',imageInput:true}]});
async function settle(service:ReturnType<typeof createTakes>){for(let i=0;i<300;i++){if(!service.busy())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Did not settle');}
test('takes persist branches, archive, instructions, idempotency and follow-up context',async()=>{
 const db=new PGlite();await migrate(db);const seen:string[][]=[];const executor:TakeExecutor=async i=>{seen.push(i.messages.map(m=>m.text));expect(i.instructions).toContain('Test instructions');i.text('**Reply**');};
 const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const service=createTakes(lifecycle,executor,models,async()=>{
  const result=await lifecycle.use(d=>d.query<{name:string}>("SELECT 'reviewed-tool'::text AS name"));
  return result.rows;
 });await service.start();
 try{
  await service.saveAbout('Test instructions');const id=await service.create();
  const req={requestId:randomUUID(),takeId:id,parentId:null,text:'First',selection};await service.send(req);await settle(service);await service.send(req);expect(seen).toHaveLength(1);
  const stored=await db.query<{configuration:{tools:unknown[]}}>('SELECT configuration FROM take_runs WHERE request_id=$1',[req.requestId]);
  expect(stored.rows[0].configuration.tools).toEqual([{name:'reviewed-tool'}]);
  let take=await service.load(id);const firstHead=take.headId;await service.send({requestId:randomUUID(),takeId:id,parentId:firstHead,text:'Follow up',selection});await settle(service);
  expect(seen[1]).toEqual(['First','**Reply**','Follow up']);
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Edited first',selection});await settle(service);take=await service.load(id);expect(take.messages).toHaveLength(6);expect(visibleMessages(take).map(m=>m.text)).toEqual(['Edited first','**Reply**']);
  await service.update(id,{headId:firstHead,archived:true,draft:'Saved draft'});await service.close();
  const reopened=createTakes(lifecycle,executor,models);await reopened.start();expect((await reopened.load(id)).archivedAt).not.toBeNull();expect((await reopened.snapshot(id,true,undefined))?.takes).toHaveLength(1);expect((await reopened.load(id)).draft).toBe('Saved draft');await reopened.remove(id);expect((await reopened.snapshot(null,true,undefined))?.takes).toHaveLength(0);await reopened.close();
 }finally{await service.close();await db.close();}
});
test('stop cancels a run and restart marks unfinished messages interrupted',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const service=createTakes(lifecycle,async i=>{i.text('Partial');await new Promise<void>(resolve=>i.signal.addEventListener('abort',()=>resolve(),{once:true}));},models);await service.start();
 try{const id=await service.create();await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Start',selection});await service.stop(id);expect((await service.load(id)).messages.find(m=>m.role==='assistant')?.state).toBe('cancelled');await db.exec(`UPDATE take_messages SET data=jsonb_set(data,'{state}','"running"') WHERE data->>'role'='assistant'`);await service.start();expect((await service.load(id)).messages.find(m=>m.role==='assistant')?.state).toBe('interrupted');}finally{await service.close();await db.close();}
});

test('General follows app defaults until customized, restores them, and historical runs keep their resolved text',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const prompts:string[]=[];const execute:TakeExecutor=async i=>{prompts.push(i.instructions);i.text('Done');};
 const first=createTakes(lifecycle,execute,models,async()=>[],'Defaults version one');
 try{
  await first.start();const id=await first.create();
  const general=(await first.instructionProfiles())[0];expect(general).toMatchObject({name:'General',builtin:true,followsDefault:true,text:'Defaults version one'});
  await first.saveInstructionProfile({id:general.id,name:'Renamed',text:'Defaults version one'});
  expect((await first.instructionProfiles())[0]).toMatchObject({name:'General',followsDefault:true});
  await first.send({requestId:randomUUID(),takeId:id,parentId:null,text:'First',selection});await settle(first);await first.close();
  const second=createTakes(lifecycle,execute,models,async()=>[],'Defaults version two');
  const send=async(text:string)=>{await second.send({requestId:randomUUID(),takeId:id,parentId:null,text,selection});await settle(second);};
  try{await second.start();await send('Second');
   expect(prompts[0]).toContain('Defaults version one');expect(prompts[1]).toContain('Defaults version two');
   await second.saveInstructionProfile({id:general.id,name:'General',text:'My own rules'});await send('Draft only');expect(prompts[2]).toContain('Defaults version two');
   await second.publishInstructionProfile(general.id);await send('Custom');expect(prompts[3]).toContain('My own rules');expect(prompts[3]).not.toContain('Defaults version two');
   // Matching text does not resume following; only Restore default does.
   await second.saveInstructionProfile({id:general.id,name:'General',text:'Defaults version two'});expect((await second.instructionProfiles())[0].followsDefault).toBe(false);
   await second.restoreDefaultInstructions(general.id);await second.publishInstructionProfile(general.id);await send('Restored');expect(prompts[4]).toContain('Defaults version two');
   await expect(second.removeInstructionProfile(general.id)).rejects.toThrow('cannot be deleted');
   const rows=await db.query<{configuration:{instructions:string;instructionMode:string}}>('SELECT configuration FROM take_runs ORDER BY created_at');
   expect(rows.rows[0].configuration.instructions).toContain('Defaults version one');
   expect(rows.rows.map(r=>r.configuration.instructionMode)).toEqual(['follow_app_default','follow_app_default','follow_app_default','custom','follow_app_default']);
   const labels=(await second.load(id)).messages.filter(m=>m.role==='assistant').map(m=>m.instructions);
   expect(labels.map(l=>[l?.name,l?.version])).toEqual([['General',1],['General',1],['General',1],['General',2],['General',3]]);
  }finally{await second.close();}
 }finally{await first.close();await db.close();}
});

test('runs layer required rules, about-you context and the chosen instructions, without legacy take text',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const prompts:string[]=[];const service=createTakes(lifecycle,async i=>{prompts.push(i.instructions);i.text('Done');},models,async()=>[],'App defaults');
 try{
  await service.start();await service.saveAbout('Long-term ETF investor');
  const research=await service.saveInstructionProfile({name:'Research',text:'Research carefully'});await service.publishInstructionProfile(research);
  const take=await service.create();await service.update(take,{instructionProfileId:research,instructions:'Hidden legacy text'});
  await service.send({requestId:randomUUID(),takeId:take,parentId:null,text:'Hello',selection});await settle(service);
  const [prompt]=prompts;const order=['<opentake_requirements>','Host permissions are authoritative','<about_user>','Long-term ETF investor','<instructions>','Research carefully'].map(part=>prompt.indexOf(part));
  expect(order[0]).toBe(0);expect(order.every((n,i)=>n>=0&&(i===0||n>order[i-1]))).toBe(true);expect(prompt).not.toContain('Hidden legacy text');
  expect((await service.instructions()).about).toBe('Long-term ETF investor');
  await service.saveAbout('');await service.send({requestId:randomUUID(),takeId:take,parentId:null,text:'Again',selection});await settle(service);expect(prompts[1]).not.toContain('<about_user>');
  await expect(service.saveAbout('x'.repeat(6001))).rejects.toThrow();
 }finally{await service.close();await db.close();}
});

test('attachment cleanup removes abandoned drafts and expired staging but preserves every message branch',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const service=createTakes(lifecycle,async i=>{i.text('Reply');},models);await service.start();
 try{
  const id=await service.create();
  const upload=async()=>service.storeImage(id,{id:randomUUID(),name:'Synthetic.png',mime:'image/png',width:1,height:1,bytes:1},'AA==');
  const draft=await upload();await service.update(id,{draftImages:[draft.id]});await service.update(id,{draftImages:[]});
  await expect(service.image(draft.id)).rejects.toThrow('Image unavailable');
  const sent=await upload();await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Image',images:[sent.id],selection});await settle(service);
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Other branch',selection});await settle(service);
  const abandoned=await upload();const pending=await upload();
  await db.query("UPDATE take_attachments SET staged_until=now()-interval '1 second' WHERE id=$1",[abandoned.id]);
  await service.start();
  await expect(service.image(abandoned.id)).rejects.toThrow('Image unavailable');
  expect(await service.image(sent.id)).toContain('AA==');expect(await service.image(pending.id)).toContain('AA==');
  expect((await service.load(id)).messages.map(m=>m.role)).toEqual(['user','assistant','user','assistant']);
 }finally{await service.close();await db.close();}
});

test('saved instruction sets persist per chat and snapshot prompts across edits and deletion',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const prompts:string[]=[];const service=createTakes(lifecycle,async i=>{prompts.push(i.instructions);i.text('Done');},models,async()=>[],'App defaults');
 try{
  await service.start();const general=(await service.instructionProfiles())[0];await service.saveInstructionProfile({id:general.id,name:'General',text:'Existing global instructions'});await service.publishInstructionProfile(general.id);
  const first=await service.saveInstructionProfile({name:'Research',text:'Research carefully'});
  const other=await service.saveInstructionProfile({name:'Concise',text:'Be concise'});
  await service.publishInstructionProfile(first);await service.publishInstructionProfile(other);
  await expect(service.saveInstructionProfile({name:'research',text:'Duplicate'})).rejects.toThrow('already exists');
  await expect(service.saveInstructionProfile({name:' ',text:'Invalid'})).rejects.toThrow();
  await expect(service.saveInstructionProfile({id:randomUUID(),name:'Missing',text:''})).rejects.toThrow('no longer exists');
  const a=await service.create();const b=await service.create();
  await service.update(a,{instructionProfileId:first});await service.update(b,{instructionProfileId:other});
  await service.update(a,{instructions:'Chat-specific context'});
  await service.send({requestId:randomUUID(),takeId:a,parentId:null,text:'Hello',selection});await settle(service);
  expect(prompts[0]).toContain('Research carefully');expect(prompts[0]).not.toContain('Chat-specific context');expect(prompts[0]).toContain('Host permissions are authoritative');expect(prompts[0]).not.toContain('Existing global instructions');
  await service.saveInstructionProfile({id:first,name:'Deep research',text:'Updated research'});
  await service.publishInstructionProfile(first);
  await service.send({requestId:randomUUID(),takeId:a,parentId:null,text:'Again',selection});await settle(service);expect(prompts[1]).toContain('Updated research');
  const run=await db.query<{configuration:{instructions:string;instructionProfile:{id:string;name:string}}}>('SELECT configuration FROM take_runs ORDER BY created_at');
  expect(run.rows[0].configuration.instructions).toContain('Research carefully');expect(run.rows[0].configuration.instructionProfile).toMatchObject({id:first,name:'Research'});
  await service.removeInstructionProfile(first);
  expect((await service.load(a)).instructionProfileId).toBeNull();expect((await service.load(b)).instructionProfileId).toBe(other);
  await expect(service.send({requestId:randomUUID(),takeId:a,parentId:null,text:'Stale',selection,instructionProfileId:first})).rejects.toThrow('no longer exists');
  await service.send({requestId:randomUUID(),takeId:a,parentId:null,text:'Default',selection});await settle(service);expect(prompts[2]).toContain('Existing global instructions');
  await service.send({requestId:randomUUID(),takeId:a,parentId:null,text:'Select at send',selection,instructionProfileId:other});await settle(service);expect(prompts[3]).toContain('Be concise');expect((await service.load(a)).instructionProfileId).toBe(other);
  await service.close();const reopened=createTakes(lifecycle,async()=>{},models);expect((await reopened.instructionProfiles()).map(p=>p.name)).toEqual(['General','Concise']);expect((await reopened.load(a)).instructionProfileId).toBe(other);await reopened.close();
 }finally{await service.close();await db.close();}
});


test('instruction profile migration preserves existing defaults and chats',async()=>{
 const db=new PGlite();
 try{
  await migrate(db,migrations.filter(m=>m.version<9));
  const id=randomUUID();
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Existing chat',$2 FROM local_owners",[id,JSON.stringify(selection)]);
  await db.query("INSERT INTO ai_instruction_revisions(id,text,mode) VALUES($1,'Keep these instructions','custom')",[randomUUID()]);
  await migrate(db);
  const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async()=>{},models);
  expect((await service.load(id)).instructionProfileId).toBeNull();expect((await service.load(id)).title).toBe('Existing chat');
  expect((await service.instructionProfiles()).map(p=>[p.name,p.text,p.followsDefault])).toEqual([['General','Keep these instructions',false]]);
  await service.close();
 }finally{await db.close();}
});

test('tool-result history is persisted for follow-ups but omitted from renderer snapshots',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};let calls=0;
 const service=createTakes(lifecycle,async input=>{
  if(calls++===0){input.replay?.({role:'assistant',content:[{type:'tool_use',id:'lookup',name:'mcp__opentake__marker',input:{}}]});input.replay?.({role:'user',content:[{type:'tool_result',tool_use_id:'lookup',content:'SYNTHETIC-TOOL-RESULT',is_error:false}]});input.replay?.({role:'assistant',content:[{type:'text',text:'Looked up marker'}]});input.text('Looked up marker');}
  else{expect(JSON.stringify(input.messages)).toContain('SYNTHETIC-TOOL-RESULT');input.text('Remembered');}
 },models);
 try{await service.start();const id=await service.create();await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Look up',selection});await settle(service);
  const take=await service.load(id);expect(JSON.stringify(take)).toContain('SYNTHETIC-TOOL-RESULT');expect(JSON.stringify(await service.snapshot(id,false,undefined))).not.toContain('SYNTHETIC-TOOL-RESULT');
  await service.send({requestId:randomUUID(),takeId:id,parentId:take.headId,text:'Recall',selection});await settle(service);expect(calls).toBe(2);
 }finally{await service.close();await db.close();}
});


test('a failed reply records whether a budget or a fixed limit stopped it',async()=>{
 const db=new PGlite();await migrate(db);const errors=[new BudgetLimitError('Response reached its reported output-token threshold.'),new RunLimitError('Response reached its 20 tool-call limit.'),new Error('Claude stopped before completing.')];let call=0;
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async input=>{input.text('Partial');throw errors[call++];},models);
 try{await service.start();const id=await service.create();let parentId:string|null=null;
  for(const _ of errors){await service.send({requestId:randomUUID(),takeId:id,parentId,text:'Go',selection});await settle(service);parentId=(await service.load(id)).headId;}
  const replies=(await service.load(id)).messages.filter(m=>m.role==='assistant');
  expect(replies.map(m=>[m.state,m.stopReason])).toEqual([['failed','budget'],['failed','limit'],['failed',undefined]]);
 }finally{await service.close();await db.close();}
});

test('sends from the thread keep the unsent draft; composer sends clear it',async()=>{
 const db=new PGlite();await migrate(db);
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async input=>{input.text('Reply');},models);
 try{await service.start();const id=await service.create();
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'First',selection});await settle(service);
  await service.update(id,{draft:'Half-typed question'});
  const reply=(await service.load(id)).headId;
  await service.send({requestId:randomUUID(),takeId:id,parentId:reply,text:'Continue from where you stopped.',selection,keepDraft:true});await settle(service);
  expect((await service.load(id)).draft).toBe('Half-typed question');
  await service.send({requestId:randomUUID(),takeId:id,parentId:(await service.load(id)).headId,text:'Half-typed question',selection});await settle(service);
  expect((await service.load(id)).draft).toBe('');
 }finally{await service.close();await db.close();}
});

test('mode drafts are isolated until publish and tool selections narrow global access',async()=>{
 const db=new PGlite();await migrate(db);const prompts:string[]=[];
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async i=>{prompts.push(i.instructions);i.text('Done');},models,async()=>[{server:'a',name:'read',policy:'ask'},{server:'a',name:'other'}]);
 try{
  const config={description:'Research',guidance:'Ask one question',details:'Clarify scope',completion:'Summarize for review',tools:['a/read','a/blocked']};
  const id=await service.saveInstructionProfile({name:'Draft mode',text:'First version',config});const take=await service.create();
  await expect(service.send({requestId:randomUUID(),takeId:take,parentId:null,text:'Hello',selection,instructionProfileId:id})).rejects.toThrow('Apply these instructions');
  await service.publishInstructionProfile(id);
  await service.saveInstructionProfile({id,name:'Working draft',text:'Unpublished changes',config:{...config,tools:[]}});
  await service.send({requestId:randomUUID(),takeId:take,parentId:null,text:'Hello',selection,instructionProfileId:id});await settle(service);
  expect(prompts[0]).toContain('First version');expect(prompts[0]).toContain('Ask one question');expect(prompts[0]).not.toContain('Unpublished changes');
  const run=(await db.query<{configuration:{tools:unknown[];instructionProfile:{version:number;name:string}}}>('SELECT configuration FROM take_runs')).rows[0].configuration;
  expect(run.tools).toEqual([{server:'a',name:'read',policy:'ask'}]);expect(run.instructionProfile).toMatchObject({version:1,name:'Draft mode'});
  await service.publishInstructionProfile(id);
  await service.send({requestId:randomUUID(),takeId:take,parentId:null,text:'Again',selection});await settle(service);expect(prompts[1]).toContain('Unpublished changes');
  const runs=await db.query<{configuration:{tools:unknown[]}}>('SELECT configuration FROM take_runs ORDER BY created_at');expect(runs.rows[1].configuration.tools).toEqual([]);
  const history=await service.instructionVersions(id);expect(history.map(v=>v.version)).toEqual([2,1]);expect(history[1].text).toBe('First version');
 }finally{await service.close();await db.close();}
});


test('take approval mode defaults to Auto, persists Ask and is fixed for a running response',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const executor:TakeExecutor=async input=>{await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));};
 const service=createTakes(lifecycle,executor,models);await service.start();
 try{
  const id=await service.create();expect((await service.load(id)).permissionMode).toBe('auto');
  await service.update(id,{permissionMode:'ask'});expect((await service.load(id)).permissionMode).toBe('ask');
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Check a tool',selection});
  const saved=(await db.query<{configuration:{permissionMode:string}}>('SELECT configuration FROM take_runs WHERE take_id=$1',[id])).rows[0];expect(saved.configuration.permissionMode).toBe('ask');
  await expect(service.update(id,{permissionMode:'auto'})).rejects.toThrow('Stop the response');
  await service.stop(id);await service.close();
  const reopened=createTakes(lifecycle,executor,models);await reopened.start();
  try{expect((await reopened.load(id)).permissionMode).toBe('ask');await reopened.update(id,{permissionMode:'auto'});expect((await reopened.load(id)).permissionMode).toBe('auto');expect((await reopened.load(await reopened.create())).permissionMode).toBe('auto');}finally{await reopened.close();}
 }finally{await service.close();await db.close();}
});

test('image capability is checked for follow-ups and regeneration before persisting a run',async()=>{
 const db=new PGlite();await migrate(db);let support=true;let calls=0;
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async i=>{calls++;i.text('Done');},async()=>({ok:true,source:'runtime',models:[{value:'sonnet',label:'Sonnet',imageInput:support}]}));
 try{
  await service.start();const id=await service.create();const img=await service.storeImage(id,{id:randomUUID(),name:'x.jpg',mime:'image/jpeg',width:1,height:1,bytes:1},'AA==');
  expect(await service.image(img.id)).toBe('data:image/jpeg;base64,AA==');
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Look',images:[img.id],selection});await settle(service);
  const take=await service.load(id);support=false;
  await expect(service.send({requestId:randomUUID(),takeId:id,parentId:take.headId,text:'Follow up',selection})).rejects.toThrow('not verified');
  await expect(service.send({requestId:randomUUID(),takeId:id,parentId:take.messages[0].id,text:'',regenerate:true,selection})).rejects.toThrow('not verified');
  expect((await service.load(id)).messages).toHaveLength(2);expect(calls).toBe(1);
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Text-only branch',selection});await settle(service);expect(calls).toBe(2);
 }finally{await service.close();await db.close();}
});

test('provider switches dispatch the selected adapter with retained branch history and preserve failures',async()=>{
 const db=new PGlite();await migrate(db);const seen:Parameters<TakeExecutor>[0][]=[];
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async i=>{seen.push(i);if(i.selection.provider==='opencode')throw new Error('OpenCode CLI version is not verified for chat.');i.text('Synthetic reply');},models);
 try{await service.start();const id=await service.create();
  await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'First',selection:{provider:'chatgpt',model:'sonnet'}});await settle(service);
  const first=await service.load(id);expect(first.messages.at(-1)?.selection.provider).toBe('chatgpt');
  await service.send({requestId:randomUUID(),takeId:id,parentId:first.headId,text:'Switch',selection:{provider:'opencode',model:'sonnet'}});await settle(service);
  expect(seen.map(i=>i.selection.provider)).toEqual(['chatgpt','opencode']);expect(seen[1].messages.map(m=>m.text)).toEqual(['First','Synthetic reply','Switch']);
  expect((await service.load(id)).messages.at(-1)).toMatchObject({state:'failed',error:'OpenCode CLI version is not verified for chat.'});
 }finally{await service.close();await db.close();}
});


test.each(['completed','cancelled','failed'] as const)('active take marker follows the running chat and clears when %s',async outcome=>{
 const db=new PGlite();await migrate(db);
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async input=>{
  input.signal.addEventListener('abort',release,{once:true});
  if(input.signal.aborted)release();
  await gate;
  if(outcome==='failed')throw new Error('Synthetic execution failure');
  if(!input.signal.aborted)input.text('Done');
 },models);
 try{
  await service.start();const working=await service.create(),other=await service.create();
  expect((await service.snapshot(working,false,undefined))?.activeTakeId).toBeNull();
  await service.send({requestId:randomUUID(),takeId:working,parentId:null,text:'Start',selection});
  const original=await service.snapshot(working,false,undefined);
  expect(original).toMatchObject({running:true,activeTakeId:working});
  expect(await service.snapshot(other,false,undefined)).toMatchObject({running:false,activeTakeId:null,activeTakeIds:[working],take:{id:other}});
  expect(await service.snapshot(null,false,undefined)).toMatchObject({running:false,activeTakeId:null,activeTakeIds:[working]});
  if(outcome==='cancelled')await service.stop(working);else release();
  await settle(service);
  expect(await service.snapshot(working,false,original!.revision)).toMatchObject({running:false,activeTakeId:null});
  expect((await service.load(working)).messages.find(m=>m.role==='assistant')?.state).toBe(outcome);
 }finally{release();await service.close();await db.close();}
});

test('separate takes run concurrently with isolated cancellation, authorization and shutdown',async()=>{
 const db=new PGlite();await migrate(db);
 const runs=new Map<string,Parameters<TakeExecutor>[0]>();
 const service=createTakes({use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async input=>{
  runs.set(input.takeId,input);input.text(`Reply for ${input.takeId}`);
  await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));
 },models);
 await service.start();
 try{
  const a=await service.create(),b=await service.create();
  const send=(id:string)=>service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Start',selection});
  await send(a);await send(b);
  expect(service.activeRun(runs.get(a)!.id)).toBe(true);expect(service.activeRun(runs.get(b)!.id)).toBe(true);
  expect((await service.snapshot(null,false,undefined))?.running).toBe(false);
  expect((await service.snapshot(a,false,undefined))?.activeTakeIds).toEqual([a,b]);
  expect((await service.snapshot(b,false,undefined))?.running).toBe(true);
  await expect(send(a)).rejects.toThrow('current response in this take');
  await service.stop(a);
  expect(service.activeRun(runs.get(a)!.id)).toBe(false);expect(service.activeRun(runs.get(b)!.id)).toBe(true);
  expect(service.busy()).toBe(true);
  expect((await service.load(a)).messages.at(-1)?.text).toBe(`Reply for ${a}`);
  await send(a);await service.close();
  expect(service.busy()).toBe(false);
  expect(runs.get(a)!.signal.aborted).toBe(true);expect(runs.get(b)!.signal.aborted).toBe(true);
  expect((await service.load(b)).messages.at(-1)?.text).toBe(`Reply for ${b}`);
 }finally{await service.close();await db.close();}
});


test('effort is validated before a run and persists with messages and take selection', async () => {
 const db=new PGlite();await migrate(db);const lifecycle={use:async <T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const seen:unknown[]=[];
 const service=createTakes(lifecycle,async input=>{seen.push(input.selection);input.text('Done');},async()=>({ok:true,source:'runtime',models:[{value:'sonnet',label:'Sonnet',effortLevels:['low','high']}]}));
 try {
  await service.start();const id=await service.create();
  const request={requestId:randomUUID(),takeId:id,parentId:null,text:'Test',selection:{...selection,effort:'max'}};
  await expect(service.send(request)).rejects.toThrow('thinking effort is unavailable');expect(seen).toHaveLength(0);
  await service.send({...request,selection:{...selection,effort:'high'}});await settle(service);
  expect(seen).toEqual([{...selection,effort:'high'}]);
  const take=await service.load(id);expect(take.selection.effort).toBe('high');expect(take.messages.every(m=>m.selection.effort==='high')).toBe(true);
  await service.send({...request,requestId:randomUUID(),parentId:take.headId,selection});await settle(service);
  expect((await service.load(id)).selection).not.toHaveProperty('effort');
 } finally {await service.close();await db.close();}
});
