import type { ChatUsage } from '../shared/chat-usage';
import type { ModelProvider } from '../shared/ai-models';
import type { AuditCapture } from './ai-audit';
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:undefined;
const money=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
const keys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','costUsd'] as const;
export function createUsageCollector(provider:ModelProvider) {
 const records=new Map<string,Partial<ChatUsage>>();let final:Partial<ChatUsage>|undefined;let complete=false;let reportedIncomplete=false;
 const source=provider==='grok'?'Grok ACP':provider==='claude'?'Claude CLI':provider==='chatgpt'?'Codex app-server':provider==='local'?'OpenCode (local model)':provider==='openrouter'?'OpenCode (OpenRouter)':'OpenCode';
 function snapshot():ChatUsage {
  const values:Partial<ChatUsage>={};
  for(const key of keys){const entries=[...records.values()].map(r=>r[key]);if(entries.length&&entries.every(v=>v!==undefined)){const total=entries.reduce((n,v)=>n+v!,0);if(Number.isFinite(total)&&total<=Number.MAX_SAFE_INTEGER)values[key]=total;}}
  return {...(final??values),source,costKind:provider==='opencode'||provider==='openrouter'?'provider-reported':'api-equivalent',partial:!complete||reportedIncomplete,...(reportedIncomplete?{incomplete:true as const}:{})};
 }
 return { snapshot, finish(success:boolean){complete=success;return snapshot();}, observe(event:AuditCapture):ChatUsage|undefined {
  const p=object(event.payload);
  if(provider==='claude'){
   if(event.kind!=='usage.recorded'&&event.kind!=='model.output')return;
   const u=object(p.usage);const normalized:Partial<ChatUsage>={};
   for(const [key,raw] of Object.entries({inputTokens:u.input_tokens,outputTokens:u.output_tokens,cacheReadTokens:u.cache_read_input_tokens,cacheWriteTokens:u.cache_creation_input_tokens})) {const n=count(raw);if(n!==undefined)normalized[key as typeof keys[number]]=n;}
   if(event.kind==='usage.recorded'){const cost=money(p.costUsd);if(cost!==undefined)normalized.costUsd=cost;final=normalized;}
   else if(typeof p.messageId==='string'&&Object.keys(normalized).length)records.set(p.messageId,normalized);else return;
  }else if(provider==='grok'){
   if(event.kind!=='usage.recorded')return;
   const u=object(p.usage);reportedIncomplete=u.usageIsIncomplete===true;final={inputTokens:count(u.inputTokens),outputTokens:count(u.outputTokens),cacheReadTokens:count(u.cachedReadTokens),cacheWriteTokens:count(u.cacheCreationTokens),reasoningTokens:count(u.reasoningTokens)};
  }else if(provider==='chatgpt'){
   if(event.kind!=='usage.recorded')return;
   const total=object(object(p.tokenUsage).total);final={inputTokens:count(total.inputTokens),outputTokens:count(total.outputTokens),cacheReadTokens:count(total.cachedInputTokens),reasoningTokens:count(total.reasoningOutputTokens)};
  }else{
   if(event.kind!=='usage.recorded'||typeof p.stepId!=='string')return;
   const t=object(p.tokens),cache=object(t.cache);
   records.set(p.stepId,{inputTokens:count(t.input),outputTokens:count(t.output),cacheReadTokens:count(cache.read),cacheWriteTokens:count(cache.write),reasoningTokens:count(t.reasoning),costUsd:provider==='local'?undefined:money(p.cost)});
  }
  return snapshot();
 }};
}
