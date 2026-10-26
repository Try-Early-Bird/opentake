import type {CoinbaseOrderReview} from '../../../shared/coinbase-orders';
import type {StrategyInstruction} from './InstructionCard';

/** Adapt provider evidence to the same instruction cards as equity investments. */
export function coinbaseInstruction(review:CoinbaseOrderReview,amount:string|null,needsConfirmation=false,cancelling=false):StrategyInstruction {
 const states=review.orders.map(o=>o.execution?.state);
 const cancellation=cancelling||review.orders.some(o=>['requested','sending','unknown'].includes(o.execution?.cancelState??''));
 const unresolved=states.some(s=>s==='unknown'||s==='reconciliation_required');
 const sent=states.some(s=>s!==undefined&&!['reserved','reviewed'].includes(s));
 const terminal=!unresolved&&(review.state==='settled'||review.state==='cancelled');
 const allFilled=states.length>0&&states.every(s=>s==='filled');
 const anyFilled=states.some(s=>s==='filled'||s==='partially_filled')||review.orders.some(o=>o.filledQuantity!==undefined&&Number(o.filledQuantity)>0);
 const status=terminal?(review.closed||allFilled||anyFilled?'settled':states.some(s=>s==='rejected')?'failed':'cancelled'):'open';
 return {accountLabel:review.accountLabel,venue:'Coinbase',id:review.id,kind:review.rebalance?'rebalance':review.withdrawal?.close?'full_exit':review.withdrawal?'partial_redemption':'subscription',requestedAmount:review.withdrawal?.requestedAmount??amount,status,
  pendingReason:terminal&&anyFilled&&!allFilled?'partial_completion':null,
  waitingFor:terminal?null:unresolved?'reconciliation_required':cancellation?'cancellation_pending':sent?'orders_pending':needsConfirmation||review.state==='preview'?'awaiting_confirmation':review.withdrawal&&review.state==='confirmed'&&states.length>0&&states.every(s=>s==='reserved')?'retry_required':'requested',
  symbols:review.orders.map(o=>o.product.split('-')[0]),expectedAt:null,
  cancellable:!terminal&&!cancellation&&!unresolved,
  orders:review.orders.map(o=>({symbol:o.product.split('-')[0],side:o.side,orderType:o.orderType??'limit',quantity:o.baseSize,estimatedValue:o.notional,estimatedPrice:o.limitPrice,estimatedFee:o.fee,currency:review.quote,filledQuantity:o.filledQuantity,execution:o.execution??{state:'reviewed',cancelState:'none'}})),
  previewLegs:review.orders.map(o=>({symbol:o.product.split('-')[0],notional:o.notional}))};
}
