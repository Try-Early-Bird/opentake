import {z} from 'zod';
import type {CoinbaseMarket, CoinbaseMarketsAPI} from '../../shared/coinbase-markets';
import type {createCoinbasePriceCache} from './price-cache';
import {loadCoinbaseProductSeries} from './holding-series';
const pair=z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/).max(81);
const decimal=z.string().regex(/^\d+(\.\d+)?$/).max(80);
const optionalDecimal=z.string().optional().transform(v=>decimal.safeParse(v).success?v!:null);
const product=z.object({product_id:pair,product_type:z.string(),base_currency_id:z.string().min(1).max(40),quote_currency_id:z.string().min(1).max(40),base_name:z.string().max(200).optional(),price:optionalDecimal,price_percentage_change_24h:z.string().optional(),volume_24h:optionalDecimal,approximate_quote_24h_volume:optionalDecimal,high_24h:optionalDecimal,low_24h:optionalDecimal,market_cap:optionalDecimal,about_description:z.string().max(20000).nullish(),status:z.string().max(100).optional(),is_disabled:z.boolean().optional(),trading_disabled:z.boolean().optional()});
function normalize(raw:unknown):CoinbaseMarket {
 const p=product.parse(raw);
 if(p.product_type!=='SPOT'||p.product_id!==`${p.base_currency_id}-${p.quote_currency_id}`)throw Error('Unsupported market');
 const change=p.price_percentage_change_24h?.replace(/%$/,'');
 return {id:p.product_id,venue:'coinbase',base:p.base_currency_id,quote:p.quote_currency_id,name:p.base_name||p.base_currency_id,price:p.price,change24h:change&&/^-?\d+(\.\d+)?$/.test(change)?change:null,volume24h:p.volume_24h,quoteVolume24h:p.approximate_quote_24h_volume,high24h:p.high_24h,low24h:p.low_24h,marketCap:p.market_cap,description:p.about_description?.trim()||null,status:p.status||'Unknown',tradingDisabled:p.is_disabled===true||p.trading_disabled===true};
}
/** Public catalog/quotes share the persistent cache and request budget with portfolio candles. */
export function createCoinbaseMarkets(prices:ReturnType<typeof createCoinbasePriceCache>,now=Date.now,authenticated?:(accountId:string,product:string)=>Promise<unknown>) {
 return {
  async detail(raw:unknown,rawAccount?:unknown){const id=pair.parse(raw);
   if(rawAccount!==undefined){
    const account=z.uuid().parse(rawAccount);if(!authenticated)throw Error('Authenticated market data unavailable');
    const market=normalize(await authenticated(account,id));if(market.id!==id)throw Error('Market identity mismatch');
    return {market,observedAt:new Date(now()).toISOString(),stale:false,source:'authenticated' as const};
   }
const result=await prices.cachedPublic(id,'product',60000,async get=>{const market=normalize(await get(`/api/v3/brokerage/market/products/${id}`));if(market.id!==id)throw Error('Market identity mismatch');return market;});const live=await prices.latestStreamPrice(id);const market=result.data as CoinbaseMarket;return {market:live?{...market,price:live.price}:market,observedAt:result.observedAt,stale:result.stale,source:'public' as const};},
  async series(raw:unknown,rawRange:unknown){const id=pair.parse(raw),range=z.enum(['1d','1w','1m','3m','1y','all']).parse(rawRange);const result=await loadCoinbaseProductSeries(id,id,range,prices,now(),undefined,true);return {...result,observedAt:new Date(now()).toISOString()};}
 } satisfies CoinbaseMarketsAPI;
}
