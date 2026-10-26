import {z} from 'zod';
import type {createDatabaseLifecycle} from '../database';
import {backgroundDatabaseWork,type DatabaseClient} from '../database-client';
import {coinbaseSourceId} from '../../shared/coinbase-source';
const quoteSchema=z.object({product:z.string().max(81).regex(/^[A-Z0-9._]+-USD$/),price:z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d+)?$/).refine(value=>Number(value)>0&&Number.isFinite(Number(value))),eventTime:z.number().int().nonnegative()});
export type StreamPrice=z.infer<typeof quoteSchema>;
const fresh=(quote:StreamPrice,now:number)=>quote.eventTime<=now+2000&&now-quote.eventTime<=15000;
/** Dedicated latest-price rows: ticks never refresh HTTP product metadata or candles. */
export async function readCoinbaseStreamPrice(db:Pick<DatabaseClient,'query'>,product:string,now=Date.now()){
 const row=(await db.query<{data:unknown;fetched_at:Date}>(`SELECT p.data,p.fetched_at FROM public_price_cache p
 JOIN data_sources s ON s.id=$2 AND s.enabled AND s.validated
 JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision
 WHERE p.provider='coinbase' AND p.pair=$1 AND p.kind='stream-price' AND p.interval_seconds=0 AND p.bucket=0
 AND p.data->>'revision'=s.current_revision::text AND r.config->>'collection'<>'off'`,[product,coinbaseSourceId])).rows[0];
 if(!row)return null;
 const parsed=quoteSchema.safeParse(row.data);
 if(!parsed.success||parsed.data.product!==product||!fresh(parsed.data,now)||row.fetched_at.getTime()>now||now-row.fetched_at.getTime()>15000)return null;
 return {...parsed.data,receivedAt:row.fetched_at.getTime(),sourceId:coinbaseSourceId,revision:Number((row.data as {revision:number}).revision)};
}
/** Latest prices only, not candles or portfolio history. Within a revision, the first
 * committed value wins timestamp ties; older/equal timestamps are terminal no-ops.
 * Failed writes remain retryable. Coalesces at 1 Hz and drains before DB close. */
export function createCoinbaseStreamPriceWriter(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,snapshot:()=>{revision:number;quotes:StreamPrice[]},now=Date.now,onError:()=>void=()=>{}){
 let timer:ReturnType<typeof setInterval>|undefined,work:Promise<void>|undefined,closed=false,lastCleanup=-Infinity;
 const handledQuotes=new Map<string,string>();
 async function flush(){
  const current=snapshot(),time=now();
  const active=new Set(current.quotes.map(quote=>quote.product));for(const key of handledQuotes.keys())if(!active.has(key))handledQuotes.delete(key);
  const quotes=current.quotes.slice(0,100).filter(quote=>quoteSchema.safeParse(quote).success&&fresh(quote,time));
  const pending=quotes.map(quote=>({quote,key:JSON.stringify([current.revision,quote.eventTime,quote.price])})).filter(item=>handledQuotes.get(item.quote.product)!==item.key);
  if(!pending.length&&time-lastCleanup<60000)return;
  await backgroundDatabaseWork(()=>database.use(async db=>{
   if(pending.length){
    const result=await db.query<{pair:string}>(`WITH eligible AS (SELECT q.value FROM jsonb_array_elements($1::jsonb) q(value)
     CROSS JOIN data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision
     WHERE s.id=$3 AND s.current_revision=$4 AND s.enabled AND s.validated AND r.config->>'collection'<>'off'), saved AS (
     INSERT INTO public_price_cache(provider,pair,kind,interval_seconds,bucket,data,fetched_at,retry_at)
     SELECT 'coinbase',value->>'product','stream-price',0,0,value,$2,NULL FROM eligible
     ON CONFLICT(provider,pair,kind,interval_seconds,bucket) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,retry_at=NULL
     WHERE (public_price_cache.data->>'revision')::int<>$4 OR (public_price_cache.data->>'eventTime')::bigint<(excluded.data->>'eventTime')::bigint
     RETURNING pair) SELECT value->>'product' AS pair FROM eligible`,[JSON.stringify(pending.map(({quote})=>({...quote,revision:current.revision}))),new Date(time).toISOString(),coinbaseSourceId,current.revision]);
    // A successful statement acknowledges admitted no-ops too; disabled/revised sources are not acknowledged.
    const handled=new Set(result.rows.map(row=>row.pair));for(const item of pending)if(handled.has(item.quote.product))handledQuotes.set(item.quote.product,item.key);
   }
   // Latest values only, bounded even when subscribed products change over time.
   if(time-lastCleanup>=60000){await db.query(`DELETE FROM public_price_cache WHERE provider='coinbase' AND kind='stream-price' AND (fetched_at<$1 OR pair IN
    (SELECT pair FROM public_price_cache WHERE provider='coinbase' AND kind='stream-price' ORDER BY fetched_at DESC OFFSET 1000))`,[new Date(time-86400000).toISOString()]);lastCleanup=time;}
  }));
 }
 function tick(){if(closed)return Promise.resolve();if(!work)work=flush().catch(onError).finally(()=>{work=undefined;});return work;}
 return {tick,start(){if(!closed&&!timer){void tick();timer=setInterval(()=>void tick(),1000);}},async close(){closed=true;if(timer)clearInterval(timer);await work;}};
}
