import {Clock,ChevronRight,Pause,Play,Settings} from 'lucide-react';
import {RobinhoodLogoTile} from '../logos';
import {logCalls,callLevel,callTitle,type LogCall} from '../../../shared/log-calls';
import {priceErrors} from '../../../shared/price-diagnostics';
import {Link} from '@tanstack/react-router';
import {useEffect,useState} from 'react';
import {rebalanceReasons,type DiagnosticPage,type RebalanceReason} from '../../../shared/diagnostics';
import {Button,buttonVariants} from '../components/ui/button';
import {Select} from '../components/ui/select';

export function Logs(){
 const [page,setPage]=useState<DiagnosticPage>();
 const [error,setError]=useState('');
 const [live,setLive]=useState(true);
 const [level,setLevel]=useState('all');
 const [source,setSource]=useState('all');
 const [search,setSearch]=useState('');
 const [limit,setLimit]=useState(100);
 useEffect(()=>{
  let active=true;let timer:ReturnType<typeof setTimeout>;
  async function load(){try{const next=await window.settings.logs();if(active){setPage(next);setError('');}}catch{if(active)setError('Could not load logs. Reopen this section to retry.');}finally{if(active&&live)timer=setTimeout(load,3000);}}
  void load();return()=>{active=false;clearTimeout(timer);};
 },[live]);
 const rows=logCalls(page?.rows??[]).filter(call=>(source==='all'||call.row.source===source)&&(level==='all'||callLevel(call)===level)&&JSON.stringify([call,rebalanceReasons[call.row.reason as RebalanceReason],priceErrors[call.row.errorCode as keyof typeof priceErrors]]).toLowerCase().includes(search.toLowerCase()));
 return <section className="space-y-4" aria-labelledby="logs-heading">
  <div className="flex items-center justify-between"><h2 id="logs-heading" className="text-lg font-medium">Logs</h2><div className="flex items-center gap-1 text-muted-foreground"><Button variant="ghost" size="icon-sm" aria-label={live?'Pause updates':'Resume updates'} title={live?'Pause updates':'Resume updates'} onClick={()=>setLive(!live)}>{live?<Pause className="size-4" aria-hidden="true"/>:<Play className="size-4" aria-hidden="true"/>}</Button><Link to="/settings" search={{section:'data-retention'}} aria-label="Configure log retention" title="Configure log retention" className={buttonVariants({variant:'ghost',size:'icon-sm'})}><Settings className="size-4" aria-hidden="true"/></Link></div></div>
  <p className="text-sm text-muted-foreground">One row per call, with its request and response. Sensitive fields are omitted.</p>
  <div className="flex flex-wrap gap-2"><input aria-label="Search logs" placeholder="Search events, reasons, or Take ID" value={search} onChange={e=>{setSearch(e.target.value);setLimit(100);}} className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"/><Select id="log-source" ariaLabel="Log source" value={source} onValueChange={value=>{setSource(value);setLimit(100);}} items={[{value:'all',label:'All processes'},{value:'desktop',label:'App'},{value:'host',label:'Background'}]} className="w-36"/><Select id="log-level" ariaLabel="Log severity" value={level} onValueChange={value=>{setLevel(value);setLimit(100);}} items={[{value:"all",label:"All levels"},{value:"info",label:"Info"},{value:"warning",label:"Warning"},{value:"error",label:"Error"}]} className="w-32"/></div>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!page&&!error&&<p role="status" className="text-sm text-muted-foreground">Loading logs…</p>}
  {page&&rows.length===0&&<p className="text-sm text-muted-foreground">No matching events.</p>}
  <ol>{rows.slice(0,limit).map((call,index)=>{
   const day=new Date(call.row.time).toLocaleDateString();
   const previous=index?new Date(rows[index-1].row.time).toLocaleDateString():null;
   return <li key={call.id}>{day!==previous&&<h3 className="border-b pb-3 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">{day===new Date().toLocaleDateString()?'Today':day}</h3>}<CallRow call={call}/></li>;
  })}</ol>
  {page&&<p className="text-xs text-muted-foreground">Showing {Math.min(limit,rows.length)} of {rows.length} calls and events.</p>}
  {rows.length>limit&&<Button variant="outline" onClick={()=>setLimit(limit+100)}>Load more</Button>}
  {page?.truncated&&<p className="text-xs text-muted-foreground">Showing the newest 2,000 retained events. Retention is managed in Settings → Data Retention.</p>}
 </section>;
}

