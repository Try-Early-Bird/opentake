import {Button} from '../components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '../components/ui/app-dialog';

/** The same withdrawal entry point for every investment venue. */
export function TakeMoneyOutMenu({open,title,busy=false,canReduce=true,cashOnly=false,closeDescription='Choose what to sell and what to keep. You stop following the take.',onOpenChange,onReduce,onClosePositions}:{
 open:boolean;title:string;busy?:boolean;canReduce?:boolean;cashOnly?:boolean;closeDescription?:string;
 onOpenChange:(open:boolean)=>void;onReduce:()=>void;onClosePositions:()=>void;
}){
 return <Dialog open={open} onOpenChange={next=>{if(!busy)onOpenChange(next);}}>
  <DialogContent className="max-w-sm">
   <DialogHeader><DialogTitle>Take money out of {title}</DialogTitle></DialogHeader>
   {!cashOnly&&<button type="button" className="rounded-lg bg-muted/50 p-3 text-left transition-colors hover:bg-muted disabled:opacity-50" disabled={busy||!canReduce} onClick={()=>{onOpenChange(false);onReduce();}}>
    <span className="text-sm row-title">Reduce this investment</span>
    <span className="mt-0.5 block text-xs text-muted-foreground">{canReduce?'Sells part of what you hold, keeping the mix as close to the take as it can. You keep following it with less invested.':'Too small to take part of it out; close it instead.'}</span>
   </button>}
   <button type="button" className="rounded-lg bg-muted/50 p-3 text-left transition-colors hover:bg-muted disabled:opacity-50" disabled={busy} onClick={()=>{onOpenChange(false);onClosePositions();}}>
    <span className="text-sm row-title">{cashOnly?'Close and release cash':'Close all positions'}</span>
    <span className="mt-0.5 block text-xs text-muted-foreground">{cashOnly?'Make the uninvested cash available outside this Take. No sales are needed.':closeDescription}</span>
   </button>
   <div className="flex justify-end"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>onOpenChange(false)}>Cancel</Button></div>
  </DialogContent>
 </Dialog>;
}
