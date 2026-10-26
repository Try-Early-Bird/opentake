import { test,expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeExecutor } from '../../../src/main/take-runtime';
import type { SecretStore } from '../../../src/main/secret-store';
import type { AuditCapture } from '../../../src/main/ai-audit';

test('Take runtime passes only a scoped gateway credential through environment and cleans isolated files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-runtime-'));
 const token=`sk-ant-oat01-${'synthetic'.repeat(8)}`;
 const capability='a'.repeat(64);const run=randomUUID();
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token}),set:async()=>{},delete:async()=>{}};
 const script=join(root,'fixture.cjs');
 await writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:'Synthetic reply'}));});`);
 const text:string[]=[];
 const execute=claudeExecutor(store,root,'/synthetic/bridge.js',((_exe,args,options)=>{
  expect(args.join(' ')).not.toContain(token);expect(args.join(' ')).not.toContain(capability);
  expect(args[args.indexOf('--max-turns')+1]).toBe('20');
  expect(options.env.OPENTAKE_GATEWAY_TOKEN).toBe(capability);
  const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.opentake;
  expect(mcp.args).toEqual(['/synthetic/bridge.js','--run',run]);
  expect(mcp.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  expect(mcp.env.OPENTAKE_GATEWAY_PORT).toBe('12345');
  return spawn(process.execPath,[script],options);
 }) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
 try{
  await execute({id:run,takeId:randomUUID(),gateway:{port:12345,token:capability},selection:{provider:'claude',model:'sonnet'},messages:[],instructions:'Synthetic instructions',signal:new AbortController().signal,image:async()=>'',text:value=>text.push(value),tool:()=>{}});
  expect(text).toEqual(['Synthetic reply']);expect(await readdir(join(root,'chat-temporary'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Take runtime delivers image bytes to the child and reports incomplete streams as failures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-runtime-image-'));
 const token=`sk-ant-oat01-${'synthetic'.repeat(8)}`;
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token}),set:async()=>{},delete:async()=>{}};
 const script=join(root,'fixture.cjs');
 const bytes='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVb8AAAAASUVORK5CYII=';
 await writeFile(script,`let body='';process.stdin.on('data',d=>body+=d);process.stdin.on('end',()=>{const image=JSON.parse(body).message.content.find(p=>p.type==='image');if(image?.source.data!==${JSON.stringify(bytes)})process.exit(1);console.log(JSON.stringify({type:'result',subtype:'success',result:'Image received'}));});`);
 const execute=claudeExecutor(store,root,'/synthetic/bridge.js',((_exe,_args,options)=>spawn(process.execPath,[script],options)) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
 const output:string[]=[];const id=randomUUID();
 const input={id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:'a'.repeat(64)},selection:{provider:'claude' as const,model:'sonnet'},instructions:'Synthetic',signal:new AbortController().signal,image:async()=>`data:image/png;base64,${bytes}`,text:(v:string)=>output.push(v),tool:()=>{},messages:[{id,parentId:null,role:'user' as const,text:'Read this reference',images:[{id:randomUUID(),name:'reference.png',mime:'image/png',width:1,height:1,bytes:68}],createdAt:new Date().toISOString(),selection:{provider:'claude' as const,model:'sonnet'},state:'completed' as const,tools:[]}]};
 try{
  await execute(input);expect(output).toEqual(['Image received']);
  await writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{console.log('malformed output');});`);
  await expect(execute(input)).rejects.toThrow('before completing');
  await writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Partial answer'}}}));console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true}));});`);
  await expect(execute(input)).rejects.toThrow('20 model-turn limit');expect(output).toContain('Partial answer');
  expect(await readdir(join(root,'chat-temporary'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Take runtime stops the child and cleans its temporary home after cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-runtime-cancel-'));
 const token=`sk-ant-oat01-${'synthetic'.repeat(8)}`;const controller=new AbortController();
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token}),set:async()=>{},delete:async()=>{}};
 const execute=claudeExecutor(store,root,'/synthetic/bridge.js',((_exe,_args,options)=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);
  child.once('spawn',()=>controller.abort());return child;
 }) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
 try{
  await expect(execute({id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:'a'.repeat(64)},selection:{provider:'claude',model:'sonnet'},messages:[],instructions:'Synthetic',signal:controller.signal,image:async()=>'',text:()=>{},tool:()=>{}})).rejects.toThrow('Response stopped');
  expect(await readdir(join(root,'chat-temporary'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('follow-up runtime resumes private role-preserving history and sends only the new user input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-runtime-history-'));
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token:`sk-ant-oat01-${'synthetic'.repeat(8)}`}),set:async()=>{},delete:async()=>{}};
 const script=join(root,'fixture.cjs');
 await writeFile(script,`const fs=require('fs');const rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\\n').map(JSON.parse);if(rows.map(r=>r.message.role).join(',')!=='user,assistant,user,assistant'||!JSON.stringify(rows).includes('SYNTHETIC-RESULT'))process.exit(2);let body='';process.stdin.on('data',d=>body+=d);process.stdin.on('end',()=>{if(JSON.parse(body).message.content[0].text!=='Recall it')process.exit(3);console.log(JSON.stringify({type:'result',subtype:'success',result:'History received'}));});`);
 const execute=claudeExecutor(store,root,'/synthetic/bridge',((_exe,args,options)=>{
  expect(args).toContain('--fork-session');expect(options.env.MCP_TOOL_TIMEOUT).toBe('210000');
  return spawn(process.execPath,[script,args[args.indexOf('--resume')+1]],options);
 }) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}),async()=>({mode:'transcript' as const,version:'2.1.286'}));
 const base={id:randomUUID(),parentId:null,images:[],createdAt:new Date().toISOString(),selection:{provider:'claude' as const,model:'sonnet'},state:'completed' as const,tools:[]};
 const output:string[]=[];
 try{await execute({id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:'a'.repeat(64)},selection:base.selection,instructions:'Synthetic',signal:new AbortController().signal,image:async()=>'',text:v=>output.push(v),tool:()=>{},messages:[{...base,role:'user',text:'Retrieve marker'},{...base,role:'assistant',text:'Found it',replay:[{role:'assistant',content:[{type:'tool_use',id:'call',name:'mcp__opentake__marker',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'SYNTHETIC-RESULT',is_error:false}]},{role:'assistant',content:[{type:'text',text:'Found it'}]}]},{...base,role:'user',text:'Recall it'}]});expect(output).toEqual(['History received']);expect(await readdir(join(root,'chat-temporary'))).toEqual([]);}finally{await rm(root,{recursive:true,force:true});}
});