function CallRow({call}:{call:LogCall}){
 const row=call.row,level=callLevel(call),duration=row.details.durationMs;
 const tone=level==='error'?'text-destructive':level==='warning'?'text-amber-600':'text-emerald-700';
 const counts=['resultCount','ordersCount','fillsCount','positionsCount','candlesCount','walletsCount'].filter(k=>row.details[k]!==undefined).map(k=>`${row.details[k]} ${k==='resultCount'?'rows':k.replace('Count','')}`).join(' · ');
 const result=call.broker?(call.response?(row.event==='broker.failed'?`Failed · ${row.errorCode??'unknown error'}`:String(row.details.responseState??(row.details.accepted===false?'Rejected':row.details.accepted===true?'Accepted':counts||'Received'))):'Awaiting response'):row.reason?.replaceAll('_',' ')??row.stage??row.source;
 const time=new Date(row.time);
 const request=call.request?.request??(call.request?{symbols:call.request.symbols??[],...(call.request.details.requestCount===undefined?{}:{count:call.request.details.requestCount})}:undefined);
 return <details className="group border-b border-border py-3 text-sm">
  <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
   <time dateTime={row.time} className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{time.toLocaleTimeString([], {hour12:false})}.{String(time.getMilliseconds()).padStart(3,'0').slice(0,2)}</time>
   <span aria-label={level} className={`mt-2 size-2 shrink-0 rounded-full bg-current ${tone}`}/>
   {row.venue==='robinhood'?<RobinhoodLogoTile className="size-6 shrink-0" markClassName="size-4"/>:row.venue==='coinbase'?<span aria-label="Coinbase" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#0052ff]"><span className="size-2.5 rounded-full bg-white"/></span>:<Clock aria-label="System" className="size-6 shrink-0 rounded-md bg-muted p-1 text-muted-foreground"/>}
   <span className="min-w-0 flex-1"><span className="font-medium">{callTitle(row)}</span>{row.symbols?.length? <span className="ml-2 text-muted-foreground">{row.symbols.join(', ')}</span>:null}</span>
   <span className={`text-right font-mono text-xs ${level==='error'?'text-destructive':'text-muted-foreground'}`}>{result}{typeof duration==='number'?` · ${duration.toLocaleString()} ms`:''}</span>
   <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90"/>
  </summary>
  <div className="mt-3 space-y-4 pl-0 sm:pl-36">
   <p className="break-words font-mono text-xs text-muted-foreground">{row.venue??'system'} · {row.operation??row.event} · source {row.source}{row.details.accountId?` · account ${row.details.accountId}`:''}</p>
   {row.details.callId&&<p className="break-all font-mono text-xs text-muted-foreground">{row.details.callId}</p>}
   {row.takeId&&<Link to="/" search={{takeId:row.takeId}} className="text-xs underline">Open Take</Link>}
   {call.broker?<div className="grid gap-4 lg:grid-cols-2">
    <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">• Request</p>{request===undefined?<p className="text-muted-foreground">Request details were not retained.</p>:<Payload value={request}/>}</div>
    <div><p className={`mb-2 text-xs font-medium uppercase tracking-wide ${tone}`}>• Response · {result}{typeof duration==='number'?` · ${duration.toLocaleString()} ms`:''}</p>{row.event==='broker.failed'?<p>The call failed. Error code: {row.errorCode??'unknown'}. No successful response was recorded.</p>:call.response?.response!==undefined?<Payload value={call.response.response}/>:<p className="text-muted-foreground">{call.response?'Response payload was not retained.':'No response recorded yet; this does not confirm the call is still running.'}</p>}</div>
   </div>:<><p>{row.reason&&rebalanceReasons[row.reason as RebalanceReason]||row.errorCode&&priceErrors[row.errorCode as keyof typeof priceErrors]||result}</p><Payload value={row.details}/></>}
   <div className="flex flex-wrap gap-5 text-xs text-muted-foreground">{call.request&&<details><summary className="cursor-pointer">Request event · sanitized</summary><Payload value={call.request}/></details>}<details><summary className="cursor-pointer">{call.response?'Response event':'Event data'} · sanitized</summary><Payload value={call.response??row}/></details></div>
  </div>
 </details>;
}
function Payload({value}:{value:unknown}){return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(value,null,2)}</pre>;}
