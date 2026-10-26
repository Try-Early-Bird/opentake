import {MixedCashSummary} from './MixedCashSummary';
import {InvestmentHeader} from './InvestmentHeader';
import {SlidersHorizontal} from 'lucide-react';
import type {MixedExecution} from '../../../shared/mixed-execution';
import {mixedLegFinished} from '../../../shared/mixed-execution';
import {investmentVenues,type InvestmentVenue} from '../../../shared/investment-venues';
import type {TakeAccountPlan} from '../../../shared/strategy-account-plan';
import {RobinhoodLogoTile} from '../logos';
import {money} from '../portfolio/format';
import type {InvestmentSummaryData} from './InvestmentSummary';
import {combineInvestmentSummaries} from './mixed-summary';

const number=(value:string)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value));
export function MixedInvestmentSummary({plan,run,summaries,onManage}:{onManage?:(venue:InvestmentVenue)=>void;plan:TakeAccountPlan;run:MixedExecution;summaries:Partial<Record<InvestmentVenue,InvestmentSummaryData>>}){
 const total=combineInvestmentSummaries(run.legs.flatMap(leg=>summaries[leg.venue]?[{account:leg.accountId,data:summaries[leg.venue]!}]:[]),run.legs.every(leg=>!!summaries[leg.venue]));
 const weight=(value:string|null|undefined)=>total.value!==null&&Number(total.value)>0&&value!=null?`${(Number(value)/Number(total.value)*100).toFixed(1)}%`:'—';
 return <section aria-label="Your investment">
  <div className="mb-5"><InvestmentHeader value={total.value} currency="USD" gain={total.gain} returnPercent={total.returnPercent}/></div>
  {run.legs.map(leg=>{
   const data=summaries[leg.venue],account=plan.accounts.find(a=>a.id===leg.accountId),route=plan.routes.find(r=>r.venue===leg.venue);
   const working=!mixedLegFinished(leg.state),waiting=leg.state==='waiting_market';
   const positions=data?.positions??[];
   const missing=working?(route?.assets??[]).filter(asset=>!positions.some(p=>p.symbol===asset.symbol)):[];
   const pending=(symbol:string)=>{
    if(!working)return null;
    const order=data?.pendingBuys?.find(p=>p.symbol===symbol);
    if(!order&&!missing.some(p=>p.symbol===symbol))return null;
    const when=order?.expectedAt?`opens ${new Date(order.expectedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`:waiting?'waiting for market open':leg.state==='attention'?'needs attention':'preparing orders';
    return <p className={`mt-1 text-[11px] ${leg.state==='attention'?'text-error':'text-muted-foreground'}`}><span aria-hidden className="mr-1">•</span>{order?.amount?`Buying ${money(order.amount,data?.currency??'USD')} · `:'Buy queued · '}{when}</p>;
   };
   return <section key={leg.venue} aria-label={`${investmentVenues[leg.venue].label} holdings`}>
    <div className="flex items-center gap-1.5 border-y border-border py-2 text-[11px]">
     {leg.venue==='robinhood'?<RobinhoodLogoTile className="size-4" markClassName="size-2.5"/>:<span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded bg-[#0052ff]"><span className="size-2 rounded-full bg-white"/></span>}
     <span className="flex min-w-0 items-baseline gap-1.5"><span>{account?.label??investmentVenues[leg.venue].label}</span><span className="text-[10px] leading-none text-muted-foreground">{investmentVenues[leg.venue].label}</span></span>
     <span className="ml-auto text-right font-mono text-[10px] text-muted-foreground" title="Available account buying power">{account?.balances.filter(b=>Number(b.amount)>0).map(b=>`${b.asset} ${number(b.amount)}`).join(' · ')||'—'}</span>
     {onManage&&<button type="button" aria-label={`Manage ${investmentVenues[leg.venue].label}`} aria-haspopup="dialog" title={`Manage ${investmentVenues[leg.venue].label}`} onClick={()=>onManage(leg.venue)} className={`flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${leg.state==='attention'?'text-error':'text-muted-foreground'}`}><SlidersHorizontal className="size-3.5"/></button>}
    </div>
    {leg.state==='attention'&&<p role="status" className="pt-2 text-xs text-error">Needs attention · open account controls</p>}
    {!data?<p className="py-3 text-xs text-muted-foreground">Loading holdings…</p>:<ul className="divide-y divide-border">
     {positions.map(position=><li key={position.symbol} className="flex items-center gap-2.5 py-3">
      <span className="flex size-6 shrink-0 items-center justify-center [&>*]:size-6">{position.logo??<span className="rounded-full bg-muted text-center text-xs leading-6">{position.symbol[0]}</span>}</span>
      <div className="min-w-0 flex-1"><p className="flex items-baseline gap-2 text-xs">{position.name}<span className="font-mono text-[10px] text-muted-foreground">{data.currency==='USD'?weight(position.value):'—'}</span></p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{position.quantity} · {position.price?number(position.price):'—'}</p>{pending(position.symbol)}</div>
      <span className="font-mono text-xs">{position.value==null?'—':money(position.value,data.currency)}</span>
     </li>)}
     {missing.map(asset=><li key={asset.symbol} className="flex items-center gap-2.5 py-3"><span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs">{asset.symbol[0]}</span><div className="flex-1"><p className="flex items-baseline gap-2 text-xs">{asset.symbol}<span className="font-mono text-[10px] text-muted-foreground">0% of {asset.bps/100}%</span></p>{pending(asset.symbol)}</div><span className="font-mono text-xs text-muted-foreground">—</span></li>)}

    </ul>}
   </section>;
  })}
  <MixedCashSummary plan={plan} run={run} summaries={summaries} totalValue={total.value}/>
 </section>;
}
