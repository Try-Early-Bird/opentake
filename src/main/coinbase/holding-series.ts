import {z} from 'zod';
import type {MarketSeries,SymbolSeries} from '../../shared/market-series';
import type {PortfolioView} from '../../shared/portfolio';
import type {createCoinbasePriceCache} from './price-cache';
const request=z.object({accountId:z.uuid(),range:z.enum(['1d','1w','1m','3m','1y','all']),symbols:z.array(z.string().regex(/^[A-Z0-9._-]{1,40}$/)).max(1000).optional()}).strict();
/** Public price history, scoped to this account's holdings, using the existing persistent candle cache. */
export function createCoinbaseHoldingSeries(snapshot:(id:string)=>Promise<PortfolioView>,prices:Pick<ReturnType<typeof createCoinbasePriceCache>,'candles'>,clock=Date.now){
 return async(raw:unknown):Promise<MarketSeries>=>{
  const {accountId,range,symbols}=request.parse(raw),view=await snapshot(accountId);
  if(view.account?.id!==accountId||view.account.venue!=='coinbase')throw Error('Coinbase account unavailable');
  const now=clock();
  const historyTimes=[...view.history.map(p=>Date.parse(p.observedAt)),...(view.accountTransactions??[]).map(p=>Date.parse(p.occurredAt))].filter(Number.isFinite);
  const holdings=(view.spotPositions??[]).filter(p=>!p.isCash&&(!symbols||symbols.includes(p.asset))&&/^[A-Z0-9._-]{1,40}$/.test(p.asset));
  const series:SymbolSeries[]=[],staleSymbols:string[]=[],pendingSymbols:string[]=[];
  // Serial reads share the cache's request budget and avoid a burst per holding.
  for(const holding of holdings){
   try{
    const result=await loadCoinbaseProductSeries(`${holding.asset}-${holding.currency}`,holding.asset,range,prices,now,historyTimes.length?Math.min(...historyTimes):undefined);
    if(result.stale)staleSymbols.push(holding.asset);
    if(result.series)series.push(result.series);
   }catch{staleSymbols.push(holding.asset);}
  }
  return {venue:'coinbase',range,asOf:new Date(now).toISOString(),series,staleSymbols,pendingSymbols,refreshingSymbols:[]};
 };
}

export async function loadCoinbaseProductSeries(product:string,symbol:string,range:MarketSeries['range'],prices:Pick<ReturnType<typeof createCoinbasePriceCache>,'candles'>,now:number,earliest?:number,includeCurrent=false):Promise<{series:SymbolSeries|null;stale:boolean}> {
 const day=86400000,step=range==='1d'||range==='1w'?3600000:day;
 const end=(includeCurrent?Math.ceil(now/step):Math.floor(now/step))*step;
 const days={'1d':1,'1w':7,'1m':30,'3m':90,'1y':365,all:365}[range];
 const start=Math.floor((range==='all'&&earliest!==undefined?Math.min(end-step,earliest):end-days*day)/step)*step;
    const points:SymbolSeries['points']=[];let stale=false;
    for(let from=start;from<end;from+=350*step){
     const result=await prices.candles(product,new Date(from).toISOString(),new Date(Math.min(end,from+350*step)).toISOString(),step/1000);
     stale ||=result.stale||result.candles.length<(Math.min(end,from+350*step)-from)/step;
     for(const candle of result.candles)points.push({t:new Date(Math.min(now,(Number(candle.start)*1000)+step)).toISOString(),c:candle.close,s:'regular'});
    }
    if(points.length<2){return {series:null,stale:true};}
    points.sort((a,b)=>a.t.localeCompare(b.t));
    const first=Number(points[0].c),last=Number(points.at(-1)!.c);
    return {stale,series:{symbol,interval:step===3600000?'hour':'day',bounds:'regular',dayStart:new Date(start).toISOString(),dayEnd:new Date(Math.min(now,end)).toISOString(),baseline:{price:points[0].c,kind:'first_bar'},price:points.at(-1)!.c,extendedPrice:null,extendedSession:null,extendedChange:null,change:first>0?{amount:String(last-first),percent:String((last-first)/first*100)}:null,points}};
}
