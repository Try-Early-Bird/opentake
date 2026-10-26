import {useLogos} from './HoldingLogo';
import {cryptoLogo} from '../crypto-logos';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { useEffect, useState, type ReactNode } from 'react';

import type { StrategyHolding } from '../strategies/holdings';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/app-dialog';

// Taking an investment apart, position by position: each row shows what the
// strategy bought for the member (shares, value, and the P&L on those shares
// from the bucket's own fills) with a Sell checkbox. Whatever is not sold is
// held and becomes the member's own position when the bucket detaches.
// Positions under the one-dollar order minimum cannot be sold at market and
// show as kept. Cash always returns; the summary includes it in the proceeds.

export type SellChoice = 'all' | 'none' | string[];

const MINIMUM_SELL_USD = 1;
export type CloseHolding = Pick<StrategyHolding,'valuation'> & {positions:(StrategyHolding['positions'][number]&{sellable?:boolean})[]};

/** Shared close review for both venues; provider adapters supply prices and sale proceeds. */
export function ClosePositionsTable({holding,selected,onChange,crypto=false,disabled=false,cashRows,headerControl,accountName='your account',estimatedProceeds}:{
 holding:CloseHolding;selected:ReadonlySet<string>;onChange:(next:Set<string>)=>void;
 crypto?:boolean;disabled?:boolean;cashRows?:{asset:string;quantity:string}[];headerControl?:ReactNode;
 accountName?:string;estimatedProceeds?:string|null;
}){
 const logos=useLogos(crypto?[]:holding.positions.map(p=>p.symbol));
 const currency=holding.positions.some(p=>Number(p.quantity)>0)?holding.valuation.currency:(cashRows?.find(c=>c.asset===holding.valuation.currency)?.asset??cashRows?.[0]?.asset??holding.valuation.currency);
 const rows=holding.positions.filter(p=>Number(p.quantity)>0).map(p=>({...p,sellable:p.sellable??(p.value!=null&&Number(p.value)>=MINIMUM_SELL_USD)}));
 const cash=(cashRows??[{asset:currency,quantity:holding.valuation.cash}]).filter(c=>Number(c.quantity)>0);
 const selling=rows.filter(p=>selected.has(p.symbol));
 const kept=rows.filter(p=>!selected.has(p.symbol));
 const sum=(positions:typeof rows)=>positions.every(p=>p.value!=null)?positions.reduce((n,p)=>n+Number(p.value),0):null;
 const sales=estimatedProceeds===undefined?sum(selling):estimatedProceeds===null?null:Number(estimatedProceeds);
 const returned=sales===null?null:sales+cash.filter(c=>c.asset===currency).reduce((n,c)=>n+Number(c.quantity),0);
 const keptValue=sum(kept);
 const pnl=rows.length&&rows.every(p=>p.unrealized!=null)?rows.reduce((n,p)=>n+Number(p.unrealized),0):null;
 const number=(value:number|null)=>value===null?'—':value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const gain=(value:number|null)=>value===null?'—':`${value>0?'+':''}${number(value)}`;
 const tone=(value:number|null)=>value===null||value===0?'text-muted-foreground':value>0?'text-success':'text-error';
 const toggle=(symbol:string)=>{const next=new Set(selected);if(next.has(symbol))next.delete(symbol);else next.add(symbol);onChange(next);};
 return <div>
  <div className="divide-y divide-border">
   {rows.map(row=>{const logo=crypto?cryptoLogo(row.symbol):logos.get(row.symbol);const unrealized=row.unrealized==null?null:Number(row.unrealized);return <label key={row.symbol} className="flex items-center gap-3 py-3 text-sm">
    <input type="checkbox" aria-label={`Sell ${row.symbol}`} checked={selected.has(row.symbol)} disabled={disabled||!row.sellable} onChange={()=>toggle(row.symbol)} className="size-4 rounded accent-foreground"/>
    {logo?<img src={logo} alt="" className="size-7 rounded-full"/>:<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px]">{row.symbol.slice(0,2)}</span>}
    <span className="min-w-0 flex-1"><span className="block row-title">{row.symbol}</span><span className="block text-[11px] tabular-nums text-muted-foreground">{Number(row.quantity).toLocaleString('en-US',{maximumFractionDigits:crypto?8:6})}{crypto?'':' sh'}{!row.sellable&&' · below minimum, kept'}</span></span>
    <span className="text-right font-mono tabular-nums"><span className="block">{number(row.value==null?null:Number(row.value))}</span><span className={cn('block text-[11px]',tone(unrealized))}>{gain(unrealized)}</span></span>
   </label>;})}
   {cash.map(row=><div key={row.asset} className="flex items-center gap-3 py-3 pl-7 text-sm">
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">$</span>
    <span className="flex-1"><span className="block row-title">{cash.length>1?`Cash · ${row.asset}`:'Cash'}</span><span className="block text-[11px] text-muted-foreground">Returned to {accountName}</span></span>
    <span className="font-mono tabular-nums">{number(Number(row.quantity))}{row.asset!==currency&&<span className="ml-1 text-[10px] text-muted-foreground">{row.asset}</span>}</span>
   </div>)}
  </div>
  <div className="border-y border-border py-4">
   <div className="flex items-baseline justify-between gap-3"><span className="text-xs">Back to {accountName}</span><span className="font-mono text-lg tabular-nums">{selling.length>0?'≈ ':''}{number(returned)} <span className="font-sans text-[10px] text-muted-foreground">{currency}</span></span></div>
   {cash.filter(c=>c.asset!==currency).map(c=><p key={c.asset} className="mt-1 text-right text-xs tabular-nums">+ {number(Number(c.quantity))} {c.asset}</p>)}
   {rows.length>0?<p className="mt-1 text-[11px] text-muted-foreground">Keeping {number(keptValue)} <span className="sr-only">{currency} in assets</span> · P&amp;L <span className={tone(pnl)}>{gain(pnl)}</span></p>:<p className="mt-1 text-[11px] text-muted-foreground">Uninvested cash only. No assets need to be sold.</p>}
  </div>
  {rows.length>0&&headerControl&&<div className="border-b border-border py-3">{headerControl}</div>}
 </div>;
}

