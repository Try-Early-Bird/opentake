import type { ChatUsage, ChatBudgets } from '../shared/chat-usage';
import { chatLimits } from '../shared/chat-limits';
import { claudeHistory, flattenedHistory, userContent, replayEvent } from './claude-history';
import { createClaudeHistoryGate, type ClaudeHistoryMode } from './claude-history-gate';
import { atomicPrivateWrite } from './private-files';
import { createRunBudget, runLimits, RunLimitError } from './run-budget';
import { BudgetLimitError } from './usage-budget';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { resolveAiCli } from './ai-runtime';
import { validateAiCredential } from './ai-connections';
import type { SecretStore } from './secret-store';
import type { TakeMessage, ToolActivity, ReplayMessage } from '../shared/takes';
import type { ChatSelection } from '../shared/chat';
import type { AuditSink } from './ai-audit';
export interface RunInput {
 id: string; takeId?: string; gateway?: { port: number; token: string }; selection: ChatSelection; messages: TakeMessage[]; instructions: string; signal: AbortSignal; managedBudget?: boolean;
 /** Model-turn limit for this run (rule runs); chat uses `chatLimits.modelTurns`. */
 maxTurns?: number;
 image(id: string): Promise<string>; text(value: string, replace?: boolean): void; tool(value: ToolActivity): void; replay?(value:ReplayMessage):void;
 audit?: AuditSink; usage?(value:ChatUsage):void; budgets?:ChatBudgets;
}
export type AgentExecutor = (input: RunInput) => Promise<void>;
export type TakeExecutor = (input: RunInput & { takeId: string }) => Promise<void>;
export function claudeExecutor(store: SecretStore, profile: string, bridge: string, launch = spawn, commandFor = resolveAiCli,
 historyMode: (command: ReturnType<typeof resolveAiCli>, home: string) => Promise<ClaudeHistoryMode> = createClaudeHistoryGate(profile).mode): AgentExecutor {
 return async input => {
  if (!input.gateway) throw new Error('Chat gateway unavailable.');
  const credential = await store.get('ai:subscription:v1:claude');
  if (!credential) throw new Error('Connect Claude in Settings.');
  validateAiCredential('claude', credential); const token = JSON.parse(credential).token as string;
  const clean = (value: string) => value.split(token).join('[redacted]').split(input.gateway!.token).join('[redacted]').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
  const capture:AuditSink = async event => {
   if(!input.audit)return;
   const original=JSON.stringify(event.payload),safe=clean(original);
   await input.audit({...event,payload:JSON.parse(safe),...(safe!==original?{status:'redacted' as const,note:'Bound provider/gateway credentials removed.'}:{})});
  };
  const root = join(profile, 'chat-temporary'); await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, 'turn-'));
  try {
   const current=input.messages.at(-1);
   if(current&&current.role!=='user')throw new Error('A response must start from a user message.');
   const content=current?await userContent(current,input.image):[{type:'text',text:'Continue.'}];
   input.signal.throwIfAborted();
   const command = commandFor('claude'); const env: NodeJS.ProcessEnv = {};
   for (const name of ['PATH','SystemRoot','WINDIR','TMPDIR','TEMP','TMP','LANG']) if (process.env[name]) env[name] = process.env[name];
   Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home,'.claude'), XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    MCP_TOOL_TIMEOUT:String(runLimits.gatewayMs), CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT:String(runLimits.gatewayMs), OPENTAKE_GATEWAY_TOKEN:input.gateway.token, PATH: dirname(command.executable) + delimiter + (env.PATH ?? ''), CLAUDE_CODE_OAUTH_TOKEN: token, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', ELECTRON_RUN_AS_NODE: '1' });
   let transcript:string|undefined;let history:unknown[]=[];
   if(input.messages.length>1){
    const mode=await historyMode(command,home);
    if(mode.mode==='transcript'){
     transcript=join(home,'history.jsonl');
     const encoded=await claudeHistory(input.messages.slice(0,-1),input.image,home,mode.version);
     history=encoded.split('\n').filter(Boolean).map(line=>JSON.parse(line).message);
     await atomicPrivateWrite(transcript,Buffer.from(encoded));
    }else{
     // Never block a take on a CLI update: earlier turns go in as quoted context instead.
     content.unshift({type:'text',text:flattenedHistory(input.messages.slice(0,-1))});
     const at=new Date().toISOString();
     input.tool({id:'history-context',name:'Earlier messages sent as context',state:'completed',startedAt:at,finishedAt:at,
      detail:`Claude CLI ${mode.version??'(unknown version)'} is not verified for conversation replay, so earlier messages were included as quoted context.`});
     await capture({kind:'capture.gap',status:'unavailable',note:'Earlier turns were sent as quoted context, not a resumed transcript.',payload:{scope:'history',reason:mode.reason,version:mode.version}});
    }
   }
   const args = [...command.args, '-p', '--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--max-turns',String(input.maxTurns??chatLimits.modelTurns),'--no-session-persistence',
    '--tools','','--allowedTools','mcp__opentake__*','--permission-mode','dontAsk','--strict-mcp-config','--setting-sources','',
    '--mcp-config', JSON.stringify({ mcpServers: { opentake: { type:'stdio', command: process.execPath, args:[bridge,'--run',input.id],env:{ELECTRON_RUN_AS_NODE:'1',CLAUDE_CODE_OAUTH_TOKEN:'',OPENTAKE_GATEWAY_PORT:String(input.gateway.port)} } } }), '--system-prompt', input.instructions];
   if(input.budgets?.claudeCostUsd!=null)args.push('--max-budget-usd',String(input.budgets.claudeCostUsd));
   if(transcript)args.push('--resume',transcript,'--fork-session');
   if (input.selection.model !== 'default') args.push('--model', input.selection.model);
   if (input.selection.effort) args.push('--effort', input.selection.effort);
   await capture({kind:'model.request',payload:{boundary:'cli_input',selection:input.selection,instructions:input.instructions,history,current:{role:'user',content},settings:{tools:[],allowedTools:['mcp__opentake__*'],permissionMode:'dontAsk'}}});
   await capture({kind:'capture.gap',status:'unavailable',note:'The CLI owns wire requests, internal context transformations and hidden reasoning. Raw stderr is deliberately excluded.',payload:{scope:'provider_internals'}});
   input.signal.throwIfAborted();
   await new Promise<void>((resolve,reject) => {
    let turnLimitReached=false;let costLimitReached=false;
    const child = launch(command.executable,args,{cwd:home,env,detached:process.platform !== 'win32',stdio:['pipe','pipe','pipe']});
    let buffer=''; let bytes=0; let complete=false; let streamed=false; let stopped=false; let childClosed=false; let forced: ReturnType<typeof setTimeout> | undefined;
    const calls=new Map<string,ToolActivity>();
    const kill=(signal:NodeJS.Signals)=>{ try { if(process.platform!=='win32'&&child.pid) process.kill(-child.pid,signal); else child.kill(signal); } catch {} };
    const stop=()=>{ if(stopped||childClosed)return; stopped=true; kill('SIGTERM'); forced=setTimeout(()=>kill('SIGKILL'),1500); };
    let auditQueue=Promise.resolve();let auditFailed=false;
    const record=(event:Parameters<AuditSink>[0])=>{const observed={...event,occurredAt:new Date().toISOString()};auditQueue=auditQueue.then(()=>capture(observed)).catch(()=>{auditFailed=true;stop();});};
    const budget=input.managedBudget?undefined:createRunBudget(input.signal);const signal=budget?.signal??input.signal; signal.addEventListener('abort',stop,{once:true});
    let replayBytes=0;let replayFailed=false;let launchFailed=false;
    const consume=(line:string)=>{
     let e; try{e=JSON.parse(line);}catch{record({kind:'capture.gap',status:'omitted',note:'Malformed CLI output was not retained.',payload:{scope:'provider_event'}});return;}
     if(e.type==='assistant'||e.type==='user') {
      const content=(e.message?.content??[]).flatMap((part:Record<string,unknown>):unknown[]=>{
       if(part.type==='text')return [{type:'text',text:part.text}];
       if(part.type==='tool_use')return [{type:'tool_use',id:part.id,name:part.name,input:part.input}];
       if(part.type==='tool_result')return [{type:'tool_result',tool_use_id:part.tool_use_id,content:part.content,is_error:part.is_error}];
       if(part.type==='thinking')return [{type:'thinking',thinking:part.thinking}];
       record({kind:'capture.gap',status:'omitted',note:'Unsupported provider content block.',payload:{type:part.type}});return [];
      });
      record({kind:'model.output',payload:{role:e.type,content,messageId:e.message?.id,model:e.message?.model,parentToolUseId:e.parent_tool_use_id,usage:e.message?.usage}});
     } else if(e.type==='stream_event') {
      const delta=e.event?.delta;
      if(delta?.type==='text_delta'||delta?.type==='thinking_delta'||delta?.type==='input_json_delta')record({kind:'model.delta',payload:{index:e.event.index,messageId:e.event.message?.id,parentToolUseId:e.parent_tool_use_id,delta}});
     } else if(e.type==='system') {
      record({kind:'provider.lifecycle',payload:{subtype:e.subtype,model:e.model,cliVersion:e.claude_code_version,sessionId:e.session_id,compactMetadata:e.compact_metadata}});
     } else if(e.type==='result') {
      record({kind:'model.result',payload:{subtype:e.subtype,isError:e.is_error,result:e.result,stopReason:e.stop_reason,durationMs:e.duration_ms,turns:e.num_turns,sessionId:e.session_id}});
      if(e.usage||e.modelUsage||e.total_cost_usd!==undefined)record({kind:'usage.recorded',payload:{usage:e.usage,modelUsage:e.modelUsage,costUsd:e.total_cost_usd,source:'claude-cli-result'}});
      else record({kind:'capture.gap',status:'unavailable',note:'Provider result did not include usage.',payload:{scope:'usage'}});
     } else record({kind:'capture.gap',status:'omitted',note:'Unsupported provider event.',payload:{type:e.type}});
     const replay=replayEvent(e,clean);if(replay){replayBytes+=Buffer.byteLength(JSON.stringify(replay));if(replayBytes>512000){replayFailed=true;record({kind:'capture.gap',status:'omitted',note:'Response stopped at transcript size limit.',payload:{scope:'remaining_output'}});stop();return;}input.replay?.(replay);}
     if(e.type==='stream_event' && e.event?.delta?.type==='text_delta'){ streamed=true; input.text(clean(String(e.event.delta.text))); }
     if(e.type==='assistant') for(const part of e.message?.content??[]) {
      if(part.type==='text'&&!streamed) input.text(clean(part.text));
      if(part.type==='tool_use') { const tool:ToolActivity={id:part.id,name:String(part.name).replace(/^mcp__opentake__/,''),state:'running',startedAt:new Date().toISOString()};calls.set(tool.id,tool);input.tool(tool); }
     }
     if(e.type==='user') for(const part of e.message?.content??[]) if(part.type==='tool_result') {
      const call=calls.get(part.tool_use_id); if(call) input.tool({...call,state:part.is_error?'failed':'completed',finishedAt:new Date().toISOString()});
     }
     if(e.type==='result'&&e.subtype==='error_max_budget_usd')costLimitReached=true;
     if(e.type==='result'&&e.subtype==='error_max_turns')turnLimitReached=true;
     if(e.type==='result'){ complete=e.subtype==='success'&&!e.is_error; if(complete&&typeof e.result==='string')input.text(clean(e.result),true); }
    };
    const cleanup=()=>{budget?.finish();clearTimeout(forced);signal.removeEventListener('abort',stop);};
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024){record({kind:'capture.gap',status:'omitted',note:'Response stopped at output size limit.',payload:{scope:'remaining_output'}});stop();return;}buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,i));buffer=buffer.slice(i+1);} });
    child.stderr!.on('data',()=>{});child.stdin!.on('error',()=>{});
    child.on('error',()=>{launchFailed=true;});
    child.on('close',(code,signalName)=>{childClosed=true;cleanup();if(buffer.trim())consume(buffer);record({kind:'provider.exited',payload:{exitCode:code,signal:signalName,launchFailed,complete,cancelled:signal.aborted,auditFailed}});void auditQueue.then(()=>{if(auditFailed)reject(new Error('AI audit capture failed. Response stopped.'));else if(launchFailed)reject(new Error('Could not start Claude. Check the installed CLI and connection.'));else if(signal.aborted)reject(signal.reason instanceof Error&&signal.reason.name!=='AbortError'?signal.reason:new Error('Response stopped.'));else if(replayFailed)reject(new Error('Tool history exceeded this response’s size limit. Start a new take.'));else if(costLimitReached)reject(new BudgetLimitError('Response reached its Claude cost budget. Partial output is retained. Change the budget in Settings → AI before retrying.'));else if(turnLimitReached)reject(new RunLimitError('Response reached its 20 model-turn limit. Continue in a new response.'));else if(!complete)reject(new Error('Claude stopped before completing. Check connection and usage limits, then retry.'));else resolve();});});
    child.stdin!.end(JSON.stringify({type:'user',message:{role:'user',content},parent_tool_use_id:null,session_id:''})+'\n');
    if(signal.aborted)stop();
   });
  } finally { await rm(home,{recursive:true,force:true}); }
 };
}
