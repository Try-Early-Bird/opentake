import {assertEligible,basketEligibility,evaluateEligibility} from '../trading/eligibility';
import { z } from 'zod';
import { decimalToScaledInteger, scaledIntegerToDecimal } from '../allocations/decimal';
import { assertInstrumentExecution,type BasketSpec } from '../../shared/strategies';
import type { CurrencyClaim } from './currency-accounting';
export const decimalSchema=z.string().regex(/^(0|[1-9]\d{0,39})(\.\d{1,36})?$/);
export const amount=(value:string)=>decimalToScaledInteger(decimalSchema.parse(value),36);
export const format=(value:bigint)=>scaledIntegerToDecimal(value,36);
const one=10n**36n,positive=decimalSchema.refine(v=>amount(v)>0n);
export const productSchema=z.object({product_id:z.string(),base_currency_id:z.string(),quote_currency_id:z.string(),product_type:z.literal('SPOT'),
 price:positive,base_increment:positive,quote_increment:positive,price_increment:positive,
 base_min_size:positive,base_max_size:positive,quote_min_size:positive,quote_max_size:positive,
 limit_only:z.boolean().optional(),is_disabled:z.boolean(),trading_disabled:z.boolean(),cancel_only:z.boolean(),post_only:z.boolean(),auction_mode:z.boolean(),view_only:z.boolean(),status:z.string()}).superRefine((product,ctx)=>{
 const decision=evaluateEligibility([
  {code:'product_restricted',symbols:[product.product_id],satisfied:product.status.toLowerCase()==='online'},
  ...[product.is_disabled,product.trading_disabled,product.cancel_only,product.post_only,product.auction_mode,product.view_only].map(flag=>({code:'product_restricted' as const,symbols:[product.product_id],satisfied:!flag})),
 ]);
 if(!decision.ok)ctx.addIssue({code:'custom',message:'Coinbase product is restricted or offline.'});
});
export type Product=z.infer<typeof productSchema>;
export interface Candidate {orderType?:'market'|'limit';product:string;side:'buy'|'sell';baseSize:string;limitPrice:string;notional:string}
const down=(n:bigint,step:bigint)=>n/step*step;
const up=(n:bigint,step:bigint)=>(n+step-1n)/step*step;
/** Cash-sized buys and base-sized sells at market. No implicit quote conversion or spending expected sale proceeds. */
export function planCoinbaseOrders(spec:BasketSpec,quote:string,claims:CurrencyClaim[],products:Product[],feeBudget='0',buyOnly=false) {
 assertInstrumentExecution(spec);
 const weights=spec.target.weights.filter(w=>w.instrument.venue==='coinbase');
 if(!weights.length||weights.length>20||new Set(weights.map(w=>w.instrument.symbol)).size!==weights.length)throw new Error('A unique Coinbase basket of up to 20 assets is required.');
 if(claims.some(c=>amount(c.reserved)>0n))throw new Error('Cancel or finish the existing order reservation first.');
 const balances=new Map(claims.map(c=>[c.asset,amount(c.quantity)]));
 if([...balances].some(([asset,quantity])=>quantity>0n&&['USD','USDC'].includes(asset)&&asset!==quote))throw new Error('This allocation contains another cash currency. Release it first; currencies are not converted.');
 const symbols=[...new Set([...weights.map(w=>w.instrument.symbol),...claims.filter(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n).map(c=>c.asset)])];
 const market=new Map(products.map(p=>[p.base_currency_id,productSchema.parse(p)]));
 let total=balances.get(quote)??0n;
 for(const symbol of symbols){const p=market.get(symbol);if(!p||p.product_id!==`${symbol}-${quote}`||p.quote_currency_id!==quote)throw new Error(`Exact ${symbol}-${quote} market required.`);total+=(balances.get(symbol)??0n)*amount(p.price)/one;}
 const fees=amount(feeBudget);if(fees>total)throw new Error('Fees exceed the allocation.');
 const investable=(total-fees)*BigInt(10000-spec.target.cashBps)/10000n;
 const sum=weights.reduce((n,w)=>n+w.bps,0);if(!sum)throw new Error('Positive target weights required.');
 const orders:Candidate[]=[],skipped:string[]=[];
 for(const symbol of symbols){
  const p=market.get(symbol)!,owned=balances.get(symbol)??0n;
  const target=investable*BigInt(weights.find(w=>w.instrument.symbol===symbol)?.bps??0)/BigInt(sum);
  const targetBase=target*one/amount(p.price),delta=targetBase-owned;if(delta===0n)continue;
  const side=delta>0n?'buy':'sell';if(buyOnly&&side==='sell')continue;
  const price=side==='buy'?down(amount(p.price),amount(p.price_increment)):up(amount(p.price),amount(p.price_increment));
  if(price<=0n)throw new Error('Invalid product price increment.');
  const base=down(delta>0n?delta:-delta,amount(p.base_increment));
  const notional=up((base*price+one-1n)/one,amount(p.quote_increment));
  if(base<amount(p.base_min_size)||notional<amount(p.quote_min_size)){skipped.push(`${symbol}: below Coinbase minimum`);continue;}
  if(base>amount(p.base_max_size)||notional>amount(p.quote_max_size))throw new Error(`${symbol}: exceeds Coinbase order maximum.`);
  orders.push({orderType:'market',product:p.product_id,side,baseSize:format(base),limitPrice:format(price),notional:format(notional)});
 }
 const firstPurchase=!claims.some(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n);
 // A below-minimum sell may leave buys slightly above available cash. Size
 // purchases to spendable cash after fees instead of depending on that sale.
 if(!firstPurchase&&!orders.some(o=>o.side==='sell')){
  const cash=balances.get(quote)??0n,spendable=cash>fees?cash-fees:0n;
  const wanted=orders.reduce((n,o)=>n+amount(o.notional),0n);
  if(wanted>spendable)for(let i=orders.length-1;i>=0;i--){
   const o=orders[i],p=market.get(o.product.split('-')[0])!;
   const budget=down(amount(o.notional)*spendable/wanted,amount(p.quote_increment));
   const base=down(budget*one/amount(o.limitPrice),amount(p.base_increment));
   const notional=up((base*amount(o.limitPrice)+one-1n)/one,amount(p.quote_increment));
   if(base<amount(p.base_min_size)||notional<amount(p.quote_min_size)){skipped.push(`${p.base_currency_id}: below Coinbase minimum`);orders.splice(i,1);}
   else {o.baseSize=format(base);o.notional=format(notional);}
  }
 }
 assertEligible(basketEligibility(firstPurchase,weights.map(w=>w.instrument.symbol),orders.filter(o=>o.side==='buy').map(o=>o.product.split('-')[0])),'The first purchase must include every asset. Increase the allocation to meet Coinbase minimums.');
 const phase=orders.some(o=>o.side==='sell')?'sell':'buy';
 return {phase,orders:orders.filter(o=>o.side===phase),skipped,value:format(total),cash:format(balances.get(quote)??0n)} as const;
}
export const previewResultSchema=z.object({preview_id:z.string().min(1).max(500),commission_total:decimalSchema,errs:z.array(z.string()).max(0),warning:z.array(z.string()).max(0).optional()});
