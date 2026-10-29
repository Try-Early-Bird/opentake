import { useEffect,useState } from 'react';
import type { AutomaticRunLimits, ChatRunLimits } from '../../../shared/chat-usage';
export function ChatBudgets(){
 const [tokens,setTokens]=useState(''),[opencode,setOpencode]=useState('');
 const [value,setValue]=useState(''),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 useEffect(()=>{let active=true;void window.takes.budgets().then(v=>{if(active){setValue(v.claudeCostUsd==null?'':String(v.claudeCostUsd));setTokens(v.outputTokens==null?'':String(v.outputTokens));setOpencode(v.opencodeCostUsd==null?'':String(v.opencodeCostUsd));setReady(true);}}).catch(()=>{if(active)setError('Could not load budgets. Reopen this page to retry.');});return()=>{active=false;};},[]);
 return <section className="space-y-3"><h3 className="text-lg font-medium">Usage & limits</h3><p className="text-sm text-muted-foreground">Defaults apply to new responses. Responses already running keep their original budget.</p><form className="space-y-3" onSubmit={e=>{e.preventDefault();setBusy(true);setError('');setSaved('');void window.takes.saveBudgets({claudeCostUsd:value.trim()?Number(value):null,outputTokens:tokens.trim()?Number(tokens):null,opencodeCostUsd:opencode.trim()?Number(opencode):null}).then(()=>setSaved('Budget saved.')).catch(()=>setError('Could not save. Use $0.01–$100 for cost and 1–1,000,000 whole output tokens, or leave fields blank.')).finally(()=>setBusy(false));}}><label className="block text-sm">Claude API-equivalent budget per response (USD)<input className="mt-2 block w-40 rounded border border-input bg-background px-3 py-2" aria-label="Claude cost budget" type="number" min="0.01" max="100" step="0.01" placeholder="No budget" disabled={!ready||busy} value={value} onChange={e=>{setValue(e.target.value);setSaved('');}}/></label><p className="max-w-xl text-xs leading-5 text-muted-foreground">Claude stops when its reported API-equivalent cost reaches the budget. A model call can exceed the threshold before it reports usage. This is not a subscription charge or a guaranteed billing cap. Leave blank for no cost budget.</p><label className="block text-sm">Reported output-token threshold per response (all AI providers)<input className="mt-2 block w-40 rounded border border-input bg-background px-3 py-2" aria-label="Output token threshold" type="number" min="1" max="1000000" step="1" placeholder="No threshold" disabled={!ready||busy} value={tokens} onChange={e=>{setTokens(e.target.value);setSaved('');}}/></label><label className="block text-sm">OpenCode reported-cost threshold per response (USD), for OpenCode Zen and OpenRouter<input className="mt-2 block w-40 rounded border border-input bg-background px-3 py-2" aria-label="OpenCode cost threshold" type="number" min="0.01" max="100" step="0.01" placeholder="No threshold" disabled={!ready||busy} value={opencode} onChange={e=>{setOpencode(e.target.value);setSaved('');}}/></label><p className="max-w-xl text-xs leading-5 text-muted-foreground">These thresholds stop further work when the provider reports usage. A model call can exceed them before reporting. Output tokens follow each provider’s definition; they are not a total-context limit. Limits cannot be enforced when usage is not reported. Leave blank to disable.</p><button disabled={!ready||busy} className="rounded bg-muted px-3 py-2 text-sm">{busy?'Saving…':'Save budget'}</button>{saved&&<p role="status" className="text-sm">{saved}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</form><p className="text-xs text-muted-foreground">ChatGPT cost budgets are unavailable because cost information is not reported. These settings are not guaranteed billing caps. Reported usage is available on each response and under Tools & history → Usage.</p><ChatRunLimitsForm/><AutomaticRunLimitsForm/></section>;
}
/** Limits for each chat response the member asks for. */
function ChatRunLimitsForm(){
 const [values,setValues]=useState<Record<'minutes'|'toolCalls'|'modelTurns',string>>({minutes:'',toolCalls:'',modelTurns:''}),[subagents,setSubagents]=useState(true);
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const show=(v:ChatRunLimits)=>{setValues({minutes:String(v.durationMs/60000),toolCalls:String(v.toolCalls),modelTurns:String(v.modelTurns)});setSubagents(v.subagents);};
 useEffect(()=>{let active=true;void window.takes.chatRunLimits().then(v=>{if(active){show(v);setReady(true);}}).catch(()=>{if(active)setError('Could not load chat limits. Reopen this page to retry.');});return()=>{active=false;};},[]);
 const field=(key:keyof typeof values,label:string,attrs:{min:number;max:number;step:number})=><label key={key} className="block text-sm">{label}<input className="mt-2 block w-40 rounded border border-input bg-background px-3 py-2" aria-label={`Chat ${label.toLowerCase()}`} type="number" min={attrs.min} max={attrs.max} step={attrs.step} required disabled={!ready||busy} value={values[key]} onChange={e=>{setValues(old=>({...old,[key]:e.target.value}));setSaved('');}}/></label>;
 return <form className="space-y-3 border-t border-border pt-4" onSubmit={e=>{e.preventDefault();setBusy(true);setError('');setSaved('');
  void window.takes.saveChatRunLimits({durationMs:Math.round(Number(values.minutes)*60000),toolCalls:Number(values.toolCalls),modelTurns:Number(values.modelTurns),subagents})
   .then(v=>{show(v);setSaved('Chat limits saved.');}).catch(()=>setError('Could not save. Use 1–60 whole minutes, 1–500 tool calls and 1–200 turns.')).finally(()=>setBusy(false));}}>
  <h4 className="text-sm font-medium">Chat responses</h4>
  <p className="max-w-xl text-xs leading-5 text-muted-foreground">Each response you ask for, including the research it delegates. Failed attempts count. Time spent waiting for your approval counts toward run time.</p>
  {field('minutes','Run time (minutes)',{min:1,max:60,step:1})}
  {field('toolCalls','Tool calls',{min:1,max:500,step:1})}
  {field('modelTurns','Model turns',{min:1,max:200,step:1})}
  <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={subagents} disabled={!ready||busy} onChange={e=>{setSubagents(e.target.checked);setSaved('');}}/><span>Let the AI delegate research to subagents<span className="block text-xs leading-5 text-muted-foreground">Researchers that use the same read-only tools and cannot propose changes or trade. Their work counts toward these limits. Also applies to automatic runs. Available with Claude, Grok, OpenCode Zen and OpenRouter.</span></span></label>
  <button disabled={!ready||busy} className="rounded bg-muted px-3 py-2 text-sm">{busy?'Saving…':'Save chat limits'}</button>
  {saved&&<p role="status" className="text-sm">{saved}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </form>;
}
/** Limits for automatic runs started by agent rules. Each is the default
 *  when a rule sets none and the most a rule may set. */
function AutomaticRunLimitsForm(){
 const [values,setValues]=useState<Record<'minutes'|'toolCalls'|'modelTurns'|'costUsd'|'outputTokens',string>>({minutes:'',toolCalls:'',modelTurns:'',costUsd:'',outputTokens:''});
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const show=(v:AutomaticRunLimits)=>setValues({minutes:String(v.durationMs/60000),toolCalls:String(v.toolCalls),modelTurns:String(v.modelTurns),costUsd:String(v.costUsd),outputTokens:String(v.outputTokens)});
 useEffect(()=>{let active=true;void window.takes.automaticLimits().then(v=>{if(active){show(v);setReady(true);}}).catch(()=>{if(active)setError('Could not load automatic run limits. Reopen this page to retry.');});return()=>{active=false;};},[]);
 const field=(key:keyof typeof values,label:string,attrs:{min:number;max:number;step:number})=><label key={key} className="block text-sm">{label}<input className="mt-2 block w-40 rounded border border-input bg-background px-3 py-2" aria-label={label} type="number" min={attrs.min} max={attrs.max} step={attrs.step} required disabled={!ready||busy} value={values[key]} onChange={e=>{setValues(old=>({...old,[key]:e.target.value}));setSaved('');}}/></label>;
 return <form className="space-y-3 border-t border-border pt-4" onSubmit={e=>{e.preventDefault();setBusy(true);setError('');setSaved('');
  void window.takes.saveAutomaticLimits({durationMs:Math.round(Number(values.minutes)*60000),toolCalls:Number(values.toolCalls),modelTurns:Number(values.modelTurns),costUsd:Number(values.costUsd),outputTokens:Number(values.outputTokens)})
   .then(v=>{show(v);setSaved('Automatic run limits saved.');}).catch(()=>setError('Could not save. Use 0.5–60 minutes in half minutes, 1–500 tool calls, 1–200 turns, $0.01–$100 and 1–10,000,000 output tokens.')).finally(()=>setBusy(false));}}>
  <h4 className="text-sm font-medium">Automatic runs</h4>
  <p className="max-w-xl text-xs leading-5 text-muted-foreground">Runs that agent rules start in the background, with no one watching. Each limit is the default when a rule sets none and the most a rule may set; a rule can only be stricter. Codex and Grok report tokens but not cost, so the output-token limit is what stops them.</p>
  {field('minutes','Run time (minutes)',{min:0.5,max:60,step:0.5})}
  {field('toolCalls','Tool calls',{min:1,max:500,step:1})}
  {field('modelTurns','Model turns',{min:1,max:200,step:1})}
  {field('costUsd','Cost (USD, reported or API-equivalent)',{min:0.01,max:100,step:0.01})}
  {field('outputTokens','Output tokens',{min:1,max:10000000,step:1})}
  <button disabled={!ready||busy} className="rounded bg-muted px-3 py-2 text-sm">{busy?'Saving…':'Save automatic run limits'}</button>
  {saved&&<p role="status" className="text-sm">{saved}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </form>;
}
