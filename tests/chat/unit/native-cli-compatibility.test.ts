// Opt-in checks of installed CLIs. All inference and MCP requests use synthetic
// loopback servers and disposable homes; no login or real profile is accessed.
import sharp from 'sharp';
import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexExecutor } from '../../../src/main/codex-chat';
import { opencodeExecutor } from '../../../src/main/opencode-chat';
import type { TakeMessage } from '../../../src/shared/takes';
import type { SecretStore } from '../../../src/main/secret-store';
function send(res:ServerResponse,type:string,data:object){res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);}
for(const provider of ['chatgpt','opencode'] as const)test.skipIf(!process.env[provider==='chatgpt'?'OPENTAKE_TEST_CODEX':'OPENTAKE_TEST_OPENCODE'])(`${provider} installed CLI preserves history and restricts external tools to the gateway`,async()=>{
 const executable=process.env[provider==='chatgpt'?'OPENTAKE_TEST_CODEX':'OPENTAKE_TEST_OPENCODE']!;
 const png='data:image/png;base64,'+(await sharp({create:{width:16,height:16,channels:3,background:'#00aa44'}}).png().toBuffer()).toString('base64');
 const root=await mkdtemp(join(tmpdir(),'opentake-native-compat-'));const run=randomUUID(),capability='a'.repeat(64);
 const requests:any[]=[];const dispatches:any[]=[];
 const gateway=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${capability}`){res.writeHead(403).end();return;}
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);expect(body.args[0]).toBe(run);
  if(body.method==='gateway:call')dispatches.push(body);
  const value=body.method==='gateway:instructions'?'Synthetic gateway guidance':body.method==='gateway:list'?[{name:'marker',description:'Return a synthetic marker',inputSchema:{type:'object',properties:{}}}]:{content:[{type:'text',text:'NEW-SYNTHETIC-RESULT'}]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value}));
 });
 const model=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  if(req.url?.includes('count_tokens')){res.end(JSON.stringify({input_tokens:50}));return;}
  let body:any;try{body=JSON.parse(raw);}catch{res.writeHead(400).end();return;}
  requests.push(body);const first=requests.length===1;
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  if(provider==='chatgpt') {
   const tool=(body.tools??[]).flatMap((t:any)=>t.type==='namespace'?t.tools:t).find((t:any)=>String(t.name).includes('marker'));
   const name=tool?.name??'mcp__opentake__marker';
   send(res,'response.created',{response:{id:'resp_fixture',status:'in_progress',output:[]}});
   const item=first?{id:'fc_fixture',type:'function_call',call_id:'call_fixture',name,arguments:'{}'}:{id:'msg_fixture',type:'message',role:'assistant',content:[{type:'output_text',text:'Compatibility complete.'}]};
   send(res,'response.output_item.added',{output_index:0,item});
   send(res,'response.output_item.done',{output_index:0,item});
   send(res,'response.completed',{response:{id:'resp_fixture',status:'completed',output:[item],usage:{input_tokens:50,output_tokens:5,total_tokens:55}}});
  } else {
   const name=(body.tools??[]).find((t:any)=>String(t.name).includes('marker'))?.name??'opentake_marker';
   send(res,'message_start',{message:{id:'msg_fixture',type:'message',role:'assistant',content:[],model:'claude-haiku-4-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:50,output_tokens:0}}});
   send(res,'content_block_start',{index:0,content_block:first?{type:'tool_use',id:'toolu_fixture',name,input:{}}:{type:'text',text:''}});
   send(res,'content_block_delta',{index:0,delta:first?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:'Compatibility complete.'}});
   send(res,'content_block_stop',{index:0});send(res,'message_delta',{delta:{stop_reason:first?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}});send(res,'message_stop',{});
  }
  res.end();
 });
 await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${(model.address() as any).port}`;
 const modelId=provider==='chatgpt'?'gpt-5.2':'claude-haiku-4-5';
 const base={id:randomUUID(),parentId:null,images:[],createdAt:new Date().toISOString(),selection:{provider:'claude' as const,model:'synthetic'},state:'completed' as const,tools:[]};
 const history:TakeMessage[]=[{...base,role:'user',text:'Earlier question',images:[{id:randomUUID(),name:'ref.png',mime:'image/png',width:1,height:1,bytes:68}]},{...base,id:randomUUID(),role:'assistant',text:'Earlier answer',replay:[{role:'assistant',content:[{type:'tool_use',id:'old_call',name:'mcp__opentake__marker',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'old_call',content:'OLD-SYNTHETIC-RESULT',is_error:false}]},{role:'assistant',content:[{type:'text',text:'Earlier answer'}]}]},{...base,id:randomUUID(),role:'user',text:'Check the marker again.'}];
 const output:string[]=[];const replay:any[]=[];const audit:any[]=[];
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
 const bridge=resolve('out/main/earlybird-opentake-mcp.js');
 const store:SecretStore={available:()=>true,has:async()=>true,get:async()=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-local-access',refresh_token:'synthetic-local-refresh'}}),set:async()=>{},delete:async()=>{}};
 const args=provider==='chatgpt'?['-c','model_provider="fixture"','-c',`model_providers.fixture={ name="Fixture", base_url="${endpoint}/v1", wire_api="responses", requires_openai_auth=false, request_max_retries=0, stream_max_retries=0 }`,'-c','features.remote_models=false','-c','features.enable_request_compression=false']:[];
 const launch:typeof spawn=((exe,argv,options)=>{
  if(provider==='opencode') {
   const config=JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);config.provider.opencode.options.baseURL=endpoint+'/v1';
   options={...options,env:{...options.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(config)}};
  }
  const child=spawn(exe,argv,options);
  return child;
 }) as typeof spawn;
 try {
  const execute=provider==='chatgpt'?codexExecutor(store,root,{command:()=>({executable,args}),launch}):opencodeExecutor(async()=> 'synthetic-local-key',root,bridge,{command:()=>({executable,args}),launch});
  await execute({id:run,takeId:randomUUID(),gateway:{port:(gateway.address() as any).port,token:capability},selection:{provider,model:modelId},messages:history,instructions:'Synthetic instructions. Only use the marker tool.',signal:controller.signal,image:async()=>png,text:v=>output.push(v),tool:()=>{},replay:v=>replay.push(v),audit:async v=>{audit.push(v);}});
  expect(audit.filter(e=>e.kind==='usage.recorded')).toHaveLength(2);
  expect(output.join('')).toContain('Compatibility complete.');expect(dispatches).toHaveLength(1);expect(requests.length).toBeGreaterThanOrEqual(2);
  const initial=JSON.stringify(requests[0]);expect(initial).toContain('OLD-SYNTHETIC-RESULT');expect(initial).toContain('Earlier answer');expect(initial).toContain(provider==='chatgpt'?'input_image':'image');expect(initial).not.toContain('image content omitted');
  expect(JSON.stringify(replay)).toContain('NEW-SYNTHETIC-RESULT');
  const names=(requests[0].tools??[]).flatMap((t:any)=>t.type==='namespace'?t.tools.map((x:any)=>x.name):[t.name]);
  expect(names.length).toBeGreaterThan(0);expect(names.every((n:string)=>n.includes('marker')||(provider==='chatgpt'&&['update_plan','list','read'].includes(n)))).toBe(true);
  expect(initial).not.toContain('Available skills');
 }finally{clearTimeout(timer);controller.abort();model.closeAllConnections();gateway.closeAllConnections();await Promise.all([new Promise<void>(r=>model.close(()=>r())),new Promise<void>(r=>gateway.close(()=>r()))]);await rm(root,{recursive:true,force:true});}
},60000);
