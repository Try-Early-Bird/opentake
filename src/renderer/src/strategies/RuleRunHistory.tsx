import {useEffect,useState} from 'react';
type Run={id:string;created_at:string;rule_name:string|null;status:string;trade_state:string|null;trade_reason:string|null};
type Page={items:Run[];next:{createdAt:string;id:string}|null};
function outcome(run:Run){
 if(run.trade_state==='completed')return run.trade_reason==='already_on_target'?'Already on target · no trade needed':'Completed';
 if(run.trade_state==='attention')return 'Needs attention';
 if(run.trade_state==='blocked')return run.trade_reason?.includes('expired')?'Expired':run.trade_reason==='cancelled'?'Cancelled':'Blocked';
 if(run.trade_state==='pending'||run.trade_state==='working')return 'In progress';
 return ({expired:'Expired',superseded:'Superseded',action_blocked:'Blocked',notified:'Alert sent',executed:'Completed',context_failed:'Context unavailable',conditions_false:'Conditions not met',context_pending:'In progress',shadow:'Triggered'} as Record<string,string>)[run.status]??run.status;
}
export function RuleRunHistory({takeId}:{takeId:string}){
 const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;setPage(null);setError('');void window.dataSources.configure({action:'rule-evidence-list',takeId,limit:20}).then(value=>{if(active)setPage(value as Page);}).catch(()=>{if(active)setError('Could not load rule history.');});return()=>{active=false;};},[takeId]);
 async function more(){if(!page?.next)return;setBusy(true);setError('');try{const next=await window.dataSources.configure({action:'rule-evidence-list',takeId,limit:20,before:page.next}) as Page;setPage(old=>({items:[...(old?.items??[]),...next.items],next:next.next}));}catch{setError('Could not load rule history.');}finally{setBusy(false);}}
 return <section aria-label="Rule run history" className="mb-5 border-b border-border pb-4"><h3 className="mb-2 text-xs font-medium text-muted-foreground">Rule runs</h3>{error&&<p role="alert" className="text-xs text-destructive">{error}</p>}{!page&&!error?<p className="text-xs text-muted-foreground">Loading rule history…</p>:page&&!page.items.length?<p className="text-xs text-muted-foreground">No recorded runs.</p>:<ol className="divide-y divide-border">{page?.items.map(run=><li key={run.id} className="py-3"><div className="flex items-start justify-between gap-3"><p className="font-medium">{run.rule_name??'Rule'}</p><time className="shrink-0 text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></div><p className="mt-1 text-xs text-muted-foreground">{outcome(run)}{run.trade_reason&&run.trade_reason!=='already_on_target'?` · ${run.trade_reason.replaceAll('_',' ')}`:''}</p></li>)}</ol>}{page?.next&&<button disabled={busy} className="mt-2 text-xs underline disabled:opacity-40" onClick={()=>void more()}>{busy?'Loading…':'Load older rule runs'}</button>}</section>;
}
