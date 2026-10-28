import {RuleProposalCards} from '../../strategies/TakeRules';
import { ReferenceDocument } from './ReferenceDocument';
import { ProposalCards } from '../../strategies/BasketPanel';
import { MessageVersions, VersionPager } from './MessageVersions';
import { openTakeRules } from '../../strategies/TakeRules';
import { Link } from '@tanstack/react-router';
import { providerLabels } from './AiPicker';
import { UsageButton } from './UsageDetails';
import { StatusDot, type DotTone } from './StatusDot';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AssistantRuntimeProvider, useExternalStoreRuntime, ThreadPrimitive, MessagePrimitive, type ThreadMessageLike, type TextMessagePartProps } from '@assistant-ui/react';
import { Streamdown } from 'streamdown';
import type { ModelProvider, ModelResult } from '../../../../shared/ai-models';
import type { Take, TakeMessage, ToolActivity } from '../../../../shared/takes';
import { visibleMessages } from '../../../../shared/takes';
import { ReferenceImage } from './ReferenceImage';
import { ToolAccessCards } from './ToolAccessCards';
import { splitReplies, type ReplyOptions } from '../../../../shared/reply-options';
const streaming=(m:TakeMessage)=>m.state==='running'||m.state==='starting';
/** What the member reads: an assistant reply without its reply-button block. */
const shown=(m:TakeMessage)=>m.role==='assistant'?splitReplies(m.text,streaming(m)).text:m.text;
const convert=(m:TakeMessage):ThreadMessageLike=>({id:m.id,role:m.role,content:[{type:'text',text:shown(m)}],createdAt:new Date(m.createdAt),...(m.role==='assistant'?{status:m.state==='running'||m.state==='starting'?{type:'running' as const}:{type:'complete' as const,reason:'stop' as const}}:{})});
/** "5 min · 20 tool calls · 20 turns · 50k tokens · $1.00" */
function runLimitsText(l:NonNullable<NonNullable<TakeMessage['ruleRun']>['limits']>){
 return [`${Math.round(l.durationMs/60000)} min`,l.toolCalls&&`${l.toolCalls} tool calls`,l.modelTurns&&`${l.modelTurns} turns`,l.outputTokens&&`${l.outputTokens>=1000?Math.round(l.outputTokens/1000)+'k':l.outputTokens} tokens`,`$${l.costUsd.toFixed(2)}`].filter(Boolean).join(' · ');
}
/** Sent as your next message under a stopped reply, so any AI picks up from its partial text. */
const continuePrompt='Continue from where you stopped.';
const clock=(iso:string)=>new Date(iso).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
/** "robinhood_get_portfolio" → "Robinhood portfolio"; "opentake_market_quotes" → "Market quotes". */
export function toolName(name:string){const label=name.replace(/^opentake_/,'').replace(/(^|_)get_/,'$1').replaceAll('_',' ');return label.charAt(0).toUpperCase()+label.slice(1);}
const toolTone:Record<ToolActivity['state'],DotTone>={running:'attention',completed:'success',failed:'destructive'};
function toolSeconds(tool:ToolActivity){if(!tool.finishedAt)return null;const ms=Date.parse(tool.finishedAt)-Date.parse(tool.startedAt);return Number.isFinite(ms)&&ms>=0?`${(ms/1000).toFixed(ms<10000?1:0)} s`:null;}
/** Numbers in trigger evidence read in monospace, as in the rest of the money UI. */
function Mono({text}:{text:string}){return <>{text.split(/(\$?-?\d+(?:,\d{3})*(?:\.\d+)?%?)/).map((part,i)=>i%2?<span key={i} className="font-mono text-foreground">{part}</span>:<Fragment key={i}>{part}</Fragment>)}</>;}
function Markdown({text}:TextMessagePartProps) {
 return <Streamdown className="min-w-0 max-w-full space-y-3 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto text-sm leading-7 [&_[data-streamdown=table-wrapper]]:my-3 [&_[data-streamdown=table-wrapper]]:block [&_[data-streamdown=table-wrapper]]:rounded-none [&_[data-streamdown=table-wrapper]]:border-0 [&_[data-streamdown=table-wrapper]]:bg-transparent [&_[data-streamdown=table-wrapper]]:p-0 [&_[data-streamdown=table-wrapper]>div]:rounded-none [&_[data-streamdown=table-wrapper]>div]:border-0 [&_[data-streamdown=table-wrapper]>div]:bg-transparent [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-xs [&_thead]:bg-transparent [&_th]:px-0 [&_th]:pr-6 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.12em] [&_th]:text-muted-foreground [&_td]:px-0 [&_td]:pr-6 [&_td]:py-2 [&_td:first-child]:font-medium [&_tbody]:border-b [&_tbody]:border-border [&_ul]:list-none [&_ul]:pl-0 [&_ul>li]:relative [&_ul>li]:pl-5 [&_ul>li]:before:absolute [&_ul>li]:before:left-0 [&_ul>li]:before:text-muted-foreground [&_ul>li]:before:content-['–']" skipHtml controls={false} urlTransform={(url,key)=>{if(key==='src')return '';try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}} components={{img:()=>null,a:({href,children})=><button type="button" className="text-left underline" onClick={()=>{if(href)void window.takes.openLink(href);}}>{children}</button>}}>{text}</Streamdown>;
}
/** The tools a reply called: "Used 3 tools · 1 failed", each with its state, detail and time. */
function ToolActivityList({tools}:{tools:ToolActivity[]}){
 const failed=tools.filter(t=>t.state==='failed').length;
 return <details className="group text-xs text-muted-foreground"><summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-foreground [&::-webkit-details-marker]:hidden"><ChevronDown size={13} aria-hidden="true" className="-rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none"/>Used {tools.length} {tools.length===1?'tool':'tools'}{failed?` · ${failed} failed`:''}</summary>
  <ul className="mt-2 space-y-1.5 pl-5">{tools.map(tool=>{const seconds=toolSeconds(tool);return <li key={tool.id} className="flex items-baseline gap-2.5"><StatusDot tone={toolTone[tool.state]} className="relative -top-px"/><span className="shrink-0 font-medium text-foreground">{toolName(tool.name)}</span>
   <span className={`min-w-0 flex-1 truncate ${tool.state==='failed'?'text-destructive':''}`} title={tool.detail}>{tool.detail??(tool.state==='failed'?'failed':tool.state==='running'?'running…':'')}</span>
   {seconds&&<span className="shrink-0 font-mono tabular-nums">{seconds}</span>}</li>;})}</ul>
 </details>;
}
/** "Run details · Open rule" under a rule firing; details show the limits the run started with. */
function RuleRunActions({limits,onOpenRule}:{limits?:NonNullable<TakeMessage['ruleRun']>['limits'];onOpenRule:()=>void}){
 const [open,setOpen]=useState(false);
 return <div className="mt-2 pl-4 text-xs text-muted-foreground"><p className="flex gap-4">{limits&&<button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="hover:text-foreground">Run details</button>}<button type="button" onClick={onOpenRule} className="hover:text-foreground">Open rule</button></p>
  {open&&limits&&<p className="mt-1.5 tabular-nums">Automatic run, no one watching. Limits {runLimitsText(limits)}</p>}</div>;
}
/** The latest reply's suggested answers. Choosing one sends it as your message; "other" puts you in the composer. */
/** A reply's suggested answers. Once one is picked it stays highlighted here instead of
 *  showing as your message; picking another answers again from this reply, like Edit. */
