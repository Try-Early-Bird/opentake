import {useEffect,useState} from 'react';
import {money} from '../portfolio/format';
import type {CoinbaseOrderReview} from '../../../shared/coinbase-orders';
import {Button} from '../components/ui/button';
import {createPreviewQueue} from './preview-queue';
const queue=createPreviewQueue();
export function availableCashPurchase(review:CoinbaseOrderReview|null,now=Date.now()){
 if(!review||review.state!=='preview'||Date.parse(review.expiresAt)<=now||!review.orders.length||review.orders.some(o=>o.side!=='buy'))return null;
 const total=review.orders.reduce((sum,o)=>sum+Number(o.notional)+Number(o.fee),0);
 return Number.isFinite(total)&&total>0?total:null;
}
export function InvestAvailableCash({takeId,quote,disabled,onInvest}:{takeId:string;quote:'USD'|'USDC';disabled:boolean;onInvest:()=>void}){
 const [review,setReview]=useState<CoinbaseOrderReview|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{
  if(disabled)return;
  let active=true;let expiry:ReturnType<typeof setTimeout>|undefined;
  setReview(null);setError('');
  void queue(()=>window.strategies.previewCoinbaseOrders({takeId,quote,purchaseOnly:true}),()=>active).then(result=>{
   if(!active||!result)return;
   if(availableCashPurchase(result)===null){setError('No purchase available with this cash.');return;}
   setReview(result);expiry=setTimeout(()=>{setReview(null);setError('Preview expired. Check available cash again.');},Math.max(0,Date.parse(result.expiresAt)-Date.now()));
  }).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not check available cash.');});
  return()=>{active=false;if(expiry)clearTimeout(expiry);};
 },[takeId,quote,revision,disabled]);
 const total=availableCashPurchase(review);
 return <div className="space-y-2 text-xs">
  <Button className="w-full" disabled={disabled||total===null} onClick={()=>{if(!disabled&&availableCashPurchase(review)!==null)onInvest();}}>
   Invest available cash{total!==null?` · ${money(total)}`:''}
  </Button>
  {!error.includes('below Coinbase minimum')&&<p role="status" className="text-muted-foreground">{error||(total===null?'Checking available cash and fees…':`Uses cash already in this Take, including estimated fees. No new deposit.`)}</p>}
  {error&&<button type="button" disabled={disabled} className="underline underline-offset-4" onClick={()=>setRevision(n=>n+1)}>Check again</button>}
 </div>;
}
