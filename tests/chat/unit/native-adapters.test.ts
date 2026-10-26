import { createSecretStore } from '../../../src/main/secret-store';
import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexExecutor, persistCodexRefresh } from '../../../src/main/codex-chat';
import { opencodeExecutor } from '../../../src/main/opencode-chat';
import { nativeChatVersion, isolatedChatEnv, nativeCapture, secretCleaner, nativeFailure } from '../../../src/main/native-chat-process';
import { nativeHistory, codexHistory, opencodeHistory } from '../../../src/main/native-chat-history';
import type { RunInput } from '../../../src/main/take-runtime';
import type { SecretStore } from '../../../src/main/secret-store';
import type { TakeMessage, ReplayMessage, ToolActivity } from '../../../src/shared/takes';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVb8AAAAASUVORK5CYII=';
const token='synthetic-provider-token',gateway='a'.repeat(64);
const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,refresh_token:'synthetic-refresh'}}),set:async()=>{},delete:async()=>{}};
function message(role:'user'|'assistant',text:string):TakeMessage {return {id:randomUUID(),parentId:null,role,text,images:[],createdAt:new Date().toISOString(),selection:{provider:'claude',model:'synthetic'},state:'completed',tools:[]};}
function input(provider:'chatgpt'|'opencode',signal=new AbortController().signal) {
 const text:string[]=[],replay:ReplayMessage[]=[],tools:ToolActivity[]=[],audit:unknown[]=[];
 const run:RunInput={id:randomUUID(),takeId:randomUUID(),gateway:{port:12345,token:gateway},selection:{provider,model:'synthetic'},messages:[message('user','Hello')],instructions:'Synthetic instructions',signal,image:async()=>png,text:v=>text.push(v),replay:v=>replay.push(v),tool:v=>tools.push(v),audit:async e=>{audit.push(e);}};
 return {run,text,replay,tools,audit};
}
test('cross-provider replay preserves roles, images, tool results and unknown outcomes',async()=>{
 const user=message('user','Question');user.images=[{id:'img',name:'ref.png',mime:'image/png',width:1,height:1,bytes:68}];
 const assistant=message('assistant','Answer');assistant.replay=[{role:'assistant',content:[{type:'tool_use',id:'known',name:'mcp__opentake__marker',input:{q:1}},{type:'tool_use',id:'missing',name:'mcp__opentake__marker',input:{q:2}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'known',content:'SYNTHETIC-RESULT',is_error:false}]},{role:'assistant',content:[{type:'text',text:'Answer'}]}];
 const history=await nativeHistory([user,assistant],async()=>png);const codex=codexHistory(history);
 expect(codex).toContainEqual({type:'message',role:'user',content:[{type:'input_image',image_url:png}]});
 expect(codex).toContainEqual({type:'message',role:'assistant',content:[{type:'output_text',text:'Answer'}]});
 expect(JSON.stringify(codex)).toContain('SYNTHETIC-RESULT');expect(JSON.stringify(codex)).toContain('outcome is unknown');
 const open=opencodeHistory(history,'/synthetic','synthetic','1.14.25');expect(open.messages.map(m=>m.info.role)).toEqual(['user','assistant','assistant']);
 expect(JSON.stringify(open)).toContain('SYNTHETIC-RESULT');expect(JSON.stringify(open)).toContain('outcome is unknown');
 assistant.replay[0].content=[{type:'tool_use',id:'bad',name:'Bash',input:{}}];await expect(nativeHistory([user,assistant],async()=>png)).rejects.toThrow('unsupported tool');
});
test('a CLI that updated itself still chats: its version is reported, never refused; environment excludes inherited secrets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-version-')),script=join(root,'version.cjs');
 try{await writeFile(script,"console.log('codex-cli 99.0.0')");
  expect(await nativeChatVersion('chatgpt',{executable:process.execPath,args:[script]},root,new AbortController().signal)).toEqual({version:'99.0.0',verified:false});
  expect(await nativeChatVersion('chatgpt',{executable:process.execPath,args:[join(root,'missing.cjs')]},root,new AbortController().signal)).toEqual({version:null,verified:false});
  // The unknown version goes on to the run: here it stops only because no credential is connected.
  let read=false;const execute=codexExecutor({...store,get:async()=>{read=true;return null;}},root,{command:()=>({executable:process.execPath,args:[script]})});
  await expect(execute(input('chatgpt').run)).rejects.toThrow('Connect ChatGPT in Settings');expect(read).toBe(true);expect(await readdir(join(root,'chat-temporary'))).toEqual([]);
  const env=isolatedChatEnv(root,{executable:process.execPath,args:[]});expect(env.OPENAI_API_KEY).toBeUndefined();expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();expect(env.HOME).toBe(root);
 }finally{await rm(root,{recursive:true,force:true});}
});
const codexFixture=String.raw`
const emit=v=>console.log(JSON.stringify(v));const mode=process.argv[2];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const e=JSON.parse(line);if(e.id===undefined)return;
 if(e.id===987&&e.result){emit({method:'item/completed',params:{threadId:'thread',item:{id:'text',type:'agentMessage',text:'Reply synthetic-provider-token '+ 'a'.repeat(64)}}});emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});return;}
 if(e.method==='initialize'){emit({id:e.id,result:{}});return;}
 if(e.method==='thread/start'){
  if(e.params.environments.length||e.params.config.features.shell_tool!==false||e.params.dynamicTools[0].name!=='opentake_marker')process.exit(3);
  emit({id:e.id,result:{thread:{id:'thread'}}});return;
 }
 if(e.method==='thread/inject_items'){if(mode==='noinject'){emit({id:e.id,error:{code:-32601,message:'Method not found'}});return;}emit({id:e.id,result:{}});return;}
 if(e.method==='turn/start'){
  if(mode==='noinject'&&!(e.params.input[0].text||'').includes('<earlier_conversation>'))process.exit(4);
  emit({id:e.id,result:{turn:{id:'turn'}}});if(mode==='hang')return;
  if(mode==='malformed'){console.log('{bad');return;}if(mode==='exit'){process.exit(0);return;}
  if(mode==='native'){emit({id:987,method:'item/commandExecution/requestApproval',params:{}});return;}
  if(mode==='limit'){for(let i=0;i<20;i++)emit({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{totalTokens:i+1}}}});return;}
  emit({id:987,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call',tool:'opentake_marker',arguments:{}}});
 }
});`;
for(const mode of ['success','malformed','exit','native','hang','limit'])test('Codex protocol '+mode+' and cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-codex-')),script=join(root,'fixture.cjs');await writeFile(script,codexFixture);
 const controller=new AbortController(),result=input('chatgpt',controller.signal);let timer:ReturnType<typeof setTimeout>|undefined;
 const execute=codexExecutor(store,root,{command:()=>({executable:process.execPath,args:[script]}),version:async()=>({version:'0.144.3',verified:true}),gatewayCall:async (_host,method)=> (method==='gateway:list'?[{name:'marker',description:'Synthetic',inputSchema:{type:'object'}}]:method==='gateway:instructions'?'Synthetic guidance':{content:[{type:'text',text:'Synthetic tool result'}]}) as never,launch:((_e,args,options)=>{if(mode==='hang')timer=setTimeout(()=>controller.abort(),100);expect(JSON.stringify(args)).not.toContain(token);return spawn(process.execPath,[script,mode],options);}) as typeof spawn});
 try{if(mode==='success'){await execute(result.run);expect(result.text).toEqual(['Reply [redacted] [redacted]']);expect(result.replay).toHaveLength(3);expect(result.tools.at(-1)?.state).toBe('completed');expect(JSON.stringify(result.audit)).not.toContain(token);}
  else await expect(execute(result.run)).rejects.toThrow(mode==='hang'?'stopped':mode==='exit'?'exited':mode==='limit'?'20 model-turn limit':'unsupported chat protocol');
  expect(await readdir(join(root,'chat-temporary'))).toEqual([]);
 }finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
});
const openFixture=String.raw`
const http=require('node:http');const args=process.argv.slice(2);
if(args[0]==='import'){if(process.env.OPENTAKE_TEST_MODE==='noimport')process.exit(1);const data=require(args[1]);require('node:fs').writeFileSync('imported.json',JSON.stringify(data));console.log('Imported session: '+data.info.id);process.exit(0);}
let imported;try{imported=require(process.cwd()+'/imported.json');}catch{}
const session=imported?.info.id||'ses_fixture';let events;
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')){res.writeHead(401).end();return;}
 let raw='';for await(const c of req)raw+=c;
 if(req.url==='/global/health'){res.end(JSON.stringify({healthy:true,version:'1.14.25'}));return;}
 if(req.url==='/session'){res.end(JSON.stringify({id:session}));return;}
 if(req.url==='/event'){events=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"server.connected","properties":{}}\n\n');return;}
 if(req.method==='GET'){res.end(JSON.stringify(imported?.messages||[]));return;}
 if(process.env.OPENTAKE_TEST_MODE==='hang')return;
 if(process.env.OPENTAKE_TEST_MODE==='malformed'){events.write('data: {broken\n\n');return;}
 if(process.env.OPENTAKE_TEST_MODE==='native'){events.write('data: '+JSON.stringify({type:'message.part.updated',properties:{part:{id:'bad',sessionID:session,type:'tool',tool:'bash',callID:'bad',state:{status:'running',input:{}}}}})+'\n\n');return;}
 if(process.env.OPENTAKE_TEST_MODE==='noimport'&&!raw.includes('earlier_conversation')){res.writeHead(500).end();return;}
 const part={id:'part',sessionID:session,type:'text',text:'Reply '+process.env.OPENTAKE_ZEN_KEY,time:{start:1,end:2}};
 events?.write('data: '+JSON.stringify({type:'message.part.updated',properties:{part}})+'\n\n');
 const usage={id:'usage-step',sessionID:session,type:'step-finish',tokens:{input:10,output:2,cache:{read:0,write:0}},cost:0.01,reason:'stop'};
 events?.write('data: '+JSON.stringify({type:'message.part.updated',properties:{part:usage}})+'\n\n');
 res.end(JSON.stringify({info:{role:'assistant',finish:'stop'},parts:[part,usage]}));
});server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));`;
for(const mode of ['success','noimport','hang','malformed','native'])test('OpenCode '+mode+' uses authenticated loopback and cleans up',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-open-')),script=join(root,'fixture.cjs');await writeFile(script,openFixture);
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const result=input('opencode',controller.signal);result.run.messages=[message('user','Earlier question'),message('assistant','Earlier answer'),...result.run.messages];
 const execute=opencodeExecutor(async()=>token,root,'/synthetic/bridge',{command:()=>({executable:process.execPath,args:[script]}),version:async()=>({version:'1.14.25',verified:true}),request:async (url,init)=>{if(mode==='hang'&&init?.method==='POST'&&String(url).endsWith('/message'))timer=setTimeout(()=>controller.abort(),100);return fetch(url,init);},launch:((_e,args,options)=>{
  const config=JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);expect(config.permission).toEqual({'*':'deny','opentake_*':'allow'});expect(config.mcp.opentake.timeout).toBe(210000);expect(config.mcp.opentake.environment.OPENTAKE_ZEN_KEY).toBe('');expect(JSON.stringify(args)).not.toContain(token);return spawn(process.execPath,args,{...options,env:{...options.env,OPENTAKE_TEST_MODE:mode}});
 }) as typeof spawn});
 try{if(mode==='noimport'){await execute(result.run);expect(result.text.join('')).toEqual('Reply [redacted]');expect(result.tools[0]).toMatchObject({name:'Earlier messages sent as context'});}
 else if(mode==='success'){await execute(result.run);expect(result.text.join('')).toEqual('Reply [redacted]');expect(result.replay).toHaveLength(1);expect(JSON.stringify(result.audit)).not.toContain(token);expect(result.audit.filter((e:any)=>e.kind==='usage.recorded')).toEqual([expect.objectContaining({payload:expect.objectContaining({stepId:'usage-step',cost:0.01})})]);}
 else await expect(execute(result.run)).rejects.toThrow(mode==='hang'?'stopped':'unsupported chat protocol');
 expect(await readdir(join(root,'chat-temporary'))).toEqual([]);}
 finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
});

