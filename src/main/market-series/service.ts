import {z} from 'zod';
import type {createConnections} from '../connections';
import type {PortfolioView} from '../../shared/portfolio';
import type {MarketSeries,SymbolSeries} from '../../shared/market-series';
import {normalizeEquityHistoricals,normalizeEquityQuoteDetails} from './normalization';
import {buildSymbolSeries,seriesPlan} from './series';

const requestSchema=z.object({accountId:z.uuid(),range:z.enum(['1d','1w','1m','3m','1y','all']),
 // Strategy simulations and benchmarks price symbols the account may not hold.
 symbols:z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/u)).min(1).max(50).optional()}).strict();
/** Where built series are kept between requests. Prices are public market
 * data, so entries are keyed by range and symbol, not by account. */
export interface SeriesCache {
 load(range:string,symbols:readonly string[]):Promise<Map<string,{at:number;series:SymbolSeries}>>;
 save(range:string,entries:readonly {symbol:string;at:number;series:SymbolSeries}[]):Promise<void>;
}
/** The original process-memory cache; the background host persists it instead (price-store). */
export function memorySeriesCache():SeriesCache{
 const cache=new Map<string,{at:number;series:SymbolSeries}>();
 return {
  async load(range,symbols){return new Map(symbols.flatMap(symbol=>{const hit=cache.get(`${range}:${symbol}`);return hit?[[symbol,hit] as const]:[];}));},
  async save(range,entries){for(const e of entries)cache.set(`${range}:${e.symbol}`,{at:e.at,series:e.series});while(cache.size>600)cache.delete(cache.keys().next().value!);},
 };
}
/** Price history is independent of account snapshots. Never manufacture bars
 * from portfolio totals or substitute current holdings for historical holdings. */
export function createPortfolioSeries(
 connections:Pick<ReturnType<typeof createConnections>,'status'|'readTool'|'busy'>,
 snapshot:(accountId:string)=>Promise<PortfolioView>,clock=()=>Date.now(),
 cache:SeriesCache=memorySeriesCache(),
){
 let active:Promise<MarketSeries>|undefined;
 let activeKey='';
 async function eligible(id:string){
  const status=await connections.status();
  if(status.status!=='connected'||!status.accounts.some(a=>a.id===id&&a.selected&&a.agenticAllowed)){
   throw new Error('Select a connected account to load price history');
  }
 }
 return async(raw:unknown):Promise<MarketSeries>=>{
  const request=requestSchema.parse(raw);
  await eligible(request.accountId);
  const requestKey=JSON.stringify(request);
  if(active){if(activeKey===requestKey)return active;await active.catch(()=>{});}
  const work=async():Promise<MarketSeries>=>{
   await eligible(request.accountId);
   const view=await snapshot(request.accountId);
   if(view.account?.id!==request.accountId||!view.account.selected||!view.account.available||view.account.venue!=='robinhood')throw new Error('Account unavailable');
   const symbols=request.symbols?[...new Set(request.symbols)].sort():[...new Set(view.positions.filter(p=>p.assetClass==='equity'&&p.symbol).map(p=>p.symbol!.toUpperCase()))].sort();
   const now=clock(),plan=seriesPlan(request.range,now);
   const saved=await cache.load(request.range,symbols);
   const missing=symbols.filter(symbol=>{const cached=saved.get(symbol);return !cached||now-cached.at>=60_000;});
   // Keep each request bounded and let the screen progressively fill more rows.
   const batch=connections.busy()?[]:missing.slice(0,10);
   const failed=new Set<string>();
   if(batch.length){
    let bars:ReturnType<typeof normalizeEquityHistoricals>|undefined;
    let quotes:ReturnType<typeof normalizeEquityQuoteDetails>|undefined;
    try{
     bars=normalizeEquityHistoricals(await connections.readTool('get_equity_historicals',{
      symbols:batch,start_time:new Date(plan.fetchStartMs).toISOString(),interval:plan.interval,bounds:plan.bounds,adjustment_type:'split',
     },undefined,AbortSignal.timeout(20_000)));
    }catch{batch.forEach(s=>failed.add(s));}
    if(bars){
     try{quotes=normalizeEquityQuoteDetails(await connections.readTool('get_equity_quotes',{symbols:batch},undefined,AbortSignal.timeout(20_000)));}
     catch{batch.forEach(s=>failed.add(s));}
     await eligible(request.accountId);
     const fresh:{symbol:string;at:number;series:SymbolSeries}[]=[];
     for(const symbol of batch){
      const actual=(bars.get(symbol)??[]).filter(bar=>Date.parse(bar.beginsAt)<=now);
      if(!actual.length){failed.add(symbol);continue;}
      fresh.push({symbol,at:now,series:buildSymbolSeries({symbol,bars:actual,quote:quotes?.get(symbol),plan,nowMs:now})});
     }
     await cache.save(request.range,fresh);
     for(const entry of fresh)saved.set(entry.symbol,{at:entry.at,series:entry.series});
    }
   }
   await eligible(request.accountId);
   const result:MarketSeries={venue:'robinhood_agentic',range:request.range,asOf:new Date(now).toISOString(),series:[],staleSymbols:[],pendingSymbols:[],refreshingSymbols:[]};
   for(const symbol of symbols){
    const hit=saved.get(symbol);
    if(hit)result.series.push(hit.series);
    if(failed.has(symbol))result.staleSymbols.push(symbol);
    else if(!hit)result.pendingSymbols.push(symbol);
    else if(now-hit.at>=60_000)result.refreshingSymbols.push(symbol);
   }
   return result;
  };
  const promise=work();active=promise;activeKey=requestKey;
  try{return await promise;}finally{if(active===promise){active=undefined;activeKey='';}}
 };
}
