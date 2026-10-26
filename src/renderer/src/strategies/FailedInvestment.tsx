import {cryptoLogo} from '../crypto-logos';
import {HoldingLogo,useLogos} from '../components/HoldingLogo';
import {useMemo} from 'react';
import {Button} from '../components/ui/button';

const money=(value:number)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);

/** Planned amounts, never holdings: this attempt has not submitted orders. */
export function FailedInvestment({accountName,amount,currency,assets,error,busy,busyLabel,onRetry,onDismiss,platform='Coinbase'}:{accountName:string;amount?:string;currency:string;assets:{symbol:string;bps:number;notional?:string}[];platform?:'Coinbase'|'Robinhood';error:string|null;busy:boolean;busyLabel:string;onRetry:()=>void;onDismiss:()=>void}){
 const symbols=useMemo(()=>platform==='Robinhood'?assets.map(a=>a.symbol):[],[platform,assets]);
 const logos=useLogos(symbols);
 const total=amount!==undefined&&Number.isFinite(Number(amount))?Number(amount):null;
 const feeFailure=!!error&&/fees?|commission/i.test(error);
 const title=feeFailure?`Couldn’t invest with the current fees`:'Investment couldn’t start';
 return <div aria-label="Investment did not start" className="flex min-h-80 flex-col">
  <div className="mb-3 flex items-center justify-between gap-3">
   <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Your investment</p>
   <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-destructive"><span aria-hidden="true" className="size-1.5 rounded-full bg-current"/>Didn't start</p>
  </div>
  <div aria-label="Planned investment" className="divide-y divide-border">
   {assets.map(item=>{const logo=cryptoLogo(item.symbol);return <div key={item.symbol} className="flex items-center gap-2.5 py-3">
    {platform==='Robinhood'?<HoldingLogo weight={{symbol:item.symbol,logoUrl:logos.get(item.symbol)??null}} size="small"/>:logo?<img src={logo} alt="" className="size-7 shrink-0"/>:<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs">{item.symbol[0]}</span>}
    <span className="text-sm font-medium">{item.symbol}</span><span className="font-mono text-xs text-muted-foreground">{item.bps/100}%</span>
    <span className="ml-auto font-mono text-sm tabular-nums">{item.notional!==undefined?money(Number(item.notional)):total===null?'—':money(total*item.bps/10000)}</span>
   </div>;})}
  </div>
  <div className="flex items-baseline justify-between gap-3 border-t border-border py-3">
   <span className="text-xs text-muted-foreground">Total from {accountName}</span>
   <span className="whitespace-nowrap font-mono text-sm tabular-nums">{total===null?'—':money(total)} <span className="font-sans text-xs text-muted-foreground">{currency}</span></span>
  </div>
  <div role="alert" className="border-l-2 border-destructive pl-3">
   <p className="text-sm font-medium">{title}</p>
   {error&&<p className="mt-1 text-xs leading-5 text-muted-foreground">{error}</p>}
   <p className="mt-1 text-xs leading-5 text-muted-foreground">Nothing was bought — your {currency} is still in {accountName}.</p>
  </div>
  <div className="mt-auto space-y-2 pt-8">
   <Button className="h-11 w-full rounded-full" disabled={busy} onClick={onRetry}>{busy?busyLabel:'Retry investment'}</Button>
   <button type="button" disabled={busy} onClick={onDismiss} className="w-full rounded-md py-2 text-xs text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Dismiss</button>
  </div>
 </div>;
}
