import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { resolveOpenCode } from './opencode-runtime';
import { atomicPrivateWrite } from './private-files';
import { runLimits } from './run-budget';
import { chatLimits } from '../shared/chat-limits';
import type { AgentExecutor as TakeExecutor, RunInput } from './take-runtime';
import type { AiModel, ReasoningEffort } from '../shared/ai-models';
import { AdapterError, manageChild, nativeCapture, nativeFailure, protocolError, secretCleaner, withNativeChat, type NativeDependencies, historyModes } from './native-chat-process';
import { nativeHistory, opencodeHistory, quotedHistory } from './native-chat-history';

// Zen uses OpenCode's built-in provider. OpenRouter and local servers (Ollama,
// LM Studio, vLLM) use its bundled OpenAI-compatible provider.
export type CompatibleTarget = {kind:'compatible';providerID:'local'|'openrouter';name:string;baseUrl:()=>Promise<string>;
  apiKey?:()=>Promise<string>;model?:(id:string)=>Promise<AiModel|undefined>;missing:string};
export type OpenCodeTarget = {kind:'zen'} | CompatibleTarget;
type CompatibleModel = {providerID:string;name:string;baseUrl:string;model:string;keyed:boolean;pricing?:AiModel['pricing'];efforts?:ReasoningEffort[]};
export function opencodeChatConfig(instructions:string,bridge:string,runId:string,port:number,compatible?:CompatibleModel,turns:number=chatLimits.modelTurns) {
  // OpenCode prices a custom model only from configured cost (USD per million tokens).
  const provider=compatible
    ?{[compatible.providerID]:{npm:'@ai-sdk/openai-compatible',name:compatible.name,options:{baseURL:compatible.baseUrl,apiKey:compatible.keyed?'{env:OPENTAKE_PROVIDER_KEY}':'opentake-local'},
      // A custom model has only the variants configured here; OpenCode drops any other variant unsent.
      models:{[compatible.model]:{name:compatible.model,tool_call:true,...(compatible.pricing?{cost:{input:compatible.pricing.input,output:compatible.pricing.output}}:{}),
        ...(compatible.efforts?.length?{variants:Object.fromEntries(compatible.efforts.map(effort=>[effort,{reasoningEffort:effort}]))}:{})}}}}
    :{opencode:{options:{apiKey:'{env:OPENTAKE_ZEN_KEY}'}}};
  return {autoupdate:false,share:'disabled',snapshot:false,plugin:[],enabled_providers:[compatible?compatible.providerID:'opencode'],
    provider,
    permission:{'*':'deny','opentake_*':'allow'},default_agent:'opentake',
    agent:{opentake:{mode:'primary',prompt:instructions,steps:turns,permission:{'*':'deny','opentake_*':'allow'}},title:{disable:true}},
    compaction:{auto:false,prune:false},
    mcp:{opentake:{type:'local',enabled:true,command:[process.execPath,bridge,'--run',runId],timeout:runLimits.gatewayMs,
      environment:{ELECTRON_RUN_AS_NODE:'1',OPENTAKE_GATEWAY_PORT:String(port),OPENTAKE_ZEN_KEY:'',OPENTAKE_PROVIDER_KEY:'',OPENCODE_SERVER_PASSWORD:''}}}};
}
const record=z.record(z.string(),z.unknown());
// OpenCode downloads ripgrep from GitHub when none is on PATH. Runs deny its file
// tools, so only the binary's presence matters; a shim avoids the download.
async function ripgrepShim(home:string,env:NodeJS.ProcessEnv) {
  const bin=join(home,'bin');await mkdir(bin,{recursive:true,mode:0o700});
  if(process.platform==='win32')await writeFile(join(bin,'rg.cmd'),'@echo ripgrep 15.1.0\r\n',{mode:0o700});
  else await writeFile(join(bin,'rg'),'#!/bin/sh\necho "ripgrep 15.1.0"\n',{mode:0o700});
  env.PATH=bin+delimiter+(env.PATH??'');
}
export function opencodeExecutor(keyFor:()=>Promise<string>,profile:string,bridge:string,deps:NativeDependencies & {request?:typeof fetch}={},target:OpenCodeTarget={kind:'zen'}):TakeExecutor {
  return async original=>{
    const command=(deps.command??resolveOpenCode)();
    await withNativeChat('opencode',profile,original,command,async(home,env,input,cli)=>{
      const providerID=target.kind==='compatible'?target.providerID:'opencode';
      let key='',compatible:CompatibleModel|undefined;
      if(target.kind==='zen'){key=await keyFor();if(!key)throw new AdapterError('Connect OpenCode in Settings.');}
      else {
        try{key=await target.apiKey?.()??'';const model=await target.model?.(input.selection.model);
          compatible={providerID,name:target.name,baseUrl:await target.baseUrl(),model:input.selection.model,keyed:!!target.apiKey,pricing:model?.pricing,efforts:model?.effortLevels};}catch{throw new AdapterError(target.missing);}
        if(input.selection.effort&&!compatible.efforts?.includes(input.selection.effort))throw new AdapterError('This thinking effort is unavailable. Choose Default or refresh models.');
        if(target.apiKey&&!key)throw new AdapterError(target.missing);
        await ripgrepShim(home,env);
      }
      const password=randomBytes(32).toString('hex');
      const clean=secretCleaner([key,password,input.gateway!.token]);const capture=nativeCapture(input,clean);
      const turns=await nativeHistory(input.messages,input.image),current=turns.pop();
      if(!current||current.role!=='user'||current.parts.some(p=>p.type==='call'))throw new AdapterError('A response must start from a user message.');
      const history=opencodeHistory(turns,home,input.selection.model,cli.version??'0.0.0',providerID);
      // Native history (an internal session import) is tried first; a CLI version that rejects it
      // gets earlier turns as quoted context in a fresh session instead, and is remembered.
      const modes=historyModes(profile);
      let imported=false;
      if(key)env[target.kind==='zen'?'OPENTAKE_ZEN_KEY':'OPENTAKE_PROVIDER_KEY']=key;env.OPENTAKE_GATEWAY_TOKEN=input.gateway!.token;
      env.OPENCODE_SERVER_PASSWORD=password;
      env.OPENCODE_CONFIG_CONTENT=JSON.stringify(opencodeChatConfig(input.instructions,bridge,input.id,input.gateway!.port,compatible,input.maxTurns??chatLimits.modelTurns));
      const launch=deps.launch??spawn;
      if(turns.length&&await modes.native('opencode',cli)) try {
        const path=join(home,'history.json');await atomicPrivateWrite(path,Buffer.from(JSON.stringify(history)));
        const importer=launch(command.executable,[...command.args,'import',path],{cwd:home,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
        const state=manageChild(importer,input.signal);let output='';let exitCode:number|null=null;let error=false;
        const timer=setTimeout(()=>{error=true;state.stop();},15000);
        importer.stdout!.on('data',chunk=>{output+=String(chunk);if(Buffer.byteLength(output)>16384){error=true;state.stop();}});
        importer.once('error',()=>{error=true;});importer.once('exit',code=>{exitCode=code;});importer.stdin!.end();
        try {await state.done;input.signal.throwIfAborted();if(error||exitCode!==0||!output.includes(`Imported session: ${history.info.id}`))throw protocolError('OpenCode');}
        finally {clearTimeout(timer);await state.close();}
        imported=true;
      } catch(failure) { if(input.signal.aborted)throw failure; await modes.markBaseline('opencode',cli); }
      const child=launch(command.executable,[...command.args,'serve','--hostname','127.0.0.1','--port','0'],{cwd:home,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      const state=manageChild(child,input.signal);child.stdin!.end();
      const controller=new AbortController();const abort=()=>controller.abort();input.signal.addEventListener('abort',abort,{once:true});
      let finished=false;let streamFailure:Error|undefined;
      void state.done.then(()=>{if(!finished){streamFailure=new AdapterError('OpenCode exited before completing the response.');controller.abort();}});
      let startupTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        const base=await new Promise<string>((resolve,reject)=>{
          let output='';startupTimer=setTimeout(()=>reject(new AdapterError('OpenCode server startup timed out.')),15000);
          child.stdout!.on('data',chunk=>{
            output+=String(chunk);if(output.length>16384){reject(protocolError('OpenCode'));return;}
            const match=/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
            if(match){clearTimeout(startupTimer);resolve(match[1]);}
          });
          child.once('error',()=>reject(new AdapterError('Could not start OpenCode.')));
          void state.done.then(()=>reject(new AdapterError('OpenCode exited during startup.')));
        });
        input.signal.throwIfAborted();
        const request=deps.request??fetch;
        const headers={'Content-Type':'application/json',Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')};
        const call=async(path:string,body?:unknown,timeout=30000)=>{
          const response=await request(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)])});
          if(!response.ok)throw new AdapterError('OpenCode rejected a chat request. Check the connection, model access and CLI compatibility.');
          const text=await boundedText(response,2*1024*1024);return JSON.parse(text) as unknown;
        };
        const health=z.object({healthy:z.literal(true)}).passthrough().safeParse(await call('/global/health'));
        if(!health.success)throw protocolError('OpenCode');
        // Verify imported roles and parts via the public API before inference; a mismatch
        // drops to a fresh session with quoted context rather than ending the response.
        if(imported) {
          const loaded=z.array(z.object({info:z.object({id:z.string(),role:z.enum(['user','assistant'])}),parts:z.array(record)})).safeParse(await call('/session/'+encodeURIComponent(history.info.id)+'/message').catch(()=>null));
          if(!loaded.success||loaded.data.length!==history.messages.length||loaded.data.some((m,i)=>m.info.id!==history.messages[i].info.id||m.info.role!==history.messages[i].info.role||m.parts.length!==history.messages[i].parts.length)){
            imported=false;await modes.markBaseline('opencode',cli);
          }
        }
        const session=imported?history.info:z.object({id:z.string()}).parse(await call('/session',{title:'Opentake',permission:history.info.permission}));
        const sessionPath='/session/'+encodeURIComponent(session.id);
        // Stream only parts announced as text: reasoning parts use the same delta field.
        const textParts=new Set<string>();const seen=new Set<string>();const calls=new Map<string,{name:string;startedAt:string}>();const steps=new Set<string>();
        const partEvent=async(value:unknown)=>{
          const part=z.object({id:z.string(),sessionID:z.string(),type:z.string()}).passthrough().parse(value);
          if(part.sessionID!==session.id)return;
          if(part.type==='text') {
            textParts.add(part.id);const time=part.time as {end?:number}|undefined;
            if(!time?.end||seen.has(part.id))return;
            seen.add(part.id);const text=z.string().parse(part.text);capture.completeText(part.id,text);capture.replay({role:'assistant',content:[{type:'text',text}]});await capture.audit('model.output',{role:'assistant',text});
          } else if(part.type==='tool') {
            const tool=z.object({tool:z.string().regex(/^opentake_[A-Za-z0-9_-]+$/),callID:z.string(),state:z.object({status:z.enum(['pending','running','completed','error']),input:z.unknown(),output:z.string().optional(),error:z.string().optional()})}).parse(part);
            if(tool.state.status==='pending')return;
            if(tool.state.status==='completed'&&tool.state.output===undefined)throw protocolError('OpenCode');
            const ended=tool.state.status==='completed'||tool.state.status==='error';if(ended&&seen.has(part.id))return;
            if(!calls.has(tool.callID)){calls.set(tool.callID,{name:tool.tool.slice('opentake_'.length),startedAt:new Date().toISOString()});capture.replay({role:'assistant',content:[{type:'tool_use',id:tool.callID,name:'mcp__opentake__'+tool.tool.slice('opentake_'.length),input:tool.state.input}]});}
            const prior=calls.get(tool.callID)!;input.tool({id:tool.callID,name:prior.name,startedAt:prior.startedAt,state:ended?(tool.state.status==='error'?'failed':'completed'):'running',...(ended?{finishedAt:new Date().toISOString()}: {})});
            if(ended){seen.add(part.id);capture.replay({role:'user',content:[{type:'tool_result',tool_use_id:tool.callID,content:tool.state.output??tool.state.error??'Tool returned no result.',is_error:tool.state.status==='error'}]});await capture.audit('model.output',{tool:prior.name,state:tool.state});}
          } else if(part.type==='step-start') {
            steps.add(part.id);if(steps.size>(input.maxTurns??chatLimits.modelTurns))throw new AdapterError(`Response reached its ${input.maxTurns??chatLimits.modelTurns} model-turn limit.`);
          } else if(part.type==='step-finish') {
            if(!seen.has(part.id)){seen.add(part.id);await capture.audit('usage.recorded',{source:'opencode',stepId:part.id,tokens:part.tokens,cost:part.cost,reason:part.reason});}
          }
          // Other part types (reasoning, and kinds a newer CLI adds) carry nothing to show or record.
        };
        const events=await request(base+'/event',{headers,redirect:'error',signal:controller.signal});if(!events.ok||!events.body)throw protocolError('OpenCode');
        const eventLoop=readEvents(events,async raw=>{
          const event=z.object({type:z.string(),properties:record}).parse(raw);
          if(event.type==='message.part.updated')await partEvent(event.properties.part);
          else if(event.type==='message.part.delta'&&event.properties.sessionID===session.id&&event.properties.field==='text') {
            const delta=z.object({partID:z.string(),delta:z.string()}).parse(event.properties);if(!seen.has(delta.partID)&&textParts.has(delta.partID))capture.stream(delta.partID,delta.delta);
          }
          else if(event.type==='permission.asked'&&event.properties.sessionID===session.id)throw protocolError('OpenCode');
          else if(event.type==='session.error'&&event.properties.sessionID===session.id)throw nativeFailure('OpenCode',event.properties.error);
        },controller.signal).catch(error=>{if(!finished&&!controller.signal.aborted){streamFailure=error instanceof AdapterError?error:protocolError('OpenCode');controller.abort();}});
        const parts:unknown[]=current.parts.map(p=>p.type==='image'?{type:'file',url:p.url,mime:p.mime}:{type:'text',text:p.type==='text'?p.text:''});
        if(turns.length&&!imported){
          parts.unshift({type:'text',text:quotedHistory(turns)});
          const at=new Date().toISOString();
          input.tool({id:'history-context',name:'Earlier messages sent as context',state:'completed',startedAt:at,finishedAt:at,
            detail:`OpenCode CLI ${cli.version??'(unknown version)'} did not accept the conversation history, so earlier messages were included as quoted context.`});
        }
        await capture.audit('model.request',{boundary:'opencode-server',selection:input.selection,instructions:input.instructions,history:imported?history.messages:[],current:parts});
        try {
          const result=z.object({info:z.object({role:z.literal('assistant'),finish:z.string().optional(),error:z.unknown().optional()}),parts:z.array(record)}).parse(await call(sessionPath+'/message',{model:{providerID,modelID:input.selection.model},agent:'opentake',parts,...(input.selection.effort?{variant:input.selection.effort}:{})},runLimits.absoluteMs));
          if(result.info.error||!['stop','end_turn'].includes(result.info.finish??''))throw nativeFailure('OpenCode',result.info.error);
          for(const part of result.parts)await partEvent(part);
          if(streamFailure)throw streamFailure;
        } finally {finished=true;controller.abort();await eventLoop;}
      } catch(error) {if(streamFailure)throw streamFailure;throw error;}
      finally {clearTimeout(startupTimer);finished=true;controller.abort();input.signal.removeEventListener('abort',abort);await state.close();}
    },deps.version);
  };
}
async function boundedText(response:Response,limit:number) {
  if(!response.body)throw protocolError('OpenCode');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw new AdapterError('OpenCode response exceeded its output limit.');chunks.push(value);}}
  finally {await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}
async function readEvents(response:Response,consume:(value:unknown)=>Promise<void>,signal:AbortSignal) {
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;
  // Aborting the request alone did not always end an in-progress read of this
  // long-lived stream (a local-model run waited for the next heartbeat forever).
  const stop=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
  try {while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)throw protocolError('OpenCode');bytes+=value.length;if(bytes>2*1024*1024)throw new AdapterError('OpenCode response exceeded its output limit.');buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');let index;
    while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data)await consume(JSON.parse(data));}
  }} finally {signal.removeEventListener('abort',stop);await reader.cancel().catch(()=>{});}
}
