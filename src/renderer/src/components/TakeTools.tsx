import { RunUsageHistory } from './chat/RunUsageHistory';
import { Select } from './ui/select';
import { useEffect,useState } from 'react';
import type { ManagedServer,ManagedTool,TakeToolPermission,ToolPolicy } from '../../../shared/mcp-management';
import { Dialog,DialogContent,DialogTitle,DialogDescription } from './ui/dialog';
import { ToolHistory } from './ToolHistory';
/** A Take's tool calls, usage and its own tool restrictions; opened from the Take header. */
export function TakeTools({takeId,open,onOpenChange}:{takeId:string;open:boolean;onOpenChange:(open:boolean)=>void}) {
 const [tab,setTab]=useState<'permissions'|'history'|'usage'>('history');
 return <><Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl"><DialogTitle>Take tools & history</DialogTitle><DialogDescription>Restrict tool access for this take and inspect recorded calls.</DialogDescription><div role="tablist" aria-label="Take tools" className="flex gap-4 py-3"><button role="tab" aria-selected={tab==='permissions'} onClick={()=>setTab('permissions')}>Permissions</button><button role="tab" aria-selected={tab==='history'} onClick={()=>setTab('history')}>History</button><button role="tab" aria-selected={tab==='usage'} onClick={()=>setTab('usage')}>Usage</button></div>{tab==='permissions'?<TakePermissions takeId={takeId}/>:tab==='usage'?<RunUsageHistory takeId={takeId}/>:<ToolHistory takeId={takeId}/>}</DialogContent></Dialog></>;
}
function TakePermissions({takeId}:{takeId:string}){
 const [servers,setServers]=useState<ManagedServer[]>([]);const [tools,setTools]=useState<ManagedTool[]>([]);const [scopes,setScopes]=useState<TakeToolPermission[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{let active=true;setBusy(true);void Promise.all([window.mcp.list(),window.mcp.takePermissions(takeId)]).then(([all,values])=>{if(active){setServers(all.servers);setTools(all.tools);setScopes(values);}}).catch(()=>{if(active)setError('Could not load take permissions.');}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[takeId]);
 async function change(server:string,tool:string,value:string){setBusy(true);try{await window.mcp.setTakePermission(takeId,server,tool,value==='inherit'?null:value as ToolPolicy);setScopes(await window.mcp.takePermissions(takeId));setError('');}catch{setError('Could not save take permissions.');}finally{setBusy(false);}}
 const control=(server:ManagedServer,tool='')=>{
  const policy=scopes.find(s=>s.server_id===server.id&&s.tool_name===tool)?.policy;
  return <Select id={`take-policy-${takeId}-${server.id}-${encodeURIComponent(tool)}`} ariaLabel={`${tool||server.config.name} take policy`} disabled={busy} value={!policy||policy==='allowed'?'inherit':policy} onValueChange={value=>void change(server.id,tool,value)} className="w-52" items={[{value:'inherit',label:'No extra restriction'},{value:'ask',label:'Ask each time'},{value:'blocked',label:'Blocked'}]}/>;
 };
 return <div className="space-y-4"><p className="text-sm text-muted-foreground">Restrictions in Settings and your chosen instructions still apply. New restrictions take effect immediately. Additional access starts with the next response.</p>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{servers.map(server=><details key={server.id}><summary className="cursor-pointer py-2 font-medium">{server.config.name}</summary><div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>Server · global: {server.enabled?server.policy:'disabled'}</span>{control(server)}</div>{tools.filter(t=>t.server_id===server.id).map(tool=><div key={tool.name} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span className="min-w-0 break-all">{tool.name}<small className="block text-muted-foreground">Global tool policy: {tool.policy}</small></span>{control(server,tool.name)}</div>)}</details>)}</div>;
}
