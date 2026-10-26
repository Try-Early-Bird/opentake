import {TakeVersionBanner,TakeVersionChangeRows} from './TakeVersionChanges';
import {RebalanceStatus} from './RebalanceStatus';
import {useEffect,useState} from 'react';
import type {CoinbaseLifecycle,CoinbaseLifecycleDecision} from '../../../shared/coinbase-lifecycle';
import {AlertCard} from '../components/AlertCard';
import {Button} from '../components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../components/ui/app-dialog';
export function CoinbaseLifecyclePanel({takeId,onChanged,onCloseTake,onBlocked,onStatusVisible}:{takeId:string;onChanged:()=>void;onCloseTake:()=>void;onBlocked:(value:boolean)=>void;onStatusVisible?:(value:boolean)=>void}){
 const [view,setView]=useState<CoinbaseLifecycle|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[decision,setDecision]=useState<CoinbaseLifecycleDecision['action']|null>(null);
 const accept=(value:CoinbaseLifecycle)=>{setView(value);onBlocked(!!value.blocked||value.archived||value.changes.length>0||value.versionId!==value.currentVersionId);};
 useEffect(()=>{if(decision)return;let active=true;const load=()=>window.strategies.coinbaseLifecycle(takeId).then(v=>{if(active)accept(v);}).catch(()=>{});void load();const timer=setInterval(()=>void load(),15000);return()=>{active=false;clearInterval(timer);};},[takeId,decision]);
 const refresh=async()=>{setBusy(true);setError('');try{accept(await window.strategies.coinbaseLifecycle(takeId,true));}catch(e){setError(e instanceof Error?e.message:'Could not refresh.');}finally{setBusy(false);}};
 const apply=async()=>{if(!view||!decision)return;setBusy(true);setError('');try{const fresh=await window.strategies.coinbaseLifecycle(takeId,true);accept(fresh);if(fresh.evidence!==view.evidence)throw Error('Account or Take changed. Review the latest values.');accept(await window.strategies.decideCoinbaseLifecycle({takeId,evidence:view.evidence,action:decision}));setDecision(null);onChanged();}catch(e){setError(e instanceof Error?e.message:'Could not save this decision.');}finally{setBusy(false);}};
 const statusVisible=!!(view?.funded&&!view.blocked&&!view.archived&&!view.changes.length&&view.versionId===view.currentVersionId&&view.canEnableDrift);
 useEffect(()=>{onStatusVisible?.(statusVisible);return()=>onStatusVisible?.(false);},[statusVisible,onStatusVisible]);
 if(!view)return null;
 const changed=view.versionId!==view.currentVersionId;
 return <>
  {view.pending?null:view.blocked&&view.funded?<AlertCard title="Review this account" source={view.accountLabel} rows={[]} footnote={view.blocked} primary={{label:busy?'Refreshing…':'Refresh account',disabled:busy,onClick:()=>void refresh()}}/>:
   view.changes.length?<AlertCard title="Your account changed outside this Take" source={view.accountLabel} rows={view.changes.map(c=>({label:`${c.takeTitle} · ${c.asset}`,value:`${Number(c.before)} → ${Number(c.after)}`}))} footnote="Available assets no longer cover these Take allocations. Review the adjustment before continuing." primary={{label:'Review changes',onClick:()=>setDecision('reconcile')}} secondary={{label:'Refresh',onClick:()=>void refresh(),disabled:busy}}/>:
   view.archived&&view.funded?<AlertCard title="You archived this take" source={view.accountLabel} rows={[]} footnote="Choose what to sell, or keep the holdings in your account outside this Take." primary={{label:'Choose what to sell',onClick:onCloseTake}} secondary={{label:'Keep all holdings',onClick:()=>setDecision('release')}}/>:
   changed?<TakeVersionBanner view={view} onReview={()=>setDecision('adopt')}/>:null}
  {statusVisible&&<RebalanceStatus view={view} busy={busy} onToggle={()=>setDecision(view.driftEnabled?'disable_drift':'enable_drift')} onRefresh={()=>void refresh()}/>}
  {error&&!decision&&<p role="alert" className="text-xs text-error">{error}</p>}
  <Dialog open={!!decision} onOpenChange={open=>{if(!open&&!busy)setDecision(null);}}><DialogContent className={decision==='adopt'?'sm:max-w-lg p-6':'max-w-sm'}><DialogHeader><DialogTitle>{decision==='adopt'?`What changed${view.currentVersionSequence?` in v${view.currentVersionSequence}`:''}`:decision==='reconcile'?'Review account changes':decision==='release'?'Keep holdings and close':decision==='enable_drift'?'Enable drift rebalancing':'Disable drift rebalancing'}</DialogTitle><DialogDescription>{decision==='reconcile'?`Missing assets will be removed proportionally from all affected Takes in ${view.accountLabel}. No trades or transfers are placed.`:decision==='adopt'?'Future buys and rebalances follow the new version. Switching places no orders itself; configured drift rules are enabled and may trigger a rebalance on the next check.':decision==='release'?`Release this Take’s cash and holdings to ${view.accountLabel}. Nothing is sold.`:decision==='enable_drift'?'Check the Take’s configured drift limits and rebalance when crossed, at most once per UTC day. Your trade-confirmation preference still applies.':'Stop new drift-triggered rebalances. Existing orders and calendar schedules are unchanged.'}</DialogDescription></DialogHeader>
   {decision==='reconcile'&&view.changes.map(c=><div key={c.allocationId+c.asset} className="flex justify-between gap-3 text-sm"><span>{c.takeTitle} · {c.asset}</span><span>{Number(c.before)} → {Number(c.after)}</span></div>)}
   {decision==='adopt'&&<TakeVersionChangeRows view={view}/>}
   {error&&<p role="alert" className="text-xs text-error">{error}</p>}
   <DialogFooter className={decision==='adopt'?'mx-0 mb-0 border-0 bg-transparent px-0 pb-0':undefined}><Button variant="ghost" disabled={busy} onClick={()=>setDecision(null)}>{decision==='adopt'?`Stay on ${view.versionSequence?`v${view.versionSequence}`:'current version'}`:'Cancel'}</Button><Button disabled={busy||!!view.blocked} onClick={()=>void apply()}>{busy?'Saving…':decision==='reconcile'?'Keep reduced':decision==='adopt'?`Switch to ${view.currentVersionSequence?`v${view.currentVersionSequence}`:'new version'}`:decision==='release'?'Keep and close':decision==='enable_drift'?'Enable':'Disable'}</Button></DialogFooter>
  </DialogContent></Dialog>
 </>;
}
