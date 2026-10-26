export interface CryptoOrderRequest {currency_pair_id:string;side:'buy';type:'limit';dollar_amount:string;limit_price:string;time_in_force?:'gtc'}
export interface CryptoOrderView {
 id:string;accountId:string;accountLabel:string;symbol:string;status:string;providerState:string|null;approvalPending:boolean;
 statusReason?:string|null;order:CryptoOrderRequest;maximumDebit:string;filledQuantity:string;netCash:string;cashHeld:boolean;expiresAt:string;
}
export type CryptoOrderCommand={action:'status'|'list'}|{action:'review';order:CryptoOrderRequest}|{action:'confirm'|'refresh'|'cancel';id:string};
export interface CryptoOrderResult {enabled:boolean;orders:CryptoOrderView[];cancellation?:'requested'|'rejected'|'unknown'}

export type CryptoOrderReply={ok:true;value:CryptoOrderResult}|{ok:false;message:string};

/** Only application-owned descriptions cross IPC; never raw provider errors. */
export function cryptoOrderStatusReason(status:string, code:unknown):string|null {
 if(status==='rejected') {
  const reasons:Record<string,string>={
   provider_invalid_request_buying_power:'insufficient buying power or available funds',
   provider_invalid_request_account_restricted:'an account restriction',
   provider_invalid_request_region_restricted:'trading is unavailable in your state or region',
   provider_invalid_request_agentic_disabled:'agentic trading is not enabled or allowed',
   provider_invalid_request_crypto_account_missing:'the linked crypto account could not be found',
   provider_invalid_request_minimum_size:'the order is below the minimum trade size',
   provider_invalid_request_price_increment:'the limit price does not meet the required increment',
   provider_invalid_request_quantity_increment:'the coin quantity does not meet the required increment',
   provider_invalid_request_dollar_sizing:'dollar_amount sizing is not supported for this request',
   provider_invalid_request_price_bounds:'the limit price is outside the permitted range',
  };
  if(typeof code==='string'&&Object.hasOwn(reasons,code))return `Robinhood reported: ${reasons[code]}. The submission was rejected. Check Robinhood’s order activity before creating another order.`;

  if(code==='provider_invalid_request')return 'Robinhood rejected the submission as an invalid request. The specific cause has not been verified. Check Robinhood’s order activity before creating another order.';
  if(code==='approval_declined')return 'The approval request was declined in Robinhood.';
  if(code==='approval_expired')return 'The approval request expired in Robinhood.';
  return 'This submission was rejected. A specific reason is unavailable; check Robinhood’s order activity.';
 }
 if(status==='placement_unknown')return 'The submission outcome is not yet verified. Refresh status and check Robinhood before creating another order.';
 return null;
}
