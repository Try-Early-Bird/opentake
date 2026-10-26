import type {CoinbaseChatScope} from '../../shared/platform-connections';
import {productSchema} from './order-planner';
import {createEligibilityRefresh,type EligibilityRefresh} from '../trading/eligibility-refresh';
const restrictionFlags=['limit_only','is_disabled','trading_disabled','cancel_only','post_only','auction_mode','view_only'] as const;
/** Supplement missing fields without erasing an explicit denial or substituting
 * another market. REST provides a complete sizing snapshot; either read can deny. */
function supplement(primary:Record<string,unknown>,fallback:unknown,id:string){
 const complete=productSchema.parse(fallback);
 if(complete.product_id!==id)throw Error('Coinbase product identity changed');
 for(const field of ['product_id','base_currency_id','quote_currency_id','product_type'] as const){
  if(field in primary&&primary[field]!==complete[field])throw Error('Coinbase product identity changed');
 }
 const result={...complete};
 for(const flag of restrictionFlags)if(primary[flag]===true)result[flag]=true;
 if(typeof primary.status==='string'&&primary.status.toLowerCase()!=='online')result.status=primary.status;
 return result;
}
/** MCP is the primary read; supplement its omitted execution fields with authenticated REST. */
export function createCoinbaseTradingProduct(deps:{read(scope:CoinbaseChatScope,id:string):Promise<unknown>;rules(scope:CoinbaseChatScope,id:string):Promise<unknown>},refresh:EligibilityRefresh=createEligibilityRefresh()) {
 return async(scope:CoinbaseChatScope,id:string)=>{
  scope={...scope};
  return (await refresh.refresh({venue:'coinbase',environment:'production',accountId:scope.accountRef,authority:scope.authority},`product:${id}`,async signal=>{
   const result=await deps.read(scope,id);
   signal.throwIfAborted();
   if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Coinbase product unavailable');
   const primary=result as Record<string,unknown>;
   // Missing facts may be supplemented; malformed supplied facts must not be
   // converted into valid eligibility by a second source.
   const fields=Object.entries(productSchema.shape);
   for(const [field,schema] of fields)if(field in primary&&!schema.safeParse(primary[field]).success)throw Error('Invalid Coinbase product evidence');
   if('product_id' in primary&&primary.product_id!==id)throw Error('Coinbase product identity changed');
   const incomplete=fields.some(([field,schema])=>!schema.isOptional()&&!(field in primary));
   if(!incomplete)return result;
   const fallback=await deps.rules(scope,id);
   signal.throwIfAborted();
   return supplement(primary,fallback,id);
  })).value;
 };
}
