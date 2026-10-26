import {RefreshCw} from 'lucide-react';
import type {CoinbaseLifecycle} from '../../../shared/coinbase-lifecycle';
import {Button} from '../components/ui/button';
const time=(value:string)=>new Date(value).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
const cash=(value:string)=>Number(value)>0&&Number(value)<0.01?'<0.01':Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
export function RebalanceStatus({view,busy,onToggle,onRefresh}:{view:CoinbaseLifecycle;busy:boolean;onToggle:()=>void;onRefresh:()=>void}){
 const bands=[view.currentRules.driftBandPoints!==null?`${view.currentRules.driftBandPoints} ${view.currentRules.driftBandPoints===1?'pt':'pts'}`:null,view.currentRules.driftBandRelative!==null?`${view.currentRules.driftBandRelative}% relative`:null].filter(Boolean).join(' or ');
 const warning=view.driftEnabled?view.rebalanceWarning:null;
 return <section aria-label="Drift rebalancing" className="my-3 border-b border-border pb-4">
  <div className="flex items-center justify-between gap-3 py-3">
   <div className="min-w-0"><h3 className="flex items-center gap-2 text-sm font-medium"><span className={`size-2 shrink-0 rounded-full ${view.driftEnabled?'bg-success':'bg-muted-foreground'}`}/>Drift rebalancing</h3>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{view.driftEnabled?`Triggers at ${bands} off target · checks every 30 seconds`:`Paused · ${bands} off target`}</p></div>
   <Button variant="ghost" size="sm" disabled={busy||view.pending} onClick={onToggle}>{view.driftEnabled?'Pause':'Enable'}</Button>
  </div>
  {warning&&<div role="status" className="border-t border-border pt-3">
   <div className="flex items-center justify-between gap-2"><p className="flex items-center gap-2 text-sm font-medium"><span className="size-2 shrink-0 rounded-full bg-muted-foreground"/>{warning.code==='insufficient_funds'?'Waiting on cash':'Below trade minimum'}</p>
    <div className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"><span>Checked {time(warning.checkedAt)}</span><Button variant="ghost" size="icon" className="size-7 rounded-full bg-muted" aria-label="Refresh rebalance status" disabled={busy} onClick={onRefresh}><RefreshCw size={14} className={busy?'animate-spin':''}/></Button></div>
   </div>
   <p className="mt-2 pl-4 text-xs leading-relaxed text-muted-foreground">{warning.code==='below_minimum'?'The adjustment is below the minimum trade size.':warning.cash?<>The Take is <span className="font-mono text-foreground">{cash(warning.cash.shortfall)} {warning.cash.currency}</span> short of covering the trade and fees.</>:'Available cash could not cover the trade and fees.'}{warning.nextRetryAt?` It will retry at ${time(warning.nextRetryAt)}, or on the next check after holdings or cash change.`:' It will be checked again automatically.'}</p>
   {warning.cash&&<p className="mt-3 flex gap-4 pl-4 font-mono text-xs text-muted-foreground"><span>Needs <span className="text-foreground">{cash(warning.cash.required)}</span></span><span>Has <span className="text-foreground">{cash(warning.cash.available)}</span></span><span>{warning.cash.currency}</span></p>}
  </div>}
 </section>;
}
