import { useEffect,useState } from 'react';
import type { McpMetadataRevision,McpMetadataSummary } from '../../../shared/mcp-management';

export function McpMetadataDetails({revision}:{revision:string}){
 const [item,setItem]=useState<McpMetadataRevision>();const [error,setError]=useState('');
 useEffect(()=>{let active=true;setItem(undefined);setError('');void window.mcp.metadataRevision(revision).then(value=>{if(active)setItem(value);}).catch(()=>{if(active)setError('Could not load this metadata revision.');});return()=>{active=false;};},[revision]);
 if(error)return <p role="alert" className="text-sm text-destructive">{error}</p>;
 if(!item)return <p role="status" className="text-sm text-muted-foreground">Loading server guidance…</p>;
 return <div className="space-y-3 py-3 text-sm">
  <p className="break-words">Provided by {item.snapshot.serverName} · {item.snapshot.destination}</p>
  <p className="text-muted-foreground">Revision {item.id} · observed {new Date(item.observed_at).toLocaleString()}</p>
  <p>{item.summary}</p>
  <p className="text-xs text-muted-foreground">Server-provided guidance for its tools. App instructions and permissions still apply.</p>
  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{item.snapshot.instructions||'This server supplied no instructions.'}</pre>
  <details><summary className="cursor-pointer">Tool metadata ({item.snapshot.tools.length})</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.snapshot.tools,null,2)}</pre></details>
  <details><summary className="cursor-pointer">Revision fingerprints</summary><p className="mt-2 break-all font-mono text-xs">Current: {item.fingerprint}<br/>Previous: {item.previous_fingerprint??'None'}</p></details>
 </div>;
}

export function McpMetadataHistory({server}:{server:string}){
 const [items,setItems]=useState<McpMetadataSummary[]>([]);const [next,setNext]=useState<string|null>(null);const [selected,setSelected]=useState<string>();const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 async function load(before?:string){setBusy(true);setError('');try{const result=await window.mcp.metadataHistory(server,before);setItems(old=>before?[...old,...result.items]:result.items);setNext(result.next);}catch{setError('Could not load server metadata history.');}finally{setBusy(false);}}
 useEffect(()=>{void load();},[server]);
 return <section aria-label="MCP guidance history" className="space-y-3">
  <p className="text-sm text-muted-foreground">Changes found when you refresh tools. Updated guidance applies to new responses without asking for approval again.</p>
  <button className="text-sm underline" disabled={busy} onClick={()=>void load()}>Refresh history</button>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!busy&&!items.length&&!error&&<p className="text-sm">No guidance saved yet. Refresh this server’s tools to check for instructions.</p>}
  {items.map(item=><div key={item.id} className="py-2"><button aria-expanded={selected===item.id} className="text-left text-sm" onClick={()=>setSelected(selected===item.id?undefined:item.id)}>Revision {item.id} · {new Date(item.observed_at).toLocaleString()}<span className="block text-muted-foreground">{item.summary}</span></button>{selected===item.id&&<McpMetadataDetails revision={item.id}/>}</div>)}
  {next&&<button className="text-sm underline" disabled={busy} onClick={()=>void load(next)}>Load older changes</button>}
 </section>;
}
