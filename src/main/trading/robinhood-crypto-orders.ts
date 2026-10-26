import {z} from 'zod';
import {cryptoDecimal} from '../orders/crypto-preview-contract';
import {cryptoReadPages} from './robinhood-crypto-preview';
import {marketKey} from '../../shared/search';
import type {NormalizedRobinhoodOrder} from '../account-sync/order-normalization';
const rowSchema=z.object({id:z.string().min(1),currency_pair_id:z.string().min(1),ref_id:z.string().optional(),
 side:z.enum(['buy','sell']),type:z.string(),state:z.enum(['new','queued','unconfirmed','confirmed','partially_filled','filled','canceled','rejected','failed','voided']),
 time_in_force:z.string(),quantity:cryptoDecimal.nullable(),cumulative_quantity:cryptoDecimal,
 created_at:z.iso.datetime({offset:true}),updated_at:z.iso.datetime({offset:true}),average_price:cryptoDecimal.nullable().optional(),limit_price:cryptoDecimal.nullable().optional()});
type Read=(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
/** Discover all open orders, recent transitions, and re-read previously open
 * orders missing from that window. No execution attribution or order writes. */
export async function robinhoodCryptoOrders(read:Read,account:{rhsAccountNumber:string;cryptoAccountNumber:string},since:string,knownOpen:readonly string[],signal:AbortSignal):Promise<NormalizedRobinhoodOrder[]>{
 z.iso.datetime().parse(since);
 const boundRead:Read=async(name,args,s)=>{
  const raw=await read(name,args,s);
  const echo=z.object({data:z.object({rhs_account_number:z.string(),crypto_account_number:z.string().optional()})}).parse(raw).data;
  if(echo.rhs_account_number!==account.rhsAccountNumber||(echo.crypto_account_number!==undefined&&echo.crypto_account_number!==account.cryptoAccountNumber))throw Error('Crypto order account mismatch');
  return raw;
 };
 const rows=new Map<string,z.infer<typeof rowSchema>>();
 async function collect(filter:Record<string,unknown>,expected?:string){
  const raw=await cryptoReadPages(boundRead,'get_crypto_orders',{rhs_account_number:account.rhsAccountNumber,...filter},signal);
  const parsed=raw.map(value=>rowSchema.parse(value));
  if(expected&&(parsed.length!==1||parsed[0]!.id!==expected))throw Error('Missing open crypto order evidence');
  const ids=new Set<string>();
  for(const value of parsed){
   if(ids.has(value.id))throw Error('Duplicate crypto order evidence');ids.add(value.id);
   const old=rows.get(value.id);
   if(old&&(old.currency_pair_id!==value.currency_pair_id||old.side!==value.side))throw Error('Changed crypto order identity');
   if(!old||Date.parse(value.updated_at)>Date.parse(old.updated_at))rows.set(value.id,value);
   else if(value.updated_at===old.updated_at&&JSON.stringify(value)!==JSON.stringify(old))throw Error('Conflicting crypto order evidence');
  }
 }
 await collect({state_group:'open'});
 await collect({updated_at_gte:since});
 if(knownOpen.length>500)throw Error('Open crypto order limit');
 for(const id of knownOpen)if(!rows.has(id))await collect({order_id:id},id);
 if(!rows.size)return [];
 const pairs=new Map<string,string>();
 const catalog=await cryptoReadPages(read,'get_currency_pairs',{limit:700},signal);
 for(const raw of catalog){const p=z.object({id:z.string(),symbol:z.string().min(1)}).parse(raw);if(pairs.has(p.id))throw Error('Duplicate crypto pair');pairs.set(p.id,p.symbol);}
 return [...rows.values()].map(row=>{
  const symbol=pairs.get(row.currency_pair_id);if(!symbol)throw Error('Missing crypto order pair');
  return {providerOrderRef:row.id,clientRef:row.ref_id??null,instrumentRef:marketKey({identity:{venue:'robinhood',instance:'production',kind:'crypto',reference:row.currency_pair_id}}),symbol,
   origin:'unknown',side:row.side,orderType:row.type,timeInForce:row.time_in_force,state:row.state,quantity:row.quantity,notionalAmount:null,
   cumulativeQuantity:row.cumulative_quantity,averagePrice:row.average_price??null,limitPrice:row.limit_price??null,stopPrice:null,
   sourceCreatedAt:row.created_at,sourceUpdatedAt:row.updated_at,executions:[],providerPayload:{}};
 });
}