function ReplyButtons({replies,picked,disabled,onChoose,onOther,children}:{replies:ReplyOptions;picked:string|null;disabled:boolean;onChoose:(text:string)=>void;onOther?:(hint:string)=>void;children?:React.ReactNode}){
 return <div role="group" aria-label={picked?'Your answer':'Suggested replies'} className="flex flex-wrap items-center gap-2">
  {replies.options.map(option=>{const chosen=option===picked;return <button key={option} type="button" aria-pressed={picked?chosen:undefined} disabled={disabled||chosen} onClick={()=>onChoose(option)}
   className={`rounded-xl px-4 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring ${chosen?'bg-foreground text-background':picked?'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:opacity-40':'bg-muted hover:bg-muted/70 disabled:opacity-40'}`}>{option}</button>;})}
  {!picked&&replies.other&&onOther&&<button type="button" disabled={disabled} onClick={()=>onOther(replies.other!)} className="px-2 py-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">{replies.other}</button>}
  {children}
 </div>;
}
/** The reply button your message picked from the reply before it, when it is exactly one of them. */
function pickedOption(reply:TakeMessage|undefined,answer:TakeMessage|undefined):string|null{
 if(reply?.role!=='assistant'||answer?.role!=='user'||reply.state!=='completed'||reply.imported||answer.imported||answer.ruleRun||answer.images.length||answer.documents?.length)return null;
 const text=answer.text.trim();
 return splitReplies(reply.text).replies?.options.includes(text)?text:null;
}
/** Which account a reply used, and whether older turns were condensed for it. */
function ReplyContext({message}:{message:TakeMessage}){
 const [open,setOpen]=useState(false);const condensed=message.context?.condensedMessages;
 return <div className="text-xs text-muted-foreground"><p className="flex flex-wrap items-center gap-x-2 gap-y-1">
  {message.coinbaseAccount&&<span className="flex items-center gap-1.5"><span aria-hidden="true" className="grid size-3.5 place-items-center rounded-full bg-[#0052ff] text-[8px] font-bold text-white">C</span>Coinbase · {message.coinbaseAccount.label}</span>}
  {message.coinbaseAccount&&condensed!==undefined&&<span aria-hidden="true">·</span>}
  {condensed!==undefined&&<button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="underline decoration-border underline-offset-4 hover:text-foreground">{condensed} earlier {condensed===1?'reply':'replies'} condensed</button>}</p>
  {open&&<p className="mt-1.5">Excerpts from {condensed} older {condensed===1?'reply':'replies'} and their tool results were used. Your messages, images and recent turns were kept in full. The original conversation is still available above.</p>}
 </div>;
}
export function Conversation({take,catalogs,running,onSend,onBranch,onError,onReviewBasket,onCompose}:{take:Take;catalogs:Partial<Record<ModelProvider,ModelResult>>;running:boolean;onSend:(text:string,parent:string|null,images?:string[],regenerate?:boolean,documents?:string[],keepDraft?:boolean)=>Promise<void>;onBranch:(id:string)=>void;onError:(s:string)=>void;onReviewBasket:(takeId:string)=>void;onCompose:(hint:string)=>void}) {
 const messages=useMemo(()=>visibleMessages(take),[take]);const [editing,setEditing]=useState<string>();const [edit,setEdit]=useState('');const [copied,setCopied]=useState<string>();
 useEffect(()=>{const open=(event:Event)=>{const id=(event as CustomEvent<{requestId:string}>).detail?.requestId;const node=id&&document.querySelector(`[data-rule-request="${CSS.escape(id)}"]`);if(node)node.scrollIntoView({block:'start',behavior:'smooth'});};window.addEventListener('take-rule-run-open',open);return()=>window.removeEventListener('take-rule-run-open',open);},[]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(undefined),2000);return()=>clearTimeout(timer);},[copied]);
 const runtime=useExternalStoreRuntime({messages,convertMessage:convert,isRunning:running,onNew:async m=>onSend(m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'),take.headId),onCancel:async()=>window.takes.stop(take.id)});
 const action='hover:text-foreground disabled:opacity-40';
 const stop=()=>void window.takes.stop(take.id).catch(()=>onError('Could not stop response.'));
 return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="min-w-0 space-y-8">
 <span role="status" aria-live="polite" className="sr-only">{copied?'Message copied.':''}</span>
 <ThreadPrimitive.Messages>{({message:runtimeMessage})=>{const index=messages.findIndex(m=>m.id===runtimeMessage.id),message=messages[index];if(!message)return null;
  const catalog=catalogs[message.selection.provider];
  const selectedModel=catalog?.ok?catalog.models.find(model=>model.value===message.selection.model):undefined;
  const modelName=(selectedModel?.label??message.selection.model).replace(/\s*\(Default\)$/i,'').trim();
  const responseLabel=!modelName||modelName.toLowerCase()==='default'?(providerLabels[message.selection.provider]??message.selection.provider):modelName;
  // Where an imported conversation starts (main/take-file.ts): it is shown as written, and the AI sees it only as a quote.
  const importStart=!!message.imported&&!messages[index-1]?.imported;
  // An automatic rule run: the firing is shown as an event, not as something the member wrote.
  if(message.ruleRun)return <MessagePrimitive.Root data-message-id={message.id} data-rule-request={message.ruleRun.requestId} aria-label="Rule run" className="min-w-0 border-y border-border py-4 text-sm [overflow-wrap:anywhere]">
   <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1"><StatusDot tone="attention"/><span className="font-medium">Rule fired</span><span className="text-muted-foreground">{message.ruleRun.ruleName}</span><span className="ml-auto text-xs text-muted-foreground"><time dateTime={message.createdAt}>{clock(message.createdAt)}</time> · ran on its own</span></p>
   <p className="mt-2 whitespace-pre-wrap pl-4 leading-6"><Mono text={message.text}/></p>
   <RuleRunActions limits={message.ruleRun.limits} onOpenRule={()=>openTakeRules(take.id,false,message.ruleRun!.ruleId)}/>
  </MessagePrimitive.Root>;
  const versionsFor=(message:TakeMessage)=>{const siblings=take.messages.filter(m=>m.parentId===message.parentId&&m.role===message.role);
  return (message.versionCount??0)>1?<MessageVersions key={message.id} takeId={take.id} messageId={message.id} number={message.versionNumber??1} count={message.versionCount!} disabled={running} onBranch={onBranch}/>:siblings.length>1&&<VersionPager number={siblings.findIndex(m=>m.id===message.id)+1} count={siblings.length} disabled={running} onStep={target=>onBranch(siblings[target-1].id)}/>;};
  const versions=versionsFor(message);
  const copy=<button type="button" className={action} onClick={()=>void navigator.clipboard.writeText(shown(message)).then(()=>setCopied(message.id)).catch(()=>onError('Could not copy message.'))}>{copied===message.id?'Copied':'Copy'}</button>;
  const time=<time className="tabular-nums" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{clock(message.createdAt)}</time>;
  const attachments=<>{!!message.documents?.length&&<div className="flex flex-wrap justify-end gap-2">{message.documents.map(doc=><ReferenceDocument key={doc.id} document={doc}/>)}</div>}
   {!!message.images.length&&<div className="flex flex-wrap justify-end gap-2">{message.images.map(image=><ReferenceImage key={image.id} image={image}/>)}</div>}</>;
  const divider=importStart&&<p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">Imported · exported {new Date(message.imported!.exportedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</p>;
  // Shown as the highlighted button on the reply before it.
  if(message.role==='user'&&pickedOption(messages[index-1],message))return null;
  if(message.role==='user')return <>{divider}<MessagePrimitive.Root data-message-id={message.id} aria-label="Your message" className="ml-auto flex min-w-0 max-w-[85%] flex-col items-end gap-2 [overflow-wrap:anywhere]">
   {attachments}
   {editing===message.id?<form className="w-full min-w-[min(28rem,100%)]" onSubmit={e=>{e.preventDefault();void onSend(edit,message.parentId,message.images.map(i=>i.id),false,message.documents?.map(d=>d.id)??[],true).then(()=>setEditing(undefined)).catch(e=>onError(String(e.message)));}}>
    <textarea autoFocus aria-label="Edit message" rows={3} className="w-full resize-y rounded-2xl border border-border bg-muted px-4 py-3 text-sm leading-6 outline-none focus-visible:ring-1 focus-visible:ring-ring" value={edit} onChange={e=>setEdit(e.target.value)}/>
    <div className="mt-2 flex items-center justify-end gap-4 text-sm"><button type="button" className="text-muted-foreground hover:text-foreground" onClick={()=>setEditing(undefined)}>Cancel</button><button disabled={running} className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-40">Save and send</button></div>
   </form>:<div className="rounded-2xl bg-muted px-4 py-2.5 [&_*]:leading-6"><MessagePrimitive.Content components={{Text:Markdown}}/></div>}
   {editing!==message.id&&<div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground">{time}{copy}<button type="button" className={action} disabled={running} onClick={()=>{setEditing(message.id);setEdit(message.text);}}>Edit</button>{versions}</div>}
  </MessagePrimitive.Root></>;
  const active=message.state==='running'||message.state==='starting',ended=['failed','interrupted','cancelled'].includes(message.state);
  const current=[...message.tools].reverse().find(t=>t.state==='running');
  // Only the latest finished reply offers buttons; older answers stay in the thread as text.
  // The latest finished reply offers its buttons; an earlier one keeps them when one was picked.
  const answer=messages[index+1],picked=pickedOption(message,answer);
  const replies=(index===messages.length-1||picked)&&message.state==='completed'&&!message.imported?splitReplies(message.text).replies:null;
  return <>{divider}<MessagePrimitive.Root data-message-id={message.id} className="min-w-0 space-y-3 [overflow-wrap:anywhere]" aria-label="AI response">
  <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{message.imported?'Imported reply':responseLabel}</span> · {time}</p>
  {!!message.tools.length&&<ToolActivityList tools={message.tools}/>}
  <MessagePrimitive.Content components={{Text:Markdown}}/>
  {replies&&<ReplyButtons replies={replies} picked={picked} disabled={running} onChoose={text=>void onSend(text,message.id,[],false,[],true).catch(e=>onError(e.message))} onOther={picked?undefined:onCompose}>{picked&&answer&&versionsFor(answer)}</ReplyButtons>}
  {!message.text&&active&&<div role="status" className="space-y-2 text-sm text-muted-foreground"><p className="flex items-center gap-2.5"><StatusDot tone="attention"/>{current?`Using ${toolName(current.name).toLowerCase()}…`:'Thinking…'}</p><span aria-hidden="true" className="flex gap-1 pl-px">{[0,1,2].map(i=><span key={i} className="size-1 rounded-full bg-muted-foreground animate-pulse motion-reduce:animate-none" style={{animationDelay:`${i*200}ms`}}/>)}</span><button type="button" onClick={stop} className="block text-xs hover:text-foreground">Stop</button></div>}
  {(message.coinbaseAccount||message.context)&&<ReplyContext message={message}/>}
  {message.error&&message.state!=='cancelled'&&<p role="alert" className="text-sm">{message.stopReason?<><span className="font-medium text-destructive">Stopped early.</span> {message.error}</>:<span className="text-destructive">{message.error}</span>}</p>}
  {(message.state==='cancelled'||message.state==='interrupted')&&<p role="status" className="flex flex-wrap items-center gap-x-2.5 text-sm text-muted-foreground"><StatusDot tone="muted"/>{message.state==='cancelled'?'You stopped this reply':'Interrupted when the app closed'}{!!message.text&&<><span aria-hidden="true">·</span><button type="button" disabled={running} onClick={()=>void onSend(continuePrompt,message.id,[],false,[],true).catch(e=>onError(e.message))} className="hover:text-foreground disabled:opacity-40">Continue</button></>}</p>}
  {message.state==='failed'&&<div className="flex items-center gap-4"><button type="button" disabled={running} onClick={()=>void onSend('',message.parentId,[],true,[],true).catch(e=>onError(e.message))} className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-40">Retry</button>{message.stopReason==='budget'&&<Link to="/settings" search={{section:'ai-settings'}} className="text-xs text-muted-foreground hover:text-foreground">Raise the limit</Link>}</div>}
  <RuleProposalCards messageId={message.id} running={active}/>
  <ToolAccessCards messageId={message.id} running={active}/>
  <ProposalCards messageId={message.id} running={active} onReview={onReviewBasket}/>
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
   {copy}
   {message.state!=='failed'&&<button type="button" className={action} disabled={running} onClick={()=>void onSend('',message.parentId,[],true,[],true).catch(e=>onError(e.message))}>{ended?'Retry':'Regenerate'}</button>}
   <UsageButton usage={message.usage}/>
   {versions&&<div className="ml-auto">{versions}</div>}
  </div>
 </MessagePrimitive.Root></>;}}</ThreadPrimitive.Messages>
 </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
