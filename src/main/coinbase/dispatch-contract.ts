import {z} from 'zod';
import {decimalSchema,amount,productSchema,type Candidate} from './order-planner';
export const providerRef=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const submitSchema=z.object({orderType:z.enum(['market','limit']).optional(),product:z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/),side:z.enum(['buy','sell']),baseSize:decimalSchema.refine(v=>amount(v)>0n),limitPrice:decimalSchema.refine(v=>amount(v)>0n),notional:decimalSchema,clientRef:z.uuid(),previewId:providerRef}).strict();
export type CoinbaseSubmission=z.infer<typeof submitSchema>;
export function validateSubmissionProduct(order:Candidate,raw:unknown){
 const p=productSchema.parse(raw),[base,quote]=order.product.split('-'),size=amount(order.baseSize),price=amount(order.limitPrice),notional=amount(order.notional);
 const marketBuy=order.orderType==='market'&&order.side==='buy';
 if((order.orderType==='market'&&p.limit_only)||p.product_id!==order.product||p.base_currency_id!==base||p.quote_currency_id!==quote||(!marketBuy&&(size%amount(p.base_increment)||size<amount(p.base_min_size)||size>amount(p.base_max_size)))||(order.orderType!=='market'&&price%amount(p.price_increment))||(marketBuy&&notional%amount(p.quote_increment))||notional<amount(p.quote_min_size)||notional>amount(p.quote_max_size))throw new Error('Coinbase product rules changed. Cancel the reservation and preview again.');
}
export function parseSubmission(raw:unknown,request:CoinbaseSubmission):{state:'accepted';providerRef:string}|{state:'rejected'}{
 const accepted=z.object({success:z.literal(true),success_response:z.object({order_id:providerRef,product_id:z.literal(request.product),side:z.literal(request.side.toUpperCase()),client_order_id:z.literal(request.clientRef)})}).safeParse(raw);
 if(accepted.success)return {state:'accepted',providerRef:accepted.data.success_response.order_id};
 // Unknown, duplicate-client-ID and unfamiliar failures may describe an existing order.
 const rejected=z.object({success:z.literal(false),error_response:z.object({error:z.enum(['INSUFFICIENT_FUND','PREVIEW_INSUFFICIENT_FUND','INVALID_LIMIT_PRICE','INVALID_BASE_SIZE','INVALID_QUOTE_SIZE','MINIMUM_NOTIONAL'])}),success_response:z.object({order_id:z.string().optional()}).optional()}).safeParse(raw);
 if(rejected.success&&!rejected.data.success_response?.order_id)return {state:'rejected'};
 throw new Error('Uncertain Coinbase submission result');
}

/** Absent orderType is a persisted legacy limit review; never silently convert it. */
export function orderConfiguration(order:Candidate){
 return order.orderType==='market'
  ?{market_market_ioc:order.side==='buy'?{quote_size:order.notional}:{base_size:order.baseSize}}
  :{limit_limit_gtc:{base_size:order.baseSize,limit_price:order.limitPrice,post_only:false}};
}
