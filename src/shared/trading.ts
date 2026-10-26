/** Broker-independent execution vocabulary. Provider states remain evidence, not app policy. */
export type TradingVenue='robinhood'|'coinbase';
export type OrderState='reviewed'|'reserved'|'submitting'|'accepted'|'partially_filled'|'filled'|'cancelled'|'expired'|'rejected'|'unknown'|'reconciliation_required';
export type CancellationState='none'|'sending'|'requested'|'unknown'|'rejected';
export interface OrderStatus {state:OrderState;cancelState:CancellationState}
export type EligibilityCode='trading_disabled'|'review_expired'|'incomplete_basket'|'symbol_blocked'|'daily_notional_limit'|'loss_limit_reached'|'eligibility_unknown'|'symbol_not_tradable'|'symbol_not_fractional'|'product_restricted';
export interface EligibilityResult {ok:boolean;reasons:{code:EligibilityCode;symbols:string[]}[]}
/** Acceptance never proves execution; terminal provider evidence still needs fill reconciliation. */
export function normalizeOrderState(state:string):OrderState {
 switch(state.toLowerCase()){
  case 'preview':case 'reviewed':return 'reviewed';
  case 'prepared':case 'reserved':return 'reserved';
  case 'placing':case 'submitting':case 'sending':return 'submitting';
  case 'placed':case 'bound':case 'accepted':case 'open':case 'pending':case 'queued':return 'accepted';
  case 'partially_filled':case 'partially-filled':return 'partially_filled';
  case 'filled':return 'filled';
  case 'canceled':case 'cancelled':return 'cancelled';
  case 'expired':return 'expired';
  case 'rejected':case 'failed':return 'rejected';
  case 'reconciliation_required':return 'reconciliation_required';
  default:return 'unknown';
 }
}

import type {CoinbaseOrderReview} from './coinbase-orders';
import type {EquityOrderRequest,OrderIntentView} from './orders';
export type TradingRequest=
 |{venue:'coinbase';action:'review';input:{takeId:string;quote:'USD'|'USDC'}}
 |{venue:'robinhood';action:'review';input:EquityOrderRequest}
 |{venue:TradingVenue;action:'current'|'reserve'|'submit'|'refresh'|'cancel';input:string};
export type TradingResponse=
 |{venue:'coinbase';review:CoinbaseOrderReview|null}
 |{venue:'robinhood';intent:OrderIntentView;preview:unknown};
/** One application boundary; capabilities and provider request shapes remain explicit. */
export interface TradingAPI {execute(request:TradingRequest):Promise<TradingResponse>}

/** Some brokers keep an order open while reporting a nonzero cumulative fill. */
export function observedOrderState(state:string,filledQuantity?:string|null):OrderState {
 const normalized=normalizeOrderState(state);
 return normalized==='accepted'&&filledQuantity&&/^(0|[1-9]\d*)(\.\d+)?$/.test(filledQuantity)&&/[1-9]/.test(filledQuantity)?'partially_filled':normalized;
}
