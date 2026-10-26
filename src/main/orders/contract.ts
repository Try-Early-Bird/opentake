import {cryptoPreviewInput} from './crypto-preview-contract';
import {z} from 'zod';

// The only order shape the writer sends, validated before Robinhood sees it.
// Mirrors review_equity_order / place_equity_order: decimal strings, exactly one of quantity or
// dollar_amount, dollar amounts only on market orders, specified lots only on
// sells. Options and stop orders are out of scope for strategies.

const decimal=z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/u);
const cents=z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/u);
export const equityOrderSchema=z.object({
 symbol:z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/u),
 side:z.enum(['buy','sell']),
 type:z.enum(['market','limit']),
 quantity:decimal.optional(),
 dollar_amount:cents.optional(),
 limit_price:decimal.optional(),
 time_in_force:z.enum(['gfd','gtc']).optional(),
 market_hours:z.enum(['regular_hours','extended_hours','all_day_hours']).optional(),
 tax_lots:z.array(z.object({open_lot_id:z.string().min(1).max(128),quantity:decimal}).strict()).min(1).max(30).optional(),
}).strict().superRefine((order,ctx)=>{
 const issue=(message:string)=>ctx.addIssue({code:'custom',message});
 if((order.quantity===undefined)===(order.dollar_amount===undefined))issue('Provide exactly one of quantity or dollar_amount');
 if(order.dollar_amount!==undefined&&order.type!=='market')issue('dollar_amount requires a market order');
 if(order.dollar_amount!==undefined&&Number(order.dollar_amount)<1)issue('Robinhood rejects orders under $1');
 if(order.quantity!==undefined&&!(Number(order.quantity)>0))issue('quantity must be positive');
 if(order.type==='limit'&&order.limit_price===undefined)issue('limit_price is required for a limit order');
 if(order.type==='market'&&order.limit_price!==undefined)issue('A market order takes no limit_price');
 if(order.tax_lots!==undefined&&(order.side!=='sell'||order.dollar_amount!==undefined))issue('tax_lots only apply to a sell by quantity');
});
export type EquityOrder=z.infer<typeof equityOrderSchema>;

/** What Robinhood answered to place_equity_order, before the writer classifies it. */
export interface PlacementResponse {isError:boolean;errorCategory:string|null;data:unknown;errorDetails?:unknown}


interface TakeMarketSizing {side:'buy'|'sell';amount:string}
type EquityTakeMarket=TakeMarketSizing&{assetClass:'equity';symbol:string;tax_lots?:EquityOrder['tax_lots']};
type CryptoTakeMarket=TakeMarketSizing&{assetClass:'crypto';currencyPairId:string};
/** Existing Take policy: spend USD on buys, sell owned units, always at market.
 * Asset adapters validate their own precision and identity; this does not grant
 * eligibility, reserve money/units, or authorize a submission. */
export function takeMarketOrder(input:EquityTakeMarket):ReturnType<typeof equityOrderSchema.safeParse>;
export function takeMarketOrder(input:CryptoTakeMarket):ReturnType<typeof cryptoPreviewInput.safeParse>;
export function takeMarketOrder(input:EquityTakeMarket|CryptoTakeMarket){
 const sizing=input.side==='buy'?{dollar_amount:input.amount}:{quantity:input.amount};
 if(input.assetClass==='crypto')return cryptoPreviewInput.safeParse({currency_pair_id:input.currencyPairId,side:input.side,type:'market',time_in_force:'gtc',...sizing});
 return equityOrderSchema.safeParse({symbol:input.symbol,side:input.side,type:'market',...sizing,...(input.tax_lots?{tax_lots:input.tax_lots}:{})});
}