/** Which symbols the selection means, in the API's shape. */
export function sellChoiceOf(holding: StrategyHolding, selected: ReadonlySet<string>): SellChoice {
  const sellable = holding.positions.filter((position) => Number(position.quantity) > 0 && position.value != null && Number(position.value) >= MINIMUM_SELL_USD);
  if (selected.size === 0) return 'none';
  if (sellable.every((position) => selected.has(position.symbol))) return 'all';
  return [...selected];
}

export function ClosePositionsDialog({ holding, open, title, description, confirmLabel = 'Close', busy = false, error = null, onClose, onConfirm, accountName='your account' }: {
  holding: StrategyHolding;
  accountName?:string;
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (sell: SellChoice) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Closing means selling unless you uncheck a position (owner decision 2026-10-05;
    // rather than opening with nothing checked, which read "Close and keep all").
    if (open) setSelected(new Set(holding.positions
      .filter((position) => Number(position.quantity) > 0 && position.value != null && Number(position.value) >= MINIMUM_SELL_USD)
      .map((position) => position.symbol)));
  }, [open, holding.bucket.id]);
  const choice = sellChoiceOf(holding, selected);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{holding.positions.some(p=>Number(p.quantity)>0)?description:'Release the uninvested cash from this Take. No assets need to be sold.'}</DialogDescription>
        </DialogHeader>
        <ClosePositionsTable holding={holding} selected={selected} onChange={setSelected} disabled={busy} accountName={accountName} />
        {error !== null && <p className="text-xs text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Keep take</Button>
          <Button size="sm" className="rounded-full px-5" onClick={() => onConfirm(choice)} disabled={busy}>
            {busy ? 'Working…' : !holding.positions.some(p=>Number(p.quantity)>0) ? 'Close and release cash' : choice === 'none' ? 'Keep assets and close' : 'Sell and close'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
