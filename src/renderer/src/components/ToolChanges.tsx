// What changed in an MCP tool since the member last allowed it, and why it is off:
// shown on the tool's row in Settings → MCP and on chat's approval cards.
import { useEffect,useState } from 'react';
import { toolChanges,toolChangeSummary } from '../../../shared/tool-changes';
import type { ManagedTool } from '../../../shared/mcp-management';

export const blockedReasonLabel={new:'New · not reviewed yet',changed:'Blocked until you re-allow it',member:'Blocked by you'} as const;
export const shortDate=(iso:string)=>new Date(iso).toLocaleDateString(undefined,{month:'short',day:'numeric'});

/** "It now also … and needs … every time", from the definitions themselves. */
export function ChangeSummary({tool}:{tool:ManagedTool}){
 return <>{toolChangeSummary(tool.previous_definition,tool.definition).map((part,i)=>part.code?<code key={i} className="font-mono">{part.text}</code>:part.strong?<strong key={i} className="font-semibold text-foreground">{part.text}</strong>:<span key={i}>{part.text}</span>)}</>;
}

/** The amber note on a changed tool, optionally with a link to the field-by-field changes. */
export function ChangedNotice({tool,title,expandable=false}:{tool:ManagedTool;title:string;expandable?:boolean}){
 const [open,setOpen]=useState(false);
 return <div role="note" className="rounded-lg border border-attention/25 bg-attention/10 px-3 py-2.5 text-xs">
  <p className="flex items-center gap-1.5 font-medium text-attention"><span className="size-1.5 rounded-full bg-attention" aria-hidden="true"/>{title}</p>
  <p className="mt-1 text-foreground/80"><ChangeSummary tool={tool}/>{expandable&&<> <button type="button" onClick={()=>setOpen(v=>!v)} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{open?'Hide changes':'See what changed'}</button></>}</p>
  {open&&<div className="mt-3"><ToolChangesView tool={tool}/></div>}
 </div>;
}

/** Field by field, with both full definitions. */
export function ToolChangesView({tool}:{tool:ManagedTool}){
 if(!tool.previous_definition)return null;
 const changes=toolChanges(tool.previous_definition,tool.definition);
 return <section aria-label={`What changed in ${tool.name}`} className="space-y-2">
  {changes.length?<table className="w-full table-fixed text-left text-xs"><thead className="text-muted-foreground"><tr><th className="w-1/4 pb-1 font-normal">Field</th><th className="pb-1 font-normal">Before</th><th className="pb-1 font-normal">Now</th></tr></thead>
   <tbody>{changes.map(change=><tr key={change.field} className="border-t border-border align-top"><th scope="row" className="py-1.5 pr-2 font-normal">{change.field}</th>
    <td className="py-1.5 pr-2 break-words text-muted-foreground [overflow-wrap:anywhere]">{change.before??'—'}</td><td className="py-1.5 break-words font-medium [overflow-wrap:anywhere]">{change.after??'Removed'}</td></tr>)}</tbody></table>
  :<p className="text-xs text-muted-foreground">Only its schema details changed.</p>}
 </section>;
}

/** The live tool record, for an approval card. */
export function useManagedTool(serverId?:string,name?:string){
 const [tool,setTool]=useState<ManagedTool|null>(null);
 useEffect(()=>{let live=true;if(!serverId||!name)return;void window.mcp.list().then(list=>{if(live)setTool(list.tools.find(t=>t.server_id===serverId&&t.name===name)??null);}).catch(()=>{});return()=>{live=false;};},[serverId,name]);
 return tool;
}
