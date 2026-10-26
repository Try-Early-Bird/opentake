import type {OrderStatus,TradingAPI} from './trading';
// The order writer's surface. Trading is on unless the background
// host starts with OPENTAKE_TRADING=0 (the off switch); every call refuses then.

export interface EquityOrderRequest {
 symbol:string;side:'buy'|'sell';type:'market'|'limit';
 quantity?:string;dollar_amount?:string;limit_price?:string;
 time_in_force?:'gfd'|'gtc';market_hours?:'regular_hours'|'extended_hours'|'all_day_hours';
 tax_lots?:{open_lot_id:string;quantity:string}[];
}

export interface OrderIntentView {
 execution:OrderStatus;
 id:string;accountId:string;allocationId:string|null;transactionId:string|null;
 status:'reviewed'|'expired'|'placing'|'placed'|'rejected'|'placement_unknown'|'abandoned';
 refId:string;orderRequest:EquityOrderRequest;providerOrderRef:string|null;errorCode:string|null;
 reviewedAt:string;expiresAt:string;placedAt:string|null;
}

export interface OrdersAPI extends TradingAPI {
 /** False only when the background host was started with the off switch. */
 status():Promise<{enabled:boolean}>;
 list():Promise<OrderIntentView[]>;
 /** A fresh Robinhood review, valid two minutes; nothing is placed. */
 review(order:EquityOrderRequest):Promise<{intent:OrderIntentView;review:unknown}>;
 /** Places a reviewed order once; an unknown outcome is never resent. */
 confirm(intentId:string):Promise<OrderIntentView>;
 /** You checked Robinhood: an order of unknown outcome is not there. Still matched if it appears later. */
 abandon(intentId:string):Promise<OrderIntentView>;
}
