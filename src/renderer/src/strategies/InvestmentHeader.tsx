import {money} from '../portfolio/format';

/** Consistent value and all-time P&L placement for every Take. */
export function InvestmentHeader({value,currency,gain=null,returnPercent=null}:{value:string|null;currency:string;gain?:number|null;returnPercent?:number|null}){
 const direction=gain??returnPercent;
 const amount=gain===null?null:`${gain<0?'-':'+'}${money(Math.abs(gain),currency)}`;
 const percent=returnPercent===null?null:`${returnPercent<0?'-':'+'}${Math.abs(returnPercent).toFixed(2)}%`;
 return <>
  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Your investment</p>
  <div className="mt-2 flex items-baseline justify-between gap-3">
   <p className="font-mono text-2xl tabular-nums">{value===null?'—':money(value,currency)}</p>
   <div className="text-right"><p className={`font-mono text-xs tabular-nums ${direction===null?'text-muted-foreground':direction>=0?'text-success':'text-error'}`}>{amount&&percent?`${amount} (${percent})`:amount??percent??'—'}</p><p className="mt-1 text-[10px] text-muted-foreground">Total P&amp;L · All time</p></div>
  </div>
 </>;
}
