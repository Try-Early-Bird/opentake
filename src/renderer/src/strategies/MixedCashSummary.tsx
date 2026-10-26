import {useState} from 'react';
import {DollarSign} from 'lucide-react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../components/ui/app-dialog';
import type {TakeAccountPlan} from '../../../shared/strategy-account-plan';
import type {MixedExecution} from '../../../shared/mixed-execution';
import {investmentVenues,type InvestmentVenue} from '../../../shared/investment-venues';
import type {InvestmentSummaryData} from './InvestmentSummary';
import {money} from '../portfolio/format';
import {RobinhoodLogoTile} from '../logos';
import {Button} from '../components/ui/button';

export function mixedCash(run:MixedExecution,summaries:Partial<Record<InvestmentVenue,InvestmentSummaryData>>){
 const complete=run.legs.every(l=>!!summaries[l.venue]&&summaries[l.venue]!.currency==='USD');
 const rows=run.legs.flatMap(leg=>(summaries[leg.venue]?.cash??[]).map(c=>({...c,venue:leg.venue,accountId:leg.accountId,state:leg.state,pendingBuys:summaries[leg.venue]?.pendingBuys??[],value:summaries[leg.venue]?.currency==='USD'?c.value:null})));
 const value=complete&&rows.every(r=>r.value!==null&&Number.isFinite(Number(r.value)))?rows.reduce((sum,r)=>sum+Number(r.value),0):null;
 return {rows,value};
}
/** Display cash together; its currency quantities and reservations stay account-local. */
export function MixedCashSummary({plan,run,summaries,totalValue}:{plan:TakeAccountPlan;run:MixedExecution;summaries:Partial<Record<InvestmentVenue,InvestmentSummaryData>>;totalValue:string|null}){
 const [open,setOpen]=useState(false),{rows,value}=mixedCash(run,summaries);
 const weight=value!==null&&totalValue!==null&&Number(totalValue)>0?value/Number(totalValue)*100:null;
 const pending=rows.some(r=>r.reserved==null||Number(r.reserved)>0);
 return <>
  <button type="button" aria-label="Cash breakdown" aria-haspopup="dialog" onClick={()=>setOpen(true)} className="flex w-full items-center gap-2.5 border-t border-border py-3 text-left hover:bg-muted/30">
   <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white"><DollarSign size={13}/></span>
   <span className="min-w-0 flex-1"><span className="flex items-baseline gap-2 text-xs">Cash<span className="font-mono text-[10px] text-muted-foreground">{weight===null?'—':`${weight.toFixed(1)}%`}</span></span><span className="mt-1 block text-[10px] text-muted-foreground">{pending?'Includes cash held for pending buys':'Available across your Take accounts'}</span></span>
   <span className="font-mono text-xs">{value===null?'—':money(value,'USD')}</span>
  </button>
  <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-md p-6"><CashBreakdownContents plan={plan} run={run} summaries={summaries} onDone={()=>setOpen(false)}/></DialogContent></Dialog>
 </>;
}

export function cashHeldValue(row:ReturnType<typeof mixedCash>['rows'][number]):number|null{
 if(row.value===null||row.quantity==null||!Number.isFinite(Number(row.quantity)))return null;
 const quantity=Number(row.quantity),value=Number(row.value);
 let held=row.reserved==null?null:Number(row.reserved);
 // A queued buy has assigned cash even before a broker order is submitted.
 if(held===null&&row.state==='waiting_market'&&row.currency==='USD'&&row.pendingBuys.length&&row.pendingBuys.every(p=>p.amount!==null))held=row.pendingBuys.reduce((n,p)=>n+Number(p.amount),0);
 if(held===null||!Number.isFinite(held)||!Number.isFinite(value)||quantity<0)return null;
 return quantity===0?0:Math.min(quantity,Math.max(0,held))/quantity*value;
}
export function CashBreakdownContents({plan,run,summaries,onDone}:{plan:TakeAccountPlan;run:MixedExecution;summaries:Partial<Record<InvestmentVenue,InvestmentSummaryData>>;onDone:()=>void}){
 const {rows,value}=mixedCash(run,summaries),held=rows.map(cashHeldValue);
 const heldTotal=value!==null&&held.every(v=>v!==null)?held.reduce<number>((n,v)=>n+v!,0):null;
 return <>
  <DialogHeader><DialogTitle>Cash in this take</DialogTitle><DialogDescription>Stays in each account and funds that account’s trades.</DialogDescription></DialogHeader>
  <div className="mt-2 divide-y divide-border border-t border-border">{rows.map((r,index)=>{
   const heldValue=held[index],available=heldValue===0,partial=heldValue!==null&&r.value!==null&&heldValue>0&&heldValue<Number(r.value);
   const symbols=[...new Set(r.pendingBuys.map(p=>p.symbol))].join(', ');
   const status=available?'Available':heldValue===null?'Checking cash availability':partial?'Part available · part held':r.state==='waiting_market'?`Held for ${symbols?`${symbols} buys`:'queued buys'}`:`Held for ${symbols||'pending'} orders`;
   return <div key={`${r.accountId}:${r.currency}`} className="flex items-center gap-3 py-4">
    {r.venue==='robinhood'?<RobinhoodLogoTile className="size-8" markClassName="size-5"/>:<span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#0052ff]"><span className="size-3.5 rounded-full bg-white"/></span>}
    <div className="min-w-0 flex-1"><p className="text-sm"><span className="font-medium">{plan.accounts.find(a=>a.id===r.accountId)?.label??investmentVenues[r.venue].label}</span><span className="text-muted-foreground"> · {investmentVenues[r.venue].label}</span></p><p className={`mt-1 flex items-center gap-1.5 text-xs ${available?'text-success':'text-muted-foreground'}`}><span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current"/>{status}</p></div>
    <div className="text-right font-mono"><p className="text-sm">{r.value===null?'—':money(r.value,'USD')}</p><p className="mt-1 text-[11px] text-muted-foreground">{r.currency==='USD'?'USD':`${r.quantity==null?'—':Number(r.quantity).toLocaleString(undefined,{maximumFractionDigits:4})} ${r.currency}`}</p></div>
   </div>;
  })}</div>
  <div className="flex items-baseline justify-between gap-3 border-t border-border pt-4"><span className="text-sm text-muted-foreground">Total</span><div className="flex flex-wrap items-baseline justify-end gap-3">{heldTotal!==null&&value!==null&&<span className="text-xs text-muted-foreground">{money(Math.max(0,value-heldTotal),'USD')} free · {money(heldTotal,'USD')} held</span>}<span className="font-mono text-xl">{value===null?'—':money(value,'USD')}</span></div></div>
  <div className="mt-3 flex justify-end"><Button className="rounded-full px-6" onClick={onDone}>Done</Button></div>
 </>;
}
