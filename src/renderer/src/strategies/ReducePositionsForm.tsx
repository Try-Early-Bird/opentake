import {HoldingLogo,useLogos} from '../components/HoldingLogo';
import {cryptoLogo} from '../crypto-logos';
import type {ReactNode} from 'react';
import {Button} from '../components/ui/button';
import {money as fiatMoney} from '../portfolio/format';
export interface ReductionBand {minimumAmount:string;maximumAmount:string;possible:boolean;holdingsValue:string}
export interface ReductionPreview {ok:boolean;legs:{symbol:string;notional:string;quantity?:string;venue?:string;currency?:string}[];remainingValue:string;reasons:{code:string;needed?:string}[];estimatedProceeds?:string;fees?:string}
const money=(value:string,currency:string)=>currency==='USDC'?`${Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} USDC`:fiatMoney(value,currency);
function reasonText(reason:{code:string;needed?:string},currency:string){
 switch(reason.code){
 case 'below_band':return `Minimum ${money(reason.needed??'0',currency)} required, so the sale is worth placing.`;
 case 'above_band':return `At most ${money(reason.needed??'0',currency)} can come out, so every holding keeps enough to stay tradable.`;
 case 'no_partial_redemption':return 'This investment is too small to take part of it out. Close it instead.';
 case 'nothing_to_sell':return 'There is nothing to sell yet.';
 default:return reason.code;
 }
}
/** Venue-neutral reduction form. Adapters own sizing and execution; this component never trades. */
export function ReducePositionsForm({amount,onAmountChange,currency,band,preview,busy,onCancel,onConfirm,currencyControl,error,onRetry,loading=false,proceedsSummary,accountName='your account',crypto=false,holdings=[]}:{
 proceedsSummary?:ReactNode;amount:string;onAmountChange:(value:string)=>void;currency:string;band:ReductionBand|null;preview:ReductionPreview|null;busy:boolean;
 onCancel:()=>void;onConfirm:()=>void;currencyControl?:ReactNode;error?:string;onRetry?:()=>void;loading?:boolean;accountName?:string;crypto?:boolean;holdings?:{symbol:string;quantity:string}[];
}){
 const logos=useLogos(crypto?[]:preview?.legs.map(l=>l.symbol)??[]);
 const formatted=(value:string)=>Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const maximum=band?.possible?Number(band.maximumAmount):null;
 const amountValid=Number.isFinite(Number(amount))&&Number(amount)>0;
 return <>
  <div className="py-3 text-center">
   <div className="flex items-baseline justify-center gap-1"><span className="text-3xl text-muted-foreground/50">$</span><input aria-label="Amount to take out" inputMode="decimal" placeholder="0" value={amount} disabled={busy} onChange={e=>onAmountChange(e.target.value.replace(/[^0-9.]/gu,'').slice(0,18))} style={{width:`${Math.max(1,amount.length||1)}ch`}} className="min-w-[1ch] max-w-full bg-transparent text-center font-mono text-4xl font-medium tabular-nums outline-none"/></div>
   <div className="mt-3 flex justify-center gap-2">{[25,50].map(percent=><button key={percent} type="button" disabled={busy||maximum===null} className="rounded-full bg-muted px-3 py-1 text-xs disabled:opacity-50" onClick={()=>onAmountChange((Math.floor(Math.min(maximum!,Number(band!.holdingsValue)*percent/100)*100)/100).toFixed(2))}>{percent}%</button>)}<button type="button" disabled={busy||maximum===null} className="rounded-full bg-muted px-3 py-1 text-xs disabled:opacity-50" onClick={()=>onAmountChange((Math.floor(maximum!*100)/100).toFixed(2))}>Max{maximum!==null?` $${formatted(String(maximum))}`:''}</button></div>
   {band&&<p className="mt-2 text-[11px] text-muted-foreground">{band.possible?`Minimum ${money(band.minimumAmount,currency)}`:'This investment is too small to take part of it out. Close it instead.'}</p>}
  </div>
  {!band&&!error&&<p role="status" className="text-xs text-muted-foreground">Loading withdrawal limits…</p>}
  {loading&&amount&&<p role="status" className="text-xs text-muted-foreground">Checking the sale…</p>}
  {currencyControl&&<div className="border-y border-border py-3">{currencyControl}</div>}
  {preview&&<div>
   {preview.reasons.map(reason=><p key={reason.code} className="text-xs text-error">{reasonText(reason,currency)}</p>)}
   {preview.ok&&<><p className="text-[10px] uppercase tracking-wider text-muted-foreground">This sells</p><ul className="mt-1 divide-y divide-border">{preview.legs.map(leg=>{
    const owned=holdings.find(h=>h.symbol===leg.symbol);
    const percent=owned&&leg.quantity&&Number(owned.quantity)>0?Math.round(Number(leg.quantity)/Number(owned.quantity)*100):null;
    return <li key={`${leg.venue??''}:${leg.symbol}`} className="flex items-center gap-3 py-3"><HoldingLogo weight={{symbol:leg.symbol,logoUrl:crypto||leg.venue==='coinbase'?cryptoLogo(leg.symbol):logos.get(leg.symbol)??null}} size="small"/><div className="min-w-0 flex-1"><p className="text-sm row-title">{leg.symbol}</p>{leg.venue&&<p className="text-[11px] capitalize text-muted-foreground">{leg.venue}</p>}{owned&&<p className="mt-0.5 text-[11px] text-muted-foreground">{percent!==null?`About ${percent}% of your `:'You hold '}{Number(owned.quantity).toLocaleString('en-US',{maximumFractionDigits:8})}</p>}</div><span className="font-mono text-sm tabular-nums">{formatted(leg.notional)}{leg.currency&&<span className="ml-1 text-[10px] text-muted-foreground">{leg.currency}</span>}</span></li>;
   })}</ul>
   {proceedsSummary??<div className="border-t border-border py-3"><div className="flex items-baseline justify-between gap-3"><span className="text-xs">Back to {accountName}{preview.fees!==undefined?', after fees':''}</span><span className="whitespace-nowrap font-mono text-lg tabular-nums">≈ {formatted(preview.estimatedProceeds??amount)} <span className="font-sans text-[10px] text-muted-foreground">{currency}</span></span></div><p className="mt-1 text-[11px] text-muted-foreground">{preview.fees!==undefined?`Fees ≈ ${money(preview.fees,currency)} · `:''}{money(preview.remainingValue,currency)} stays invested</p></div>}
   </>}
  </div>}
  {error&&<div><p role="alert" className="text-xs text-error">{error}</p>{onRetry&&<button type="button" disabled={busy} className="mt-2 text-xs underline underline-offset-4" onClick={onRetry}>Retry preview</button>}</div>}
  <div className="flex justify-end gap-2 pt-2"><Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button><Button size="sm" className="rounded-full px-4" disabled={busy||!!error||loading||!band?.possible||!preview?.ok||!amountValid} onClick={onConfirm}>{busy?'Selling…':amountValid?`Take out $${Number(amount).toLocaleString('en-US',{maximumFractionDigits:2})}`:'Take out'}</Button></div>
 </>;
}
