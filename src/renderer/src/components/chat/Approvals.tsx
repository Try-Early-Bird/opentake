import { PlatformVerification } from './PlatformVerification';
import { ChangedNotice, useManagedTool } from '../ToolChanges';
import { toolLabel } from '../McpToolRow';
import { useToasts } from '../ui/toast';
import { useEffect,useState } from 'react';
import type { ToolApproval } from '../../../../shared/mcp-management';
import { approvalCopy, requested } from '../../../../shared/tool-approval-copy';
export function Approvals(){const [items,setItems]=useState<ToolApproval[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const notifications=useToasts();useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const v=await window.mcp.approvals();if(active){setItems(v);notifications.recover('approvals-poll');}}catch{if(active)notifications.error('approvals-poll','Could not check tool approvals. Retrying…',true);}if(active)timer=setTimeout(poll,750);};void poll();return()=>{active=false;clearTimeout(timer);};},[notifications]);
 async function decide(id:string,approved:boolean){setBusy(true);try{await window.mcp.decide(id,approved);setItems(old=>old.filter(i=>i.id!==id));setError('');}catch{setError('Could not save approval. Please try again.');}finally{setBusy(false);}}
 // "Always allow" opens the tool in Settings, then lets this call through.
 async function always(item:ToolApproval){setBusy(true);try{await window.mcp.policy(item.server_id,item.tool_name,'allowed');await window.mcp.decide(item.id,true);setItems(old=>old.filter(i=>i.id!==item.id));setError('');}catch{setError('Could not save approval. Please try again.');}finally{setBusy(false);}}
 return <><p role="status" className="sr-only">{items.length?`${items.length} tool approval requests waiting.`:''}</p><PlatformVerification />{items.map(item=><ApprovalCard key={item.id} item={item} busy={busy} decide={approved=>void decide(item.id,approved)} always={()=>void always(item)}/>)}{error&&<p role="alert" className="text-xs text-destructive">{error}</p>}</>;
}

/** A proposal tool's input in a line: "2 rules · Drift alert, Stop-loss", or "AI picks & shovels · 6 holdings". */
function proposalLine(item:ToolApproval){
 let input:Record<string,unknown>;try{input=(typeof item.input==='string'?JSON.parse(item.input):item.input??{}) as Record<string,unknown>;}catch{return null;}
 const strong=(text:string)=><span className="text-foreground">{text}</span>;
 if(item.tool_name==='opentake_propose_rules'){
  const rules=(input.config as {rules?:{name?:unknown}[]}|undefined)?.rules;if(!Array.isArray(rules))return null;
  const names=rules.map(r=>typeof r?.name==='string'?r.name:'').filter(Boolean);
  return <>{rules.length} {rules.length===1?'rule':'rules'} in the proposed set{names.length?<> · {strong(names.slice(0,3).join(', ')+(names.length>3?' …':''))}</>:null}</>;
 }
 if(item.tool_name==='opentake_propose_strategy'){
  const title=(input.metadata as {title?:unknown}|undefined)?.title,weights=(input.spec as {target?:{weights?:unknown[]}}|undefined)?.target?.weights;
  if(typeof title!=='string'&&!Array.isArray(weights))return null;
  return <>{typeof title==='string'&&strong(title)}{typeof title==='string'&&Array.isArray(weights)?' · ':''}{Array.isArray(weights)&&`${weights.length} ${weights.length===1?'holding':'holdings'}`}</>;
 }
 return null;
}
/** What the call will send, in a line: an email recipient, else the first few values. */
function inputLine(input:unknown,schema:Record<string,unknown>|undefined){
 const values=Object.entries(Object(input) as Record<string,unknown>).filter(([,v])=>v!==undefined&&v!==null&&v!=='');
 if(!values.length)return null;
 const fields=(schema?.properties??{}) as Record<string,{format?:string}>;
 const email=values.find(([k])=>fields[k]?.format==='email');
 if(email)return <>Will send to <code className="font-mono text-foreground">{String(email[1])}</code></>;
 return <>Will send {values.slice(0,3).map(([k,v],i)=><span key={k}>{i?' · ':''}{k} <code className="font-mono text-foreground">{(typeof v==='string'?v:JSON.stringify(v)).slice(0,60)}</code></span>)}{values.length>3?' …':''}</>;
}

function ApprovalCard({item,busy,decide,always}:{item:ToolApproval;busy:boolean;decide:(approved:boolean)=>void;always:()=>void}){
 const [details,setDetails]=useState(false);
 const access=item.tool_name==='opentake_request_tool_access',request=requested(item);
 const tool=useManagedTool(access?request.serverId:item.server_id,access?request.name:item.tool_name);
 const copy=approvalCopy(item),label=toolLabel(access?request.name??'a tool':item.tool_name);
 const changed=!!tool?.previous_definition&&tool.blocked_reason==='changed';
 const subtitle=access?request.reason??'':copy.description||(tool?.definition.description??'');
 return <div className="mx-auto my-2 max-w-3xl rounded-xl border border-border bg-muted/20 p-4" role="region" aria-label="Tool approval">
  <p className="text-sm font-semibold">{access?`Chat wants to turn on ${label}`:`Chat wants to use ${label}`}</p>
  {subtitle&&<p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
  {access&&<p className="mt-1 text-xs text-muted-foreground">{request.policy==='allowed'?'Chat can use it without asking':'Chat asks you before each use'}, from its next response.</p>}
  {changed&&tool&&<div className="mt-3"><ChangedNotice tool={tool} title="This tool changed since you allowed it" expandable/></div>}
  {item.platform_sharing&&<p className="mt-3 text-xs text-muted-foreground">This conversation can access account data or contains data shared earlier. This action may send that data to {item.server_name||'another MCP server'} at {item.destination}.</p>}
  <div className="mt-3 flex items-baseline justify-between gap-3 text-xs text-muted-foreground"><span className="min-w-0 break-words">{access?null:proposalLine(item)??inputLine(item.input,tool?.definition.inputSchema)}</span>
   <button type="button" aria-expanded={details} onClick={()=>setDetails(v=>!v)} className="shrink-0 hover:text-foreground">Details</button></div>
  {details&&<div className="mt-2 space-y-2 text-xs text-muted-foreground">
   <p className="break-words">Tool: <code>{item.tool_name}</code> · {item.server_name||item.server_id} · {item.destination}</p>
   {item.input!=null&&Object.keys(Object(item.input)).length>0&&<pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-foreground">{JSON.stringify(item.input,null,2)}</pre>}
   <p>Expires {new Date(item.expires_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}.{access?'':' Allow once applies to this call only.'}</p>
  </div>}
  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
   <div className="flex items-center gap-2 text-sm">
    <button disabled={busy} onClick={()=>decide(true)} className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-50">{access?'Turn on':'Allow once'}</button>
    {!access&&<button disabled={busy} onClick={always} className="rounded-full border border-border px-4 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">Always allow</button>}
    <button disabled={busy} onClick={()=>decide(false)} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">Decline</button>
   </div>
   <span className="text-[11px] text-muted-foreground">Change later in Settings → MCP</span>
  </div>
 </div>;
}
