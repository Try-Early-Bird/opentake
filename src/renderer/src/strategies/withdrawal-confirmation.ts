import type {CoinbaseOrderReview} from '../../../shared/coinbase-orders';
/** Compare economic terms, excluding expiring provider tokens and review IDs. */
function terms(review:CoinbaseOrderReview){return JSON.stringify({
 takeId:review.takeId,quote:review.quote,withdrawal:review.withdrawal,closeCash:review.closeCash,
 orders:review.orders.map(({product,side,baseSize,limitPrice,notional,fee,debits})=>({product,side,baseSize,limitPrice,notional,fee,debits})),
});}
/** Only an expired, unconfirmed review is refreshed. Submission is never retried here. */
export async function confirmWithdrawalReview(review:CoinbaseOrderReview,api:{
 refresh:()=>Promise<CoinbaseOrderReview>;confirm:(id:string)=>Promise<CoinbaseOrderReview>;onRefresh:(review:CoinbaseOrderReview)=>void;
},now=Date.now):Promise<{review:CoinbaseOrderReview;confirmation:CoinbaseOrderReview|null}>{
 const renew=async()=>{const next=await api.refresh();api.onRefresh(next);return next;};
 if(review.state==='expired'||Date.parse(review.expiresAt)<=now()+1000){
  const next=await renew();
  if(terms(next)!==terms(review))return {review:next,confirmation:null};
  return {review:next,confirmation:await api.confirm(next.id)};
 }
 try{return {review,confirmation:await api.confirm(review.id)};}
 catch(error){
  if(!(error instanceof Error)||!/^Review expired\./i.test(error.message))throw error;
  const next=await renew();
  if(terms(next)!==terms(review))return {review:next,confirmation:null};
  return {review:next,confirmation:await api.confirm(next.id)};
 }
}
