import {useId,type ReactNode} from 'react';
import {Button} from '../components/ui/button';
import {RobinhoodLogoTile} from '../logos';

/** Shared amount entry; each broker still owns eligibility and execution. */
export function InvestmentAmountForm({title='Invest in this take',actionLabel='Invest',amountLabel='Amount to invest in dollars',amount,onAmountChange,disabled,inputDisabled,onInvest,busyLabel,help,minimum,summary,currencyControl,maxAmount,funding}:{title?:string|null;actionLabel?:string;amountLabel?:string;amount:string;onAmountChange:(value:string)=>void;disabled:boolean;inputDisabled?:boolean;onInvest:()=>void;busyLabel?:string;help?:ReactNode;minimum?:ReactNode;summary?:ReactNode;footnote?:string;currencyControl?:ReactNode;maxAmount?:string|null;funding?:{accountName:string;platform:'Coinbase'|'Robinhood';currency:string;assets?:string;buyingPower?:{asset:string;amount:string}[]}}){
 const amountId=useId(),locked=inputDisabled??!!busyLabel;
 // Round down: Max must never exceed the adapter's available amount.
 const max=maxAmount&&/^\d+(\.\d+)?$/.test(maxAmount)?`${maxAmount.split('.')[0]}.${(maxAmount.split('.')[1]??'').padEnd(2,'0').slice(0,2)}`:null;
 const formatted=(value:string)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value));
 return <div>
  {title&&<p className="text-sm font-medium">{title}</p>}
  <div className="mt-6 mb-2 flex min-w-0 items-center justify-center gap-1">
   <label htmlFor={amountId} className="sr-only">Amount</label>
   <span aria-hidden="true" className="text-3xl font-medium text-muted-foreground/60">$</span>
   <input id={amountId} value={amount} placeholder="0.00" onChange={event=>onAmountChange(event.target.value.replace(/[^0-9.]/gu,'').slice(0,18))} style={{width:`${Math.max(3,Math.min(16,(amount||'0.00').length))}ch`}} inputMode="decimal" aria-label={amountLabel} disabled={locked} className="min-w-0 max-w-[85%] rounded-md bg-transparent text-center font-mono text-4xl font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground/60"/>
  </div>
  <div className="mb-4 text-center text-xs text-muted-foreground">{minimum}</div>
  <div className="mb-6 flex flex-wrap justify-center gap-1.5" aria-label="Quick investment amounts">
   {[10,20,50,100].map(value=><button key={value} type="button" disabled={locked} onClick={()=>onAmountChange(String(value))} className="rounded-full bg-muted px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">${value}</button>)}
   <button type="button" disabled={locked||max===null||Number(max)<=0} onClick={()=>{if(max!==null)onAmountChange(max);}} className="rounded-full bg-muted px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Max</button>
  </div>
  {funding&&<div className="space-y-3">
   <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Funded from</p>
   <div className="flex items-start gap-2.5">
    {funding.platform==='Robinhood'?<RobinhoodLogoTile className="mt-0.5 size-6" markClassName="size-3.5"/>:<span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[#0052ff]"><span className="size-3 rounded-full bg-white"/></span>}
    <div className="min-w-0 flex-1"><p className="text-sm row-title">{funding.accountName}</p><p className="text-xs text-muted-foreground">{funding.platform}</p>
     {currencyControl&&<div className="mt-2 flex items-center gap-2 text-xs"><span className="text-muted-foreground">Pay with</span>{currencyControl}</div>}
    </div>
    <span className="shrink-0 font-mono text-xs tabular-nums">${Number.isFinite(Number(amount))?formatted(amount||'0'):'—'}</span>
   </div>
  </div>}
  {!funding&&currencyControl}
  {help&&<p className="mt-2 text-xs text-muted-foreground">{help}</p>}
  {summary}
  <Button className="mt-4 w-full" onClick={onInvest} disabled={disabled||!Number.isFinite(Number(amount))||Number(amount)<=0||(max!==null&&Number(amount)>Number(max))}>{busyLabel??actionLabel}</Button>
 </div>;
}