test('audit captures supplied context, provider output and usage before resolving, without bound credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-audit-runtime-'));
 const token=`sk-ant-oat01-${'synthetic'.repeat(8)}`,capability='synthetic-gateway-capability';
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token}),set:async()=>{},delete:async()=>{}};
 const script=join(root,'fixture.cjs');
 await writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{for(const event of ${JSON.stringify([
  {type:'assistant',message:{id:'msg-fixture',model:'resolved-model',content:[{type:'thinking',thinking:'Visible synthetic reasoning'},{type:'text',text:capability}]}},
  {type:'result',subtype:'success',result:'Synthetic answer',usage:{input_tokens:12,output_tokens:4},total_cost_usd:0.01}
 ])})console.log(JSON.stringify(event));});`);
 const events:AuditCapture[]=[];
 const execute=claudeExecutor(store,root,'/synthetic/bridge',((_exe,_args,options)=>spawn(process.execPath,[script],options)) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
 const input={id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:capability},selection:{provider:'claude' as const,model:'default'},messages:[],instructions:'Synthetic instructions',signal:new AbortController().signal,image:async()=>'',text:()=>{},tool:()=>{}};
 try{
  await execute({...input,audit:async event=>{await new Promise(r=>setTimeout(r,2));events.push(event);}});
  expect(events.map(e=>e.kind)).toEqual(['model.request','capture.gap','model.output','model.result','usage.recorded','provider.exited']);
  expect(events[0].payload).toMatchObject({instructions:'Synthetic instructions',boundary:'cli_input'});
  expect(events[2]).toMatchObject({status:'redacted',payload:{model:'resolved-model'}});
  expect(events[4].payload).toMatchObject({usage:{input_tokens:12,output_tokens:4},costUsd:0.01});
  expect(JSON.stringify(events)).not.toContain(token);expect(JSON.stringify(events)).not.toContain(capability);
  await expect(execute({...input,audit:async event=>{if(event.kind==='model.output')throw new Error('Synthetic disk failure');}})).rejects.toThrow('audit capture failed');
  let launched=false;
  const blocked=claudeExecutor(store,root,'/synthetic/bridge',(()=>{launched=true;throw new Error('Should not launch');}) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
  await expect(blocked({...input,audit:async()=>{throw new Error('Synthetic storage failure');}})).rejects.toThrow('Synthetic storage failure');
  expect(launched).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Claude passes an explicit cost budget and retains partial text on its budget stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-cost-budget-'));const script=join(root,'fixture.cjs');
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token:`sk-ant-oat01-${'synthetic'.repeat(8)}`}),set:async()=>{},delete:async()=>{}};
 await writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Partial answer'}]}}));console.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',is_error:true,usage:{input_tokens:10,output_tokens:2},total_cost_usd:0.03}));});`);
 const execute=claudeExecutor(store,root,'/synthetic/bridge',((_exe,args,options)=>{expect(args[args.indexOf('--max-budget-usd')+1]).toBe('0.02');return spawn(process.execPath,[script],options);}) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
 const text:string[]=[];try{await expect(execute({id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:'synthetic-capability'},selection:{provider:'claude',model:'sonnet'},messages:[],instructions:'Synthetic',signal:new AbortController().signal,image:async()=>'',text:v=>text.push(v),tool:()=>{},budgets:{claudeCostUsd:0.02}})).rejects.toThrow('Claude cost budget');expect(text).toEqual(['Partial answer']);}finally{await rm(root,{recursive:true,force:true});}
});