test('streaming redacts secrets split across deltas and keeps safe partial output',()=>{
 const result=input('chatgpt');const capture=nativeCapture(result.run,secretCleaner(['private-token']));
 capture.stream('one','Public text. private-');capture.stream('one','token done.');capture.completeText('one','Public text. private-token done.');
 expect(result.text.join('')).toBe('Public text. [redacted] done.');expect(result.text.join('')).not.toContain('private-token');
 expect(nativeFailure('Codex',{codexErrorInfo:'usageLimitExceeded'}).message).toContain('usage or billing');
 expect(nativeFailure('OpenCode',{name:'ProviderAuthError'}).message).toContain('Reconnect');
});
test('Codex refreshed tokens persist atomically without undoing disconnect or reconnect',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-refresh-'));const original=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-old',refresh_token:'synthetic-refresh',account_id:'synthetic-account'}});
 const updated=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-new',refresh_token:'synthetic-rotated',account_id:'synthetic-account'}});
 const store=createSecretStore(join(root,'synthetic-secrets'),{available:()=>true,encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()});const ref='ai:subscription:v1:chatgpt',path=join(root,'synthetic-auth.json');
 try{await store.set(ref,original);await writeFile(path,updated);await persistCodexRefresh(store,path,original);expect(await store.get(ref)).toBe(updated);
  await store.delete(ref);await persistCodexRefresh(store,path,original);expect(await store.get(ref)).toBeNull();
  await store.set(ref,'synthetic replacement connection');await persistCodexRefresh(store,path,original);expect(await store.get(ref)).toBe('synthetic replacement connection');
  await writeFile(path,updated.replace('synthetic-account','other-account'));await expect(persistCodexRefresh(store,path,original)).rejects.toThrow('Reconnect');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Codex without native history injection answers a follow-up with quoted context, and remembers the version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-codex-noinject-')),script=join(root,'fixture.cjs');await writeFile(script,codexFixture);
 const result=input('chatgpt');
 const prior=message('assistant','Earlier answer');prior.replay=[{role:'assistant',content:[{type:'text',text:'Earlier answer'}]}];
 result.run.messages=[message('user','Earlier question'),prior,message('user','Follow-up')];
 const gatewayCall=async(_host:unknown,method:string)=>(method==='gateway:list'?[{name:'marker',description:'Synthetic',inputSchema:{type:'object'}}]:method==='gateway:instructions'?'Synthetic guidance':{content:[{type:'text',text:'Marker'}]});
 const execute=codexExecutor(store,root,{command:()=>({executable:process.execPath,args:[script,'noinject']}),version:async()=>({version:'0.200.0',verified:false}),gatewayCall:gatewayCall as never});
 try{
  await execute(result.run);
  expect(result.text).toEqual(['Reply [redacted] [redacted]']);
  expect(result.tools[0]).toMatchObject({name:'Earlier messages sent as context'});
  const {historyModes}=await import('../../../src/main/native-chat-process');
  expect(await historyModes(root).native('chatgpt',{version:'0.200.0',verified:false})).toBe(false);
  expect(await historyModes(root).native('chatgpt',{version:'0.144.3',verified:true})).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});


