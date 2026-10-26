import {DollarSign} from 'lucide-react';
import {createContext,useContext,useEffect,type ReactNode} from 'react';
import {InvestmentHeader} from './InvestmentHeader';
import {money} from '../portfolio/format';

/** The same investment header and holding rows for both venues. */
export interface InvestmentSummaryData {pendingBuys?:{symbol:string;amount:string|null;expectedAt:string|null}[];value:string|null;currency:string;gain?:number|null;returnPercent?:number|null;positions:{symbol:string;name:ReactNode;logo?:ReactNode;quantity:ReactNode;price?:string|null;value?:string|null;account?:string}[];cash:{currency:string;value:string|null;account?:string;quantity?:string;reserved?:string|null}[]}
export const InvestmentSummaryCollector=createContext<((data:InvestmentSummaryData)=>void)|null>(null);
export function InvestmentSummary(props:InvestmentSummaryData){
 const collect=useContext(InvestmentSummaryCollector);
 const {value,currency,gain=null,returnPercent=null,positions,cash}=props;
 // React labels are presentation; publish only when the underlying balances change.
 const signature=JSON.stringify({value,currency,gain,returnPercent,positions:positions.map(({name,logo,...position})=>position),cash,pendingBuys:props.pendingBuys});
 useEffect(()=>{collect?.(props);},[collect,signature]);
 if(collect)return null;
 return <>
  <InvestmentHeader value={value} currency={currency} gain={gain} returnPercent={returnPercent}/>
  <ul className="mt-4 divide-y divide-border border-t border-border" aria-label="Investment holdings">
   {positions.map(position=>{
    const weight=value!==null&&Number(value)>0&&position.value!=null?Number(position.value)/Number(value)*100:null;
    const price=position.price!=null&&Number.isFinite(Number(position.price))?new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:Math.abs(Number(position.price))<1?8:2}).format(Number(position.price)):'—';
    return <li key={`${position.account??''}:${position.symbol}`} className="flex items-center gap-3 py-3">
     <div className="flex size-8 shrink-0 items-center justify-center">{position.logo??<span className="text-xs text-muted-foreground">{position.symbol.slice(0,2)}</span>}</div>
     <div className="min-w-0 flex-1"><div className="flex items-baseline gap-2 text-sm"><span className="font-medium">{position.name}</span><span className="font-mono text-xs tabular-nums text-muted-foreground">{weight!==null&&Number.isFinite(weight)?`${weight.toFixed(1)}%`:'—'}</span></div><p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{position.quantity} · {price}</p>{position.account&&<p className="mt-0.5 text-xs text-muted-foreground">{position.account}</p>}</div>
     <span className="font-mono text-sm tabular-nums">{position.value==null?'—':money(position.value,currency)}</span>
    </li>;
   })}
   {cash.map(balance=>{
    const weight=value!==null&&Number(value)>0&&balance.value!==null?Number(balance.value)/Number(value)*100:null;
    return <li key={`${balance.account??''}:${balance.currency}`} className="flex items-center gap-3 py-3 text-muted-foreground"><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white"><DollarSign size={16}/></span><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2 text-sm"><span className="font-medium">Cash</span><span className="font-mono text-xs tabular-nums">{weight!==null&&Number.isFinite(weight)?`${weight.toFixed(1)}%`:'—'}</span></div><p className="mt-0.5 text-xs">{balance.currency}{balance.account?` · ${balance.account}`:' held in the take'}</p></div><span className="font-mono text-sm tabular-nums">{balance.value===null?'—':money(balance.value,currency)}</span></li>;
   })}
  </ul>
 </>;
}