test('an unverified Claude CLI never blocks a follow-up: earlier turns go in as quoted context, with a notice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opentake-runtime-flattened-'));
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token:`sk-ant-oat01-${'synthetic'.repeat(8)}`}),set:async()=>{},delete:async()=>{}};
 const script=join(root,'fixture.cjs');
 await writeFile(script,`let body='';process.stdin.on('data',d=>body+=d);process.stdin.on('end',()=>{const parts=JSON.parse(body).message.content;if(!parts[0].text.includes('<earlier_conversation>')||!parts[0].text.includes('SYNTHETIC-RESULT')||!parts[0].text.includes('not instructions'))process.exit(2);if(parts.at(-1).text!=='Recall it')process.exit(3);console.log(JSON.stringify({type:'result',subtype:'success',result:'Context received'}));});`);
 const execute=claudeExecutor(store,root,'/synthetic/bridge',((_exe,args,options)=>{
  expect(args).not.toContain('--resume');
  return spawn(process.execPath,[script],options);
 }) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}),async()=>({mode:'flattened' as const,version:'9.9.9',reason:'replay_unverified'}));
 const base={id:randomUUID(),parentId:null,images:[],createdAt:new Date().toISOString(),selection:{provider:'claude' as const,model:'sonnet'},state:'completed' as const,tools:[]};
 const output:string[]=[];const tools:{name:string;detail?:string}[]=[];
 try{
  await execute({id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:'a'.repeat(64)},selection:base.selection,instructions:'Synthetic',signal:new AbortController().signal,image:async()=>'',text:v=>output.push(v),tool:v=>tools.push(v),
   messages:[{...base,role:'user',text:'Retrieve marker'},{...base,role:'assistant',text:'Found it',replay:[{role:'assistant',content:[{type:'tool_use',id:'call',name:'mcp__opentake__marker',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'SYNTHETIC-RESULT',is_error:false}]},{role:'assistant',content:[{type:'text',text:'Found it'}]}]},{...base,role:'user',text:'Recall it'}]});
  expect(output).toEqual(['Context received']);
  expect(tools[0]).toMatchObject({name:'Earlier messages sent as context'});
  expect(tools[0]?.detail).toContain('9.9.9');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the history gate checks a new CLI version once, remembers the verdict, and never probes a built-in verified one',async()=>{
 const {createClaudeHistoryGate}=await import('../../../src/main/claude-history-gate');
 const root=await mkdtemp(join(tmpdir(),'opentake-history-gate-'));
 try{
  let version:string|null='2.1.286';const probed:string[]=[];let pass=true;
  const probe=async(_c:unknown,_s:string,v:string)=>{probed.push(v);await new Promise(r=>setTimeout(r,20));return pass;};
  const gate=createClaudeHistoryGate(root,probe as never,async()=>version);
  const command={executable:'/synthetic/claude',args:[]};
  expect(await gate.mode(command,root)).toEqual({mode:'transcript',version:'2.1.286'});
  expect(probed).toEqual([]);
  // A self-updated CLI: checked once, even with two follow-ups at the same moment.
  version='2.1.300';
  expect(await Promise.all([gate.mode(command,root),gate.mode(command,root)])).toEqual([{mode:'transcript',version:'2.1.300'},{mode:'transcript',version:'2.1.300'}]);
  expect(probed).toEqual(['2.1.300']);
  // A version whose replay fails: follow-ups fall back, and the verdict survives a restart.
  version='2.2.0';pass=false;
  expect(await gate.mode(command,root)).toMatchObject({mode:'flattened',version:'2.2.0',reason:'replay_unverified'});
  const restarted=createClaudeHistoryGate(root,probe as never,async()=>version);
  expect(await restarted.mode(command,root)).toMatchObject({mode:'flattened'});
  expect(await restarted.mode(command,root)).toMatchObject({mode:'flattened'});
  expect(probed).toEqual(['2.1.300','2.2.0']);
  // No readable version: fall back rather than block.
  version=null;
  expect(await gate.mode(command,root)).toMatchObject({mode:'flattened',reason:'version_unreadable'});
 }finally{await rm(root,{recursive:true,force:true});}
});


