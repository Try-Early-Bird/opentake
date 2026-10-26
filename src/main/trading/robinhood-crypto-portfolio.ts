import type {CryptoPriceSample} from '../assets/crypto-price-history';
import {z} from 'zod';
import {cryptoReadPages,cryptoPairSchema} from './robinhood-crypto-preview';
import {cryptoDecimal} from '../orders/crypto-preview-contract';
import {amount,format} from '../allocations/ledger';
import {marketKey} from '../../shared/search';
import type {NormalizedRobinhoodPosition} from '../account-sync/snapshot-normalization';
const position=z.object({currency_pair_id:z.string().min(1),currency:z.object({code:z.string(),type:z.literal('cryptocurrency')}),quantity:cryptoDecimal,quantity_transferable:cryptoDecimal,quantity_held_for_sell:cryptoDecimal});
const pair=z.object({id:z.string(),symbol:z.string().regex(/^[A-Z0-9._]+-USD$/)});
const quote=z.object({id:z.string(),symbol:z.string(),mark_price:cryptoDecimal,bid_price:cryptoDecimal,ask_price:cryptoDecimal,updated_at:z.string(),open_price:cryptoDecimal.optional(),routing:z.string().optional()});
type Read=(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
/** Complete account-scoped positions plus quotes for held and planned pairs.
 * Zero-quantity quote rows value planned targets without fabricating holdings. */
export async function robinhoodCryptoPortfolio(read:Read,rhsAccountNumber:string,targets:readonly string[],signal:AbortSignal,now?:number,onQuotes?:(samples:CryptoPriceSample[])=>Promise<void>):Promise<NormalizedRobinhoodPosition[]>{
 const holdings=(await cryptoReadPages(read,'get_crypto_positions',{rhs_account_number:rhsAccountNumber},signal)).map(row=>position.parse(row));
 const wanted=new Set([...targets,...holdings.map(row=>row.currency_pair_id)]);
 if(wanted.size===0)return [];
 if(wanted.size>700)throw Error('Too many crypto portfolio pairs');
 if(new Set(holdings.map(row=>row.currency_pair_id)).size!==holdings.length)throw Error('Duplicate crypto position identity');
 const rawCatalog=(await cryptoReadPages(read,'get_currency_pairs',{limit:700},signal)).filter((row:any)=>wanted.has(row?.id));
 const catalog=rawCatalog.map(row=>pair.parse(row));
 const sizing=new Map(rawCatalog.flatMap(row=>{const parsed=cryptoPairSchema.safeParse(row);return parsed.success?[[parsed.data.id,parsed.data] as const]:[];}));
 if(catalog.length!==wanted.size||new Set(catalog.map(p=>p.id)).size!==wanted.size||new Set(catalog.map(p=>p.symbol)).size!==wanted.size)throw Error('Ambiguous crypto portfolio identity');
 const quotes=new Map<string,z.infer<typeof quote>>();
 for(let i=0;i<catalog.length;i+=10){
  const slice=catalog.slice(i,i+10),rows=z.object({data:z.object({results:z.array(quote).nullable()})}).parse(await read('get_crypto_quotes',{symbols:slice.map(p=>p.symbol),rhs_account_number:rhsAccountNumber},signal)).data.results??[];
  for(const row of rows){if(quotes.has(row.id)||!slice.some(p=>p.id===row.id&&p.symbol.replace('-','')===row.symbol))throw Error('Crypto quote identity mismatch');quotes.set(row.id,row);}
 }
 // Evaluate freshness after the reads: a quote refreshed during the request
 // is not a future quote merely because it is newer than the request start.
 const observedAt=now??Date.now();
 const samples:CryptoPriceSample[]=[];
 const positions:NormalizedRobinhoodPosition[]=catalog.map(p=>{
  const held=holdings.find(h=>h.currency_pair_id===p.id),q=quotes.get(p.id),stamp=Date.parse(q?.updated_at??'');
  if(held&&(p.symbol!==held.currency.code+'-USD'||amount(held.quantity_transferable)>amount(held.quantity)))throw Error('Crypto holding identity or units mismatch');
  const quantity=held?.quantity??'0',valid=q&&Number.isFinite(stamp)&&stamp<=observedAt&&observedAt-stamp<=60000&&amount(q.mark_price)>0n&&amount(q.bid_price)>0n&&amount(q.ask_price)>0n;
  if(valid)samples.push({pairId:p.id,symbol:p.symbol,routing:q.routing??null,observedAt:new Date(stamp).toISOString(),mark:q.mark_price,previousClose:q.open_price??null});
  const mark=valid?q.mark_price:null,ref=marketKey({identity:{venue:'robinhood',instance:'production',kind:'crypto',reference:p.id}});
  return {positionKey:ref,instrumentRef:ref,symbol:p.symbol,side:amount(quantity)>0n?'long':'flat',quantity,displayQuantity:null,quantityMultiplier:'1',contractMultiplier:'1',averageCost:null,costBasis:null,heldQuantity:held?.quantity_held_for_sell??'0',markPrice:mark,marketValue:mark?format(amount(quantity)*amount(mark)/10n**18n):null,providerUnrealizedPnl:null,providerRealizedPnl:null,currency:'USD',priceObservedAt:valid?new Date(stamp).toISOString():null,providerPayload:sizing.has(p.id)?{cryptoSizing:{quantityIncrement:sizing.get(p.id)!.min_order_quantity_increment,minimumQuantity:sizing.get(p.id)!.min_order_size,maximumQuantity:sizing.get(p.id)!.max_order_size,minimumNotional:sizing.get(p.id)!.min_order_quote_amount??null}}:{}};
 });
 signal.throwIfAborted();
 if(onQuotes)await onQuotes(samples);
 return positions;
}
