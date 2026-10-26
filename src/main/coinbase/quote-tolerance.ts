import {DEFAULT_QUOTE_CHANGE_TOLERANCE_BPS,type CoinbaseOrderReview} from '../../shared/coinbase-orders';
import {amount} from './order-planner';

// Compare each leg independently: opposite changes must not cancel each other.
export function quoteNeedsReconfirmation(previous:CoinbaseOrderReview,next:CoinbaseOrderReview):boolean{
 const withinUnits=(old:bigint,value:bigint,basis=old)=>{
  const delta=value-old;
  return (delta<0n?-delta:delta)*10000n<=basis*BigInt(DEFAULT_QUOTE_CHANGE_TOLERANCE_BPS);
 };
 const within=(old:string,value:string,basis=old)=>{
  return withinUnits(amount(old),amount(value),amount(basis));
 };
 if(previous.quote!==next.quote||previous.phase!==next.phase||previous.orders.length!==next.orders.length)return true;
 return previous.orders.some((old,index)=>{
  const current=next.orders[index];
  if(old.product!==current.product||old.side!==current.side||(old.orderType??'limit')!==(current.orderType??'limit'))return true;
  // Market buys submit quote_size, so their notional is an actual instruction.
  // Base-sized orders submit base_size; their rounded display notional is only
  // an estimate. Compare quantity × price before quote-increment rounding.
  const quoteSized=old.orderType==='market'&&old.side==='buy';
  const scale=10n**36n;
  const oldValue=quoteSized?amount(old.notional)*scale:amount(old.baseSize)*amount(old.limitPrice);
  const newValue=quoteSized?amount(current.notional)*scale:amount(current.baseSize)*amount(current.limitPrice);
  // Fee change is measured against the order's value, not the old fee: a fee
  // moving from 0.01 to 0.02 is immaterial on a 100 order. Intentional.
  if(!within(old.limitPrice,current.limitPrice)||!within(old.baseSize,current.baseSize)||!withinUnits(oldValue,newValue)||!withinUnits(amount(old.fee)*scale,amount(current.fee)*scale,oldValue))return true;
  if(old.debits.length!==current.debits.length)return true;
  return old.debits.some((debit,i)=>debit.asset!==current.debits[i].asset||!within(debit.quantity,current.debits[i].quantity));
 });
}
