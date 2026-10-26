import {z} from 'zod';
import type {DatabaseClient} from '../database-client';
import type {DataObservation} from '../../shared/data-sources';
import type {CustomSourceConfig} from './config';
import type {DestinationResult} from './destinations';
import {savedSourceConfig} from './saved-config';
import {readCoinbaseStreamPrice} from '../coinbase/stream-price-store';
type Query=Pick<DatabaseClient,'query'>;
type Destination=Extract<NonNullable<CustomSourceConfig['feeds'][number]['destination']>,{kind:'market-prices'}>;
const productId=z.string().max(81).regex(/^[A-Z0-9._]+-USD$/);
const priceSchema=z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/).refine(value=>/[1-9]/.test(value));
const savedPrice=z.object({product:productId,price:priceSchema,eventTime:z.number().int().nonnegative(),sourceId:z.uuid(),revision:z.number().int().positive(),feedId:z.string(),provider:z.enum(['custom-http','custom-websocket']),maxAgeMs:z.number().int().min(15000).max(300000)});
/** Separate latest-price cache entries; never touch product metadata or chart candles. */
export async function readCustomCryptoPrice(db:Query,product:string,now:number){
 const row=(await db.query<{data:unknown;fetched_at:Date;config:unknown}>(`SELECT p.data,p.fetched_at,r.config FROM public_price_cache p
 JOIN data_sources s ON s.id::text=p.data->>'sourceId' AND s.enabled AND s.validated AND s.current_revision::text=p.data->>'revision'
 JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision
 WHERE p.provider='coinbase' AND p.pair=$1 AND p.kind='custom-price' AND p.interval_seconds=0 AND p.bucket=0`,[product])).rows[0];
 if(!row)return null;
 const parsed=savedPrice.safeParse(row.data),config=savedSourceConfig.safeParse(row.config);
 if(!parsed.success||!config.success||config.data.collection==='off')return null;
 const value=parsed.data;
 if(value.provider!==('transport' in config.data?'custom-websocket':'custom-http'))return null;
 const feed=config.data.feeds.find(f=>f.id===value.feedId),d=feed?.destination;
 if(value.product!==product||d?.kind!=='market-prices'||d.market.venue!=='coinbase'||d.maxAgeMs!==value.maxAgeMs)return null;
 const receivedAt=row.fetched_at.getTime();
 if(value.eventTime>now||receivedAt>now||now-value.eventTime>value.maxAgeMs||now-receivedAt>value.maxAgeMs)return null;
 return {...value,receivedAt};
}
export async function writeCustomCryptoPrice(db:Query,destination:Destination,o:DataObservation,product:string,price:string,now:number,dryRun:boolean):Promise<DestinationResult>{
 const target=`public_price_cache:coinbase:${product}:custom-price`;
 const result=(outcome:DestinationResult['outcome']):DestinationResult=>({target,outcome});
 if(!productId.safeParse(product).success||!priceSchema.safeParse(price).success||o.unit!=='USD'||!['custom-http','custom-websocket'].includes(o.adapterId))return result('invalid');
 if(o.origin!=='live'||o.eventTime===null||o.eventTime>now||o.receivedAt>now||now-o.eventTime>destination.maxAgeMs||now-o.receivedAt>destination.maxAgeMs)return result('stale');
 const metadata=(await db.query<{data:unknown;fetched_at:Date}>("SELECT data,fetched_at FROM public_price_cache WHERE provider='coinbase' AND pair=$1 AND kind='product' AND interval_seconds=0 AND bucket=0 FOR UPDATE",[product])).rows[0];
 const market=z.object({id:z.literal(product),venue:z.literal('coinbase'),base:z.string(),quote:z.literal('USD'),price:priceSchema.nullable()}).safeParse(metadata?.data);
 if(!metadata||!market.success||`${market.data.base}-USD`!==product)return result('missing-market');
 if(await readCoinbaseStreamPrice(db,product,now))return result('preserved');
 if(market.data.price!==null&&(destination.policy==='fill-missing'||metadata.fetched_at.getTime()>now||now-metadata.fetched_at.getTime()<=Math.max(60000,destination.maxAgeMs)))return result('preserved');
 const previous=(await db.query<{data:unknown;fetched_at:Date}>("SELECT data,fetched_at FROM public_price_cache WHERE provider='coinbase' AND pair=$1 AND kind='custom-price' AND interval_seconds=0 AND bucket=0 FOR UPDATE",[product])).rows[0];
 const parsed=savedPrice.safeParse(previous?.data);
 if(parsed.success&&previous){
  const own=parsed.data.sourceId===o.sourceId&&parsed.data.feedId===o.feedId;
  if(o.eventTime<=parsed.data.eventTime||own&&now-previous.fetched_at.getTime()<5000||!own&&(destination.policy==='fill-missing'||now-previous.fetched_at.getTime()<=destination.maxAgeMs))return result('preserved');
 }
 const value={product,price,eventTime:o.eventTime,sourceId:o.sourceId,revision:o.configVersion,feedId:o.feedId,provider:o.adapterId,maxAgeMs:destination.maxAgeMs};
 if(!dryRun)await db.query(`INSERT INTO public_price_cache(provider,pair,kind,interval_seconds,bucket,data,fetched_at,retry_at)
 VALUES('coinbase',$1,'custom-price',0,0,$2,$3,NULL) ON CONFLICT(provider,pair,kind,interval_seconds,bucket)
 DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,retry_at=NULL`,[product,JSON.stringify(value),new Date(o.receivedAt)]);
 return {target,outcome:dryRun?'would-write':'written',proposed:{price,currency:'USD',provider:o.adapterId,eventTime:new Date(o.eventTime).toISOString()}};
}