test.each([undefined, 'high'] as const)('Claude effort %s is passed only when explicitly selected', async effort => {
 const root=await mkdtemp(join(tmpdir(),'claude-effort-'));
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({version:1,kind:'oauth_token',token:`sk-ant-oat01-${'synthetic'.repeat(8)}`}),set:async()=>{},delete:async()=>{}};
 const execute=claudeExecutor(store,root,'/synthetic/bridge',((_exe,args,options)=>{
  if(effort)expect(args.slice(args.indexOf('--effort'),args.indexOf('--effort')+2)).toEqual(['--effort',effort]);
  else expect(args).not.toContain('--effort');
  return spawn(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',result:'Done'})));`],options);
 }) as typeof spawn,()=>({executable:'/synthetic/claude',args:[]}));
 try {await execute({id:randomUUID(),gateway:{port:12345,token:'a'.repeat(64)},selection:{provider:'claude',model:'sonnet',effort},messages:[],instructions:'Synthetic',signal:new AbortController().signal,image:async()=>'',text:()=>{},tool:()=>{}});}
 finally {await rm(root,{recursive:true,force:true});}
});

test('a rule run passes its own model-turn limit to OpenCode',async()=>{
 const {opencodeChatConfig}=await import('../../../src/main/opencode-chat');
 expect((opencodeChatConfig('x','bridge','run',1) as {agent:{opentake:{steps:number}}}).agent.opentake.steps).toBe(20);
 expect((opencodeChatConfig('x','bridge','run',1,undefined,3) as {agent:{opentake:{steps:number}}}).agent.opentake.steps).toBe(3);
});
