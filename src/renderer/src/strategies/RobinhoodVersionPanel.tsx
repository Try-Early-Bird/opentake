import {useEffect,useState} from 'react';
import type {TakeVersionReview} from '../../../shared/take-version-review';
import {TakeVersionBanner,TakeVersionChangeRows} from './TakeVersionChanges';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../components/ui/app-dialog';
import {Button} from '../components/ui/button';
export function RobinhoodVersionPanel({allocationId,onChanged}:{allocationId:string;onChanged:()=>void}){
 const [view,setView]=useState<TakeVersionReview|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(open)return;let active=true;const load=()=>window.allocations.versionReview(allocationId).then(v=>{if(active)setView(v);}).catch(()=>{});void load();const timer=setInterval(()=>void load(),15000);return()=>{active=false;clearInterval(timer);};},[allocationId,open]);
 async function switchVersion(){if(!view||busy)return;setBusy(true);setError('');try{setView(await window.allocations.adoptVersion(allocationId,view.versionId,view.currentVersionId));setOpen(false);onChanged();}catch(e){setError(e instanceof Error?e.message:'Could not switch versions.');}finally{setBusy(false);}}
 if(!view||view.versionId===view.currentVersionId)return null;
 return <><TakeVersionBanner view={view} onReview={()=>{setError('');setOpen(true);}}/><Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogContent className="sm:max-w-lg p-6"><DialogHeader><DialogTitle>What changed in v{view.currentVersionSequence}</DialogTitle><DialogDescription>Future buys and rebalances follow the new version. Switching places no orders itself; configured rules may trigger a rebalance on the next check.</DialogDescription></DialogHeader><TakeVersionChangeRows view={view} venue="robinhood"/>{error&&<p role="alert" className="text-xs text-error">{error}</p>}<DialogFooter className="mx-0 mb-0 border-0 bg-transparent px-0 pb-0"><Button variant="ghost" disabled={busy} onClick={()=>setOpen(false)}>Stay on v{view.versionSequence}</Button><Button className="rounded-full" disabled={busy} onClick={()=>void switchVersion()}>{busy?'Saving…':`Switch to v${view.currentVersionSequence}`}</Button></DialogFooter></DialogContent></Dialog></>;
}
