import {readCustomCryptoPrice} from './crypto-prices';
import {readCoinbaseStreamPrice} from '../coinbase/stream-price-store';
import { z } from 'zod';
import type { DatabaseClient } from '../database-client';
import { marketIdentitySchema } from '../../shared/search';
import type { StoredMarketPrice } from '../../shared/data-sources';
const positive = z.string().max(80).regex(/^\d+(\.\d+)?$/).refine(value=>Number.isFinite(Number(value))&&Number(value)>0);
/** Existing stores only. No acquisition, credentials, writes or execution fallback. */
export async function readStoredMarketPrice(db:Pick<DatabaseClient,'query'>,raw:unknown,now=Date.now()):Promise<StoredMarketPrice> {
 const market=marketIdentitySchema.parse(raw);
 const empty=(quality:'missing'|'unsupported'|'invalid'):StoredMarketPrice=>({market,quality,quote:null});
 if(market.instance!=='production'||market.pair!==undefined||market.contract!==undefined)return empty('unsupported');
 let price:unknown,currency:string,receivedAt:number,eventTime:number|null,provider:string,sourceId:string|null=null,revision:number|null=null,feedId:string|null=null,retrying=false;
 if(market.venue==='robinhood'&&market.kind==='equity'&&/^[A-Z][A-Z0-9.-]{0,11}$/.test(market.reference)){
  const row=(await db.query<{price:string|null;observed_at:Date;last_trade_at:Date|null;price_provider:string;price_source_id:string|null;price_source_revision:number|null;price_source_feed:string|null}>('SELECT price::text,observed_at,last_trade_at,price_provider,price_source_id,price_source_revision,price_source_feed FROM market_quotes WHERE symbol=$1',[market.reference])).rows[0];
  if(!row||row.price===null)return empty('missing');
  price=row.price;currency='USD';receivedAt=row.observed_at.getTime();eventTime=row.last_trade_at?.getTime()??null;provider=row.price_provider;sourceId=row.price_source_id;revision=row.price_source_revision;feedId=row.price_source_feed;
 }else if(market.venue==='coinbase'&&market.kind==='crypto'&&/^[A-Z0-9._]+-[A-Z0-9._]+$/.test(market.reference)&&market.reference.length<=81){
  const live=await readCoinbaseStreamPrice(db,market.reference,now);
  if(live)return {market,quality:'fresh',quote:{payload:{kind:'quote',price:live.price},currency:'USD',receivedAt:live.receivedAt,eventTime:live.eventTime,timeBasis:'provider',origin:'stored',provider:'coinbase-websocket',sourceId:live.sourceId,revision:live.revision,feedId:'price',maxAgeMs:15000}};
  const row=(await db.query<{data:unknown;fetched_at:Date;retry_at:Date|null}>("SELECT data,fetched_at,retry_at FROM public_price_cache WHERE provider='coinbase' AND pair=$1 AND kind='product' AND interval_seconds=0 AND bucket=0",[market.reference])).rows[0];
  if(!row||row.data===null)return empty('missing');
  const parsed=z.object({id:z.literal(market.reference),venue:z.literal('coinbase'),base:z.string(),quote:z.string(),price:positive.nullable()}).safeParse(row.data);
  if(!parsed.success||`${parsed.data.base}-${parsed.data.quote}`!==market.reference)return empty('invalid');
  const brokerFresh=parsed.data.price!==null&&row.retry_at===null&&row.fetched_at.getTime()<=now&&now-row.fetched_at.getTime()<60000;
  if(!brokerFresh){
   const custom=await readCustomCryptoPrice(db,market.reference,now);
   if(custom)return {market,quality:'fresh',quote:{payload:{kind:'quote',price:custom.price},currency:'USD',receivedAt:custom.receivedAt,eventTime:custom.eventTime,timeBasis:'provider',origin:'stored',provider:custom.provider,sourceId:custom.sourceId,revision:custom.revision,feedId:custom.feedId,maxAgeMs:custom.maxAgeMs}};
  }
  if(parsed.data.price===null)return empty('missing');
  price=parsed.data.price;currency=parsed.data.quote;receivedAt=row.fetched_at.getTime();eventTime=null;provider='coinbase';retrying=row.retry_at!==null;
 }else return empty('unsupported');
 if(!positive.safeParse(price).success||!Number.isFinite(receivedAt)||eventTime!==null&&!Number.isFinite(eventTime))return empty('invalid');
 const maxAgeMs=60000;
 const fresh=!retrying&&receivedAt<=now&&now-receivedAt<maxAgeMs&&(eventTime===null||eventTime<=now&&now-eventTime<maxAgeMs);
 return {market,quality:fresh?'fresh':'stale',quote:{payload:{kind:'quote',price:price as string},currency,receivedAt,eventTime,timeBasis:eventTime===null?'receipt':'provider',origin:'stored',provider,sourceId,revision,feedId,maxAgeMs}};
}
