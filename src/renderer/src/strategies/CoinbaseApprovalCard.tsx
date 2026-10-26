import {RefreshCw} from 'lucide-react';
import type {CoinbaseOrderReview} from '../../../shared/coinbase-orders';
import {Button} from '../components/ui/button';
import {CoinbaseQuoteDetails} from './CoinbaseQuoteDetails';

export function CoinbaseApprovalCard({review,busy,onConfirm,onCancel,onRefresh}:{review:CoinbaseOrderReview;busy:boolean;onConfirm:()=>void;onCancel:()=>void;onRefresh:()=>void}){
 const count=review.orders.length;
 return <section aria-label="Review orders" className="mt-3 overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
  <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
   <div><h3 className="text-sm font-medium">{review.rebalance?'Rebalance':'Withdrawal'}</h3><p className="mt-0.5 text-xs text-muted-foreground">{review.accountLabel} · {count} {count===1?'order':'orders'}</p></div>
   <Button variant="ghost" size="icon-sm" aria-label="Refresh status" disabled={busy} onClick={onRefresh}><RefreshCw size={14}/></Button>
  </header>
  <div className="p-4"><CoinbaseQuoteDetails review={review}/>
   <Button className="mt-5 w-full rounded-full" size="lg" disabled={busy||count===0} onClick={onConfirm}>{busy?'Working…':'Confirm'}</Button>
   <Button className="mt-2 w-full rounded-full text-muted-foreground" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
  </div>
 </section>;
}
