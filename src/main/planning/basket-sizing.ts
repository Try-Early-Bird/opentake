import {decimalToScaledInteger as amount,scaledIntegerToDecimal as format} from '../allocations/decimal';
import {conserveRequestedNotionals,contributionIntendedNotional,sizeTargetAllocation,type TargetSizingDecision,type TargetSizingInput} from './target-sizing';
export interface SizingPolicy {quantityIncrement:string;minimumOrderNotionalUsd:string;maximumOrderNotionalUsd?:string;maximumBuyDebit?:(notional:string)=>string}
type Order=Extract<TargetSizingDecision,{disposition:'order'}>['order'];
/** Largest cent-denominated buy whose full reservation fits cash. The same
 * debit function must be used by the order writer; no independent fee estimate. */
export function affordableBuy(cash:string,debit:(notional:string)=>string):string{
 const cent=amount('0.01');let low=0n,high=amount(cash)/cent;
 while(low<high){const mid=(low+high+1n)/2n;if(amount(debit(format(mid*cent)))<=amount(cash))low=mid;else high=mid-1n;}
 return format(low*cent);
}
/** Shared sell-first sizing. Keys are opaque instrument identities, not tickers. */
export function sizeTargetBasket(input:{legs:TargetSizingInput[];policies:ReadonlyMap<string,SizingPolicy>;cashUsd:string;firstPurchase:boolean;buysOnly:boolean;sellProceedsHaircutBps:number;conserve?:{allocationValueUsd:string;cashPercent:number}}){
 let cash=amount(input.cashUsd);
 const orders:Order[]=[],decisions:Record<string,TargetSizingDecision>={};
 // Scale a first purchase together so early legs cannot consume later legs' reserve.
 // Keep a cent per buy for each provider's rounding, then solve the common scale.
 let scale=1000000n;
 if(input.firstPurchase&&input.legs.some(l=>input.policies.get(l.symbol)?.maximumBuyDebit)){
  const cost=(factor:bigint)=>input.legs.reduce((sum,leg)=>{
   const desired=amount(leg.allocationValueUsd)*BigInt(Math.round(leg.targetWeightPercent*100))/10000n*factor/1000000n;
   const cent=amount('0.01'),dollars=format((desired+cent-1n)/cent*cent);
   return sum+(desired===0n?0n:amount(input.policies.get(leg.symbol)?.maximumBuyDebit?.(dollars)??dollars));
  },0n);
  let low=0n,high=scale;while(low<high){const mid=(low+high+1n)/2n;if(cost(mid)<=cash)low=mid;else high=mid-1n;}scale=low;
 }
 for(const side of ['sell','buy'] as const){
  if(input.buysOnly&&side==='sell')continue;
  for(const leg of input.legs){
   const policy=input.policies.get(leg.symbol),available=format(cash<0n?0n:cash);
   const max=policy?.maximumOrderNotionalUsd;
   const decision=sizeTargetAllocation({...leg,
    allocationValueUsd:input.firstPurchase?format(amount(leg.allocationValueUsd)*scale/1000000n):leg.allocationValueUsd,
    availableCashUsd:policy?.maximumBuyDebit?affordableBuy(available,policy.maximumBuyDebit):available,
    quantityIncrement:policy?.quantityIncrement??leg.quantityIncrement,
    minimumOrderNotionalUsd:policy?.minimumOrderNotionalUsd??leg.minimumOrderNotionalUsd,
    maximumOrderNotionalUsd:max&&amount(max)<amount(leg.maximumOrderNotionalUsd)?max:leg.maximumOrderNotionalUsd,
    capBuyToCash:!input.firstPurchase});
   const direction=decision.disposition==='order'?decision.order.side:amount(decision.targetValueUsd)>=amount(decision.currentValueUsd)?'buy':'sell';
   if(direction!==side){if(input.buysOnly&&direction==='sell')decisions[leg.symbol]={...decision,disposition:'skip',reason:'within_rebalance_threshold'};continue;}
   decisions[leg.symbol]=decision;
   if(decision.disposition==='defer'){
    if(decision.reason==='insufficient_allocation_cash'&&!input.firstPurchase){decisions[leg.symbol]={...decision,disposition:'skip'};continue;}
    return {orders:[] as Order[],decisions,deferred:decision.reason};
   }
   if(decision.disposition==='order'){
    if(side==='buy'&&decision.order.side==='buy')cash-=amount(policy?.maximumBuyDebit?.(decision.order.dollarAmount)??decision.order.dollarAmount);
    else cash+=amount(decision.deltaValueUsd)*BigInt(10000-input.sellProceedsHaircutBps)/10000n;
    orders.push(decision.order);
   }
  }
 }
 if(input.conserve&&orders.length){
  const value=amount(input.conserve.allocationValueUsd);
  const intended=input.firstPurchase?format(input.legs.reduce((sum,l)=>sum+value*BigInt(Math.round(l.targetWeightPercent*100))/10000n,0n))
   :input.buysOnly?contributionIntendedNotional({cashUsd:input.cashUsd,keptCashUsd:format(value*BigInt(Math.round(input.conserve.cashPercent*100))/10000n),buyShortfallsUsd:orders.filter(o=>o.side==='buy').map(o=>decisions[o.symbol].deltaValueUsd)}):null;
  if(intended!==null){
   const conserved=new Map(conserveRequestedNotionals(orders.flatMap(o=>o.side==='buy'?[{symbol:o.symbol,dollarAmount:o.dollarAmount}]:[]),intended,input.cashUsd).map(o=>[o.symbol,o.dollarAmount]));
   for(const order of orders)if(order.side==='buy')order.dollarAmount=conserved.get(order.symbol)??order.dollarAmount;
  }
 }
 return {orders,decisions,deferred:null};
}
