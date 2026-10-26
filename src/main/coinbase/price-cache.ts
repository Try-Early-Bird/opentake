import {readCoinbaseStreamPrice} from './stream-price-store';
import { CoinbaseError } from './errors';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
const hour = 3600000, day = 24 * hour;
const pair = z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/).max(81);
const price = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(80);
const candle = z.object({start:z.string().regex(/^\d+$/),open:price,high:price,low:price,close:price,volume:price});
type Candle = z.infer<typeof candle>;
type Row = { bucket:string; data:unknown; fetched_at:Date; retry_at:Date|null };
export const publicPriceCacheMigration = {version:53,name:'Shared public historical price cache',sql:`
CREATE TABLE public_price_cache (
 provider text NOT NULL, pair text NOT NULL, kind text NOT NULL,
 interval_seconds integer NOT NULL, bucket bigint NOT NULL,
 data jsonb, fetched_at timestamptz NOT NULL, retry_at timestamptz,
 PRIMARY KEY(provider,pair,kind,interval_seconds,bucket)
);
CREATE INDEX public_price_cache_fetched ON public_price_cache(fetched_at);
`};

/** Public prices have no account or credential dependency. Buckets survive restarts. */
export function createCoinbasePriceCache(database:Database, fetcher:typeof fetch=fetch, now=()=>Date.now(), authenticatedCandles?:(product:string,start:string,end:string,interval:number)=>Promise<unknown>) {
 const locks=new Map<string,Promise<unknown>>();
 let requests=0, windowStart=now();
 function budget() {
  if(now()-windowStart>=60000){requests=0;windowStart=now();}
  if(requests++>=100)throw new Error('Price request budget reached');
 }
 async function get(path:string) {
  budget();
  const response=await fetcher('https://api.coinbase.com'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok){await response.body?.cancel();throw new Error('Historical price unavailable');}
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty price response');
  let size=0;const chunks:Uint8Array[]=[];
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000){await reader.cancel();throw new Error('Price response too large');}chunks.push(part.value);}
   return JSON.parse(Buffer.concat(chunks).toString());
  }finally{reader.releaseLock();}
 }
 async function serialized<T>(key:string,work:()=>Promise<T>):Promise<T> {
  const prior=locks.get(key);let release!:()=>void;
  const current=new Promise<void>(resolve=>{release=resolve;});locks.set(key,current);
  await prior;
  try{return await work();}finally{release();if(locks.get(key)===current)locks.delete(key);}
 }
 async function rows(product:string,kind:string,interval:number,start:number,end:number) {
  return (await database.use(db=>db.query<Row>('SELECT bucket::text,data,fetched_at,retry_at FROM public_price_cache WHERE provider=$1 AND pair=$2 AND kind=$3 AND interval_seconds=$4 AND bucket >= $5 AND bucket < $6',['coinbase',product,kind,interval,start,end]))).rows;
 }
 async function save(product:string,kind:string,interval:number,bucket:number,data:unknown,retry:number|null) {
  await database.use(db=>db.query(`INSERT INTO public_price_cache(provider,pair,kind,interval_seconds,bucket,data,fetched_at,retry_at)
   VALUES('coinbase',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider,pair,kind,interval_seconds,bucket)
   DO UPDATE SET data=coalesce(excluded.data,public_price_cache.data), fetched_at=CASE WHEN excluded.data IS NULL THEN public_price_cache.fetched_at ELSE excluded.fetched_at END,retry_at=excluded.retry_at`,
   [product,kind,interval,bucket,data===null?null:JSON.stringify(data),new Date(now()).toISOString(),retry===null?null:new Date(retry).toISOString()]));
 }
 function stale(row:Row,bucket:number) {
  return now()-row.fetched_at.getTime()>=(bucket>=now()-2*day?5*60000:30*day);
 }
 function due(row:Row|undefined,bucket:number) {
  if(row?.retry_at&&row.retry_at.getTime()>now())return false;
  if(!row?.data)return true;
  return stale(row,bucket);
 }
 return {
  latestStreamPrice(product:string){pair.parse(product);return database.use(db=>readCoinbaseStreamPrice(db,product,now()));},
  async cachedPublic<T>(product:string,kind:'catalog'|'product',ttl:number,load:(get:(path:string)=>Promise<unknown>)=>Promise<T>):Promise<{data:T;observedAt:string;stale:boolean}> {
   return serialized(product+':'+kind,async()=>{
    let row=(await rows(product,kind,0,0,1))[0];
    if((!row?.data||now()-row.fetched_at.getTime()>=ttl)&&!(row?.retry_at&&row.retry_at.getTime()>now())){
     try {await save(product,kind,0,0,await load(get),null);}
     catch {await save(product,kind,0,0,null,now()+15*60000);}
     row=(await rows(product,kind,0,0,1))[0];
    }
    if(!row?.data)throw Error('Market data unavailable. Try again later.');
    return {data:row.data as T,observedAt:row.fetched_at.toISOString(),stale:!!row.retry_at||now()-row.fetched_at.getTime()>=ttl};
   });
  },
  async candles(product:string,start:string,end:string,intervalSeconds=3600):Promise<{candles:Candle[];stale:boolean}> {
   pair.parse(product);if(![3600,86400].includes(intervalSeconds))throw new Error('Unsupported candle interval');
   const step=intervalSeconds*1000,from=Date.parse(start),to=Date.parse(end);
   if(!Number.isFinite(from)||!Number.isFinite(to)||from%step||to%step||to<=from||to-from>350*step)throw new Error('Invalid candle window');
   return serialized(product+':candles:'+intervalSeconds,async()=>{
    const stored=new Map((await rows(product,'candles',intervalSeconds,from,to)).map(r=>[Number(r.bucket),r]));
    const missing:number[]=[];for(let t=from;t<to;t+=step)if(due(stored.get(t),t))missing.push(t);
    for(let i=0;i<missing.length;){const first=missing[i];let last=first;while(i+1<missing.length&&missing[i+1]===last+step){last=missing[++i];}i++;
     const requested:number[]=[];for(let t=first;t<=last;t+=step)requested.push(t);
     try {
      const publicRead=()=>get(`/api/v3/brokerage/market/products/${product}/candles?start=${first/1000}&end=${(last+step)/1000}&granularity=${intervalSeconds===3600?'ONE_HOUR':'ONE_DAY'}&limit=350`);
      let raw:unknown;
      if(authenticatedCandles){
       try{budget();raw=await authenticatedCandles(product,new Date(first).toISOString(),new Date(last+step).toISOString(),intervalSeconds);}
       // No connected account (or a provider failure): the public candles need no credentials.
       catch(error){if(!(error instanceof CoinbaseError)||(error.code!=='provider'&&error.code!=='unavailable'))throw error;raw=await publicRead();}
      }else raw=await publicRead();
      const parsed=z.object({candles:z.array(candle).max(350)}).parse(raw);
      const received=new Map<number,Candle>();
      for(const value of parsed.candles){const t=Number(value.start)*1000;if(t%step||received.has(t))throw new Error('Invalid candle bucket');if(t>=first&&t<=last)received.set(t,value);}
      for(const t of requested)await save(product,'candles',intervalSeconds,t,received.get(t)??null,received.has(t)?null:now()+15*60000);
     }catch(error){if(error instanceof CoinbaseError && error.code!=='provider')throw error;for(const t of requested)await save(product,'candles',intervalSeconds,t,null,now()+15*60000);}
    }
    const cached=(await rows(product,'candles',intervalSeconds,from,to)).filter(r=>r.data);
    return {candles:cached.sort((a,b)=>Number(a.bucket)-Number(b.bucket)).map(r=>candle.parse(r.data)),stale:cached.some(r=>stale(r,Number(r.bucket)))};
   });
  },
  /** Execution previews need a current conversion, never a dated close or assumed peg. */
  async currentSpot(product:string):Promise<string> {
   pair.parse(product);
   try {
    const raw=z.object({data:z.object({amount:price,base:z.string(),currency:z.string()})}).parse(await get(`/v2/prices/${product}/spot`));
    if(raw.data.base+'-'+raw.data.currency!==product||!Number.isFinite(Number(raw.data.amount))||Number(raw.data.amount)<=0)throw Error('Invalid conversion quote');
    return raw.data.amount;
   }catch{throw Error(`Could not get the current ${product.replace('-', '/')} conversion rate. Retry preview.`);}
  },
  async dailySpot(product:string,date:string):Promise<string> {
   pair.parse(product);const bucket=Date.parse(date+'T00:00:00Z');
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(bucket)||new Date(bucket).toISOString().slice(0,10)!==date||bucket>=Math.floor(now()/day)*day)throw new Error('A completed UTC date is required');
   return serialized(product+':spot:'+date,async()=>{
    const row=(await rows(product,'spot',86400,bucket,bucket+day))[0];
    if(due(row,bucket))try {
     const raw=z.object({data:z.object({amount:price,base:z.string(),currency:z.string()})}).parse(await get(`/v2/prices/${product}/spot?date=${date}`));
     if(raw.data.base+'-'+raw.data.currency!==product)throw new Error('Price pair mismatch');
     await save(product,'spot',86400,bucket,raw.data,null);
    }catch{await save(product,'spot',86400,bucket,null,now()+15*60000);}
    const result=(await rows(product,'spot',86400,bucket,bucket+day))[0];
    if(!result?.data||stale(result,bucket))throw new Error('Daily price unavailable');
    return z.object({amount:price}).parse(result.data).amount;
   });
  },
 };
}