for (const provider of ['chatgpt', 'opencode'] as const) test.each([undefined, 'high'] as const)(provider+' effort %s reaches the native request', async effort => {
 const root=await mkdtemp(join(tmpdir(),'native-effort-')),script=join(root,'fixture.cjs');
 const fixture=provider==='chatgpt'?codexFixture.replace("if(e.method==='turn/start'){", `if(e.method==='turn/start'){if(e.params.effort!==${JSON.stringify(effort)??'undefined'})process.exit(5);`):openFixture;
 await writeFile(script,fixture);const result=input(provider);result.run.selection.effort=effort;
 const command=()=>({executable:process.execPath,args:[script]});
 let checked=false;
 const execute=provider==='chatgpt'?codexExecutor(store,root,{command,version:async()=>({version:'0.144.3',verified:true}),gatewayCall:async(_host,method)=>(method==='gateway:list'?[{name:'marker',inputSchema:{type:'object'}}]:method==='gateway:instructions'?'Synthetic guidance':{content:[]}) as never}):opencodeExecutor(async()=>token,root,'/synthetic/bridge',{command,version:async()=>({version:'1.14.25',verified:true}),request:async(url,init)=>{
  if(String(url).endsWith('/message')&&init?.method==='POST'){const body=JSON.parse(String(init.body));expect(body.variant).toBe(effort);if(!effort)expect(body).not.toHaveProperty('variant');checked=true;}
  return fetch(url,init);
 }});
 try {await execute(result.run);expect(result.text.length).toBeGreaterThan(0);if(provider==='opencode')expect(checked).toBe(true);}
 finally {await rm(root,{recursive:true,force:true});}
});
