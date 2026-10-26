import { z } from 'zod';
import type { PortfolioAPI } from '../../shared/portfolio';
import type { DataSourcesAPI } from '../../shared/data-sources';
import { loadCoinbaseDisplay } from '../../shared/data-source-display/coinbase';
const range=z.enum(['1d','1w','1m','3m','1y','all']);
const symbol=z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/);
const product=z.string().max(81).regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/);
/** Shared display adapters. Account authority and chart semantics remain with the
 * providers. Only identical in-flight reads share work; results are not cached. */
export function createSourceDisplays(deps:Pick<PortfolioAPI,'series'|'market'|'coinbaseMarkets'> & Pick<DataSourcesAPI,'storedMarketPrice'>) {
 const active=new Map<string,Promise<unknown>>();let generation=0,closed=false;
 function run<T>(key:string,work:()=>Promise<T>):Promise<T>{
  if(closed)return Promise.reject(Error('Display sources stopping'));
  const pending=active.get(key);if(pending)return pending.then(result=>structuredClone(result) as T);
  if(active.size>=64)return Promise.reject(Error('Display source capacity reached'));
  const epoch=generation;
  const promise=Promise.resolve().then(()=>{if(closed||epoch!==generation)throw Error('Display source changed; reload');return work();}).then(result=>{if(closed||epoch!==generation)throw Error('Display source changed; reload');return result;});
  active.set(key,promise);
  void promise.finally(()=>{if(active.get(key)===promise)active.delete(key);}).catch(()=>{});
  return promise.then(result=>structuredClone(result));
 }
 return {
  market(raw:unknown){const ticker=symbol.parse(raw);return run(JSON.stringify(['equity',ticker]),()=>deps.market(ticker));},
  series(rawAccount:unknown,rawRange:unknown,rawSymbols?:unknown){
   const account=z.uuid().parse(rawAccount),period=range.parse(rawRange),symbols=rawSymbols===undefined?undefined:z.array(z.string().regex(/^[A-Z0-9._-]{1,40}$/)).max(1000).parse(rawSymbols);
   return run(JSON.stringify(['account-series',account,period,symbols??null]),()=>deps.series(account,period,symbols));
  },
  coinbaseDetail(rawProduct:unknown,rawAccount?:unknown){
   const id=product.parse(rawProduct),account=rawAccount===undefined?undefined:z.uuid().parse(rawAccount);
   return run(JSON.stringify(['coinbase-detail',id,account??null]),()=>loadCoinbaseDisplay(id,account,deps.coinbaseMarkets.detail,deps.storedMarketPrice));
  },
  coinbaseSeries(rawProduct:unknown,rawRange:unknown){const id=product.parse(rawProduct),period=range.parse(rawRange);return run(JSON.stringify(['coinbase-series',id,period]),()=>deps.coinbaseMarkets.series(id,period));},
  invalidate(){generation++;active.clear();},
  close(){closed=true;generation++;active.clear();},
 };
}
