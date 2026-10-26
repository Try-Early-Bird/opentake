import {hasRobinhoodCrypto,type createCryptoModel} from '../assets/crypto-model';
import { supportsBasketExecution,hasPendingInstrumentSupport } from '../../shared/strategies';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import {delistedMarks} from '../execution/delistings';
import type {MarketSeries,PriceRange,SymbolSeries} from '../../shared/market-series';
import type {BasketSpec} from '../../shared/strategies';
import type {PerformanceBasis,PerformanceRange,StrategyMarker,StrategyPerformance} from '../../shared/strategy-performance';
import {computeAllocationHistory,dailyClosesFromSeries,loadAllocationEntries,type DailyClose,type LedgerEntry} from '../allocations/allocation-history';
import {easternClock,easternWallTimeToUtc} from '../market-series/sessions';
import {computeModelValuations,performanceStat,scheduledRebalanceDays} from './model-valuation';

// Strategy performance. The model
// line values the strategy's committed versions as a unit index from daily
// closes: each version takes effect on the Eastern day it was committed, as a
// hosted allocation does on publication, and earlier days are backtested. A
// strategy with nothing committed backtests its draft. The actual line chains
// this strategy's allocations (imported source ledger included), value-
// weighted with deposits taken out; 1D prices current holdings intraday.

const RANGES:readonly PerformanceRange[]=['1d','1w','1m','3m','1y','3y','5y','all'];
const UNRELEASED_OR_DETACHED="('active','paused','diverged','detached')";
type Rebalance=BasketSpec['rebalance'];
type Ledger=Map<string,LedgerEntry[]>;

/** `3y`/`5y` read the longest series. */
export function seriesRangeFor(range:PerformanceRange):PriceRange{return range==='3y'||range==='5y'?'all':range;}

export function rangeStartDay(range:PerformanceRange,now:Date):string|null{
 if(range==='all')return null;
 if(range==='1w')return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-7)).toISOString().slice(0,10);
 const months=range==='1m'?1:range==='3m'?3:range==='1y'?12:range==='3y'?36:60;
 return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-months,now.getUTCDate())).toISOString().slice(0,10);
}

const tradingDays=(closes:ReadonlyMap<string,readonly DailyClose[]>)=>[...new Set([...closes.values()].flatMap(list=>list.map(c=>c.day)))].sort();
const easternDateOf=(iso:string)=>easternClock(Date.parse(iso)).date;
const easternDayEndUtc=(day:string)=>new Date(easternWallTimeToUtc(day,24*60)).toISOString();
/** Each symbol's last close on or before the day, for the chart's hover readout; days must be asked in order. */
const pricesWalker=(closesBySymbol:ReadonlyMap<string,readonly DailyClose[]>)=>{
 const sorted=[...closesBySymbol].map(([symbol,closes])=>({symbol,closes:[...closes].sort((a,b)=>a.day.localeCompare(b.day)),index:-1}));
 return (day:string)=>{
  const prices:Record<string,number>={};
  for(const item of sorted){
   while(item.index+1<item.closes.length&&item.closes[item.index+1]!.day<=day)item.index+=1;
   if(item.index>=0)prices[item.symbol]=Number(item.closes[item.index]!.close);
  }
  return prices;
 };
};
const weightsOf=(spec:BasketSpec)=>({weights:spec.target.weights.map(w=>({symbol:w.instrument.symbol.toUpperCase(),weightPercent:w.bps/100})),cashPercent:spec.target.cashBps/100});

/** Yesterday's close, then today's intraday: the actual 1D line. */
export function actualIntradayLine(ledgers:Ledger,series:readonly SymbolSeries[],dayStartUtc:string):StrategyPerformance['intraday']&{investors:number}|null{
 const buckets=[...ledgers.values()].map(entries=>{
  const bucket={sharesStart:new Map<string,number>(),sharesNow:new Map<string,number>(),cashStart:0,cashNow:0,flow:0,base:0};
  for(const entry of entries){
   const today=entry.occurredAt>=dayStartUtc;
   const quantity=Number(entry.quantityDelta??0);
   if(entry.symbol!==null&&quantity!==0){
    const symbol=entry.symbol.toUpperCase();
    bucket.sharesNow.set(symbol,(bucket.sharesNow.get(symbol)??0)+quantity);
    if(!today)bucket.sharesStart.set(symbol,(bucket.sharesStart.get(symbol)??0)+quantity);
   }
   const cash=Number(entry.cashDelta??0);
   bucket.cashNow+=cash;
   if(!today)bucket.cashStart+=cash;
   else if(entry.entryType==='capital_allocated'||entry.entryType==='capital_released')bucket.flow+=cash;
  }
  return bucket;
 });
 const bySymbol=new Map(series.map(item=>[item.symbol.toUpperCase(),item]));
 const baselineOf=(symbol:string)=>{const item=bySymbol.get(symbol);const price=item?.baseline?.price??item?.points[0]?.c;return price===undefined?null:Number(price);};
 for(const bucket of buckets){
  let value=bucket.cashStart;
  for(const [symbol,quantity] of bucket.sharesStart){const price=baselineOf(symbol);if(price!==null)value+=quantity*price;}
  bucket.base=value;
 }
 // Money deposited today counts as capital for the day (Modified Dietz with the flow weighted in full).
 const weighted=buckets.filter(bucket=>bucket.base+bucket.flow>0);
 if(weighted.length===0)return null;
 const times=[...new Set(series.flatMap(item=>item.points.map(point=>point.t)))].sort();
 const cursors=new Map<string,number>(),lastPrice=new Map<string,number>();
 const points:NonNullable<StrategyPerformance['intraday']>['points']=[];
 for(const t of times){
  let session:SymbolSeries['points'][number]['s']|null=null;
  for(const item of series){
   const symbol=item.symbol.toUpperCase();
   let index=cursors.get(symbol)??0;
   while(index<item.points.length&&item.points[index]!.t<=t){
    lastPrice.set(symbol,Number(item.points[index]!.c));
    if(item.points[index]!.t===t)session=item.points[index]!.s;
    index+=1;
   }
   cursors.set(symbol,index);
  }
  let numerator=0,denominator=0;
  for(const bucket of weighted){
   let value=bucket.cashNow-bucket.flow;
   for(const [symbol,quantity] of bucket.sharesNow){const price=lastPrice.get(symbol)??baselineOf(symbol);if(price!==null)value+=quantity*price;}
   numerator+=value-bucket.base;denominator+=bucket.base+bucket.flow;
  }
  if(denominator<=0)continue;
  // What all of it is worth at this moment, today's deposits included.
  let value=0;
  for(const bucket of buckets){
   value+=bucket.cashNow;
   for(const [symbol,quantity] of bucket.sharesNow){const price=lastPrice.get(symbol)??baselineOf(symbol);if(price!==null)value+=quantity*price;}
  }
  points.push({t,c:(100*(1+numerator/denominator)).toFixed(6),s:session??'regular',value,prices:Object.fromEntries(lastPrice)});
 }
 const axis=series.find(item=>item.dayStart!==undefined&&item.dayEnd!==undefined);
 return {sessionDate:axis?.sessionDate??series[0]?.sessionDate??null,dayStart:axis?.dayStart??null,dayEnd:axis?.dayEnd??null,points,investors:weighted.length};
}

/** Each allocation's daily value chained into one index, deposits taken out. */
export function actualLine(ledgers:Ledger,closesBySymbol:ReadonlyMap<string,readonly DailyClose[]>,startDay:string|null):StrategyPerformance['points']{
 const allDays=tradingDays(closesBySymbol);
 const series=[...ledgers.values()].map(entries=>{
  const firstDay=[...entries].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt))[0]!.occurredAt.slice(0,10);
  const days=allDays.filter(day=>day>=firstDay&&(startDay===null||day>=startDay));
  return new Map(computeAllocationHistory({entries,closesBySymbol,days}).map(p=>[p.day,{value:Number(p.totalValue),capital:Number(p.capitalAllocated)}]));
 });
 const points:StrategyPerformance['points']=[];
 let index:number|null=null,previousDay:string|null=null;
 const pricesOn=pricesWalker(closesBySymbol);
 for(const day of allDays.filter(day=>startDay===null||day>=startDay)){
  let weightedReturn=0,weight=0,anyValue=false,value=0;
  for(const bucket of series){
   const today=bucket.get(day);
   if(today===undefined)continue;
   if(today.value>0)anyValue=true;
   value+=today.value;
   const yesterday=previousDay===null?undefined:bucket.get(previousDay);
   if(yesterday===undefined||yesterday.value<=0)continue;
   const flow=today.capital-yesterday.capital;
   const dayReturn=(today.value-flow)/yesterday.value-1;
   if(!Number.isFinite(dayReturn))continue;
   weightedReturn+=yesterday.value*dayReturn;weight+=yesterday.value;
  }
  const extra={value,prices:pricesOn(day)};
  if(index===null){if(anyValue){index=100;points.push({day,unitValue:'100',source:'live',...extra});}}
  else{if(weight>0)index*=1+weightedReturn/weight;points.push({day,unitValue:index.toFixed(6),source:'live',...extra});}
  previousDay=day;
 }
 return points;
}

/** Trailing dividend yields, percent a year, from fundamentals. */
export function dividendYields(fundamentals:ReadonlyMap<string,Record<string,unknown>>):Map<string,number>{
 const yields=new Map<string,number>();
 for(const [symbol,record] of fundamentals){
  const raw=record.dividend_yield??record.dividendYield;
  const value=typeof raw==='number'?raw:typeof raw==='string'?Number(raw.replaceAll(',','')):Number.NaN;
  if(Number.isFinite(value)&&value>=0&&value<100)yields.set(symbol,value);
 }
 return yields;
}

/** Your own money in and out of the strategy, as the chart's investor markers (viewer only). */
export function ownMarkers(ledgers:Ledger,startDay:string|null):StrategyMarker[]{
 const markers:StrategyMarker[]=[];
 for(const entries of ledgers.values()){
  let invested=false;
  for(const entry of [...entries].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt))){
   if(entry.entryType!=='capital_allocated'&&entry.entryType!=='capital_released')continue;
   const kind=entry.entryType==='capital_released'?'withdrew':invested?'deposit':'invested';
   if(entry.entryType==='capital_allocated')invested=true;
   if(startDay!==null&&easternDateOf(entry.occurredAt)<startDay)continue;
   const amount=entry.cashDelta===null?null:Math.abs(Number(entry.cashDelta)).toFixed(2);
   markers.push({at:entry.occurredAt,direction:kind==='withdrew'?'out':'in',party:'viewer',members:1,amount,kinds:{[kind]:1},breakdown:[{kind,members:1,amount}]});
  }
 }
 return markers.sort((a,b)=>a.at.localeCompare(b.at));
}

export function createStrategyPerformance(
 database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,
 series:(request:{accountId:string;range:PriceRange;symbols:string[]})=>Promise<MarketSeries>,
 fundamentals:(symbols:string[])=>Promise<Map<string,Record<string,unknown>>>,
 selectedAccountId:()=>Promise<string|null>,
 clock=()=>Date.now(),
 /** The local price store: daily closes when it covers the range, else null and a live read is made. */
 storedCloses:(symbols:string[],range:PerformanceRange)=>Promise<Map<string,DailyClose[]>|null>=async()=>null,
 coinbase?:{performance:(id:string,range:PerformanceRange,spec:BasketSpec,basis:PerformanceBasis,versions:{id:string;sequence:number;spec:BasketSpec;createdAt:Date}[])=>Promise<StrategyPerformance>;markers:(id:string,range:PerformanceRange)=>Promise<StrategyMarker[]>;mixed?:{performance:(id:string,range:PerformanceRange,spec:BasketSpec,basis:PerformanceBasis,versions:{id:string;sequence:number;spec:BasketSpec;createdAt:Date}[])=>Promise<StrategyPerformance>;markers:(id:string,range:PerformanceRange)=>Promise<StrategyMarker[]>}},
 cryptoModel?:ReturnType<typeof createCryptoModel>['read'],
){
 /** The series service fills ten symbols per call; ask again while it is still filling. */
 async function loadSeries(symbols:string[],range:PriceRange):Promise<SymbolSeries[]>{
  const accountId=await selectedAccountId();
  if(accountId===null||symbols.length===0)return [];
  const result:SymbolSeries[]=[];
  for(let start=0;start<symbols.length;start+=50){
   const request={accountId,range,symbols:symbols.slice(start,start+50)};
   let market=await series(request);
   for(let attempt=0;market.pendingSymbols.length>0&&attempt<10;attempt++)market=await series(request);
   result.push(...market.series);
  }
  return result;
 }
 const loadCloses=async(symbols:string[],range:PerformanceRange)=>(await storedCloses(symbols,range).catch(()=>null))??dailyClosesFromSeries(await loadSeries(symbols,seriesRangeFor(range)));

 async function load(db:Pick<PGlite,'query'>,strategyId:string){
  const strategy=(await db.query<{current:string|null;draft:BasketSpec|null}>(`SELECT s.current_version_id AS current,p.payload->'spec' AS draft
   FROM strategies s LEFT JOIN strategy_proposals p ON p.id=s.draft_revision_id WHERE s.id=$1`,[strategyId])).rows[0];
  if(!strategy)return null;
  const versions=(await db.query<{id:string;sequence:number;spec:BasketSpec;createdAt:Date}>(`SELECT id,sequence,spec,coalesce((SELECT (d.effective_on::text||'T17:00:00Z')::timestamptz FROM strategy_version_effective_dates d WHERE d.version_id=strategy_versions.id),strategy_versions.created_at) AS "createdAt"
   FROM strategy_versions WHERE strategy_id=$1 ORDER BY sequence`,[strategyId])).rows;
  const allocations=(await db.query<{id:string}>(`SELECT id FROM strategy_allocations WHERE strategy_id=$1 AND status IN ${UNRELEASED_OR_DETACHED} ORDER BY created_at,id`,[strategyId])).rows;
  const ledgers:Ledger=new Map();
  for(const allocation of allocations){
   const loaded=await loadAllocationEntries(db,allocation.id);
   // Traded: at least one entry with a symbol, as hosted counts an investor bucket.
   if(loaded&&loaded.entries.some(e=>e.symbol!==null))ledgers.set(allocation.id,loaded.entries);
  }
  return {versions,draft:strategy.draft,ledgers};
 }

 const performance=async(rawStrategyId:unknown,rawRange:unknown,rawBasis:unknown):Promise<StrategyPerformance|null>=>{
  if(typeof rawStrategyId!=='string'||!RANGES.includes(rawRange as PerformanceRange)||(rawBasis!=='model'&&rawBasis!=='actual'))throw new Error('Invalid performance request');
  const strategyId=rawStrategyId,range=rawRange as PerformanceRange,basis=rawBasis as PerformanceBasis;
  const loaded=await database.use(db=>load(db,strategyId));
  if(!loaded)return null;
  const latest=loaded.versions.at(-1)?.spec??loaded.draft;
  if(!latest)return null;
  if(hasRobinhoodCrypto(latest)&&cryptoModel){
   const version=loaded.versions.at(-1),accountId=await selectedAccountId();
   const result=version&&accountId?await database.use(q=>cryptoModel(q,accountId,version)):null;
   const ready=result?.ready===true&&basis==='model';
   const start=rangeStartDay(range,new Date(clock()));
   const rows=ready?[...result.rows.filter(row=>row.valuedOn!==result.current.valuedOn),result.current]:[];
   const stat=ready?performanceStat('live',[...result.rows,result.current]):null;
   const reasons={unsupported_basket:'This combination of assets is not supported yet.',baseline_pending:'Waiting for the first complete Robinhood prices.',quotes_unavailable:'Waiting for fresh Robinhood prices.',routing_changed:'Robinhood pricing routing changed. The saved model has been preserved.',history_gap:'A price needed for a past rebalance is missing.'};
   return {strategyId,range,basis,actualAvailable:false,actualSince:null,investors:0,intraday:null,
    rebalance:latest.rebalance,lastRebalancedAt:null,dividends:'excluded',
    unavailableReason:ready?undefined:basis==='actual'?'Crypto actual performance is not available yet.':reasons[result&&!result.ready?result.reason:'baseline_pending'],
    points:rows.filter(row=>start===null||row.valuedOn>=start).map(row=>({day:row.valuedOn,unitValue:row.unitValue,source:row.source})),
    stats:stat?[{...stat,startedAt:result&&result.ready?result.baselineAt:stat.startedAt}]:[]};
  }
  if(hasPendingInstrumentSupport(latest)||loaded.versions.some(v=>hasPendingInstrumentSupport(v.spec)))return null;
  if (!supportsBasketExecution(latest) || loaded.versions.some(version => !supportsBasketExecution(version.spec))) {
   if(latest.target.weights.every(w=>w.instrument.venue==='coinbase')&&loaded.versions.every(v=>v.spec.target.weights.every(w=>w.instrument.venue==='coinbase')))return coinbase?.performance(strategyId,range,latest,basis,loaded.versions)??null;
   if(latest.target.weights.every(w=>['coinbase','robinhood'].includes(w.instrument.venue))&&coinbase?.mixed)return coinbase.mixed.performance(strategyId,range,latest,basis,loaded.versions);
   return null;
  }
  const rebalance:Rebalance=latest.rebalance;
  const fills=[...loaded.ledgers.values()].flat().filter(e=>e.symbol!==null).map(e=>e.occurredAt).sort();
  const base={strategyId,range,actualAvailable:loaded.ledgers.size>0,actualSince:fills[0]??null,rebalance,lastRebalancedAt:null};
  const now=new Date(clock());
  const startDay=rangeStartDay(range,now);

  if(basis==='actual'&&loaded.ledgers.size>0){
   if(range==='1d'){
    const today=easternDateOf(now.toISOString());
    const dayStartUtc=new Date(Date.parse(easternDayEndUtc(today))-86_400_000).toISOString();
    const held=new Map<string,number>();
    for(const entry of [...loaded.ledgers.values()].flat())if(entry.symbol!==null)held.set(entry.symbol.toUpperCase(),(held.get(entry.symbol.toUpperCase())??0)+Number(entry.quantityDelta??0));
    const symbols=[...held].filter(([,quantity])=>quantity>0).map(([symbol])=>symbol).sort();
    const line=symbols.length===0?null:actualIntradayLine(loaded.ledgers,await loadSeries(symbols,'1d'),dayStartUtc);
    const last=line?.points.at(-1);
    const change=last===undefined?null:(Number(last.c)-100).toFixed(2);
    return {...base,basis,investors:line?.investors??loaded.ledgers.size,dividends:'excluded',points:[],
     intraday:line===null?null:{sessionDate:line.sessionDate,dayStart:line.dayStart,dayEnd:line.dayEnd,points:line.points},
     stats:last===undefined?[]:[{source:'live',asOf:last.t,startedAt:null,allTimeReturnPercent:change,oneDayReturnPercent:change}]};
   }
   const symbols=[...new Set([...loaded.ledgers.values()].flat().flatMap(e=>e.symbol===null?[]:[e.symbol.toUpperCase()]))].sort();
   const points=actualLine(loaded.ledgers,await loadCloses(symbols,range),startDay);
   const stat=performanceStat('live',points.map(p=>({valuedOn:p.day,unitValue:p.unitValue})));
   return {...base,basis,investors:loaded.ledgers.size,intraday:null,dividends:'excluded',points,stats:stat===null?[]:[stat]};
  }

  // Model: committed versions take effect on their commit day; a strategy
  // with nothing committed backtests its draft and is never live.
  const allocations=loaded.versions.length
   ?loaded.versions.map(v=>({id:v.id,sequence:v.sequence,...weightsOf(v.spec),effectiveOn:easternDateOf(new Date(v.createdAt).toISOString())}))
   :[{id:'draft',sequence:0,...weightsOf(latest),effectiveOn:'9999-12-31'}];
  const symbols=[...new Set(allocations.flatMap(a=>a.weights.map(w=>w.symbol)))].sort();
  const [closesBySymbol,dividendYieldPercent,delisted]=await Promise.all([loadCloses(symbols,range),fundamentals(symbols).then(dividendYields).catch(()=>new Map<string,number>()),database.use(db=>delistedMarks(db,symbols))]);
  const today=easternDateOf(now.toISOString());
  const days=tradingDays(closesBySymbol).filter(day=>day<=today&&(startDay===null||day>=startDay));
  // Rebalance days come from the range's own calendar, as hosted backtests do.
  const computed=computeModelValuations({allocations,closesBySymbol,days,rebalanceDays:scheduledRebalanceDays(days,rebalance.schedule),driftBands:rebalance,dividendYieldPercent,delisted});
  const stat=performanceStat(computed.some(row=>row.source==='live')?'live':'backtested',computed);
  return {...base,basis:'model',investors:0,intraday:null,
   dividends:dividendYieldPercent.size>0?'reinvested_at_current_yield':'excluded',
   points:computed.map(row=>({day:row.valuedOn,unitValue:row.unitValue,source:row.source,prices:Object.fromEntries(Object.entries(row.closes).map(([symbol,close])=>[symbol,Number(close)]))})),stats:stat===null?[]:[stat]};
 };
 async function markers(rawStrategyId:unknown,rawRange:unknown):Promise<StrategyMarker[]>{
  if(typeof rawStrategyId!=='string'||!RANGES.includes(rawRange as PerformanceRange))throw new Error('Invalid markers request');
  const loaded=await database.use(db=>load(db,rawStrategyId));
  if(!loaded)return [];
  const spec=loaded.versions.at(-1)?.spec??loaded.draft;
  if(spec?.target.weights.every(w=>w.instrument.venue==='coinbase')&&coinbase)return coinbase.markers(rawStrategyId,rawRange as PerformanceRange);
  if(spec?.target.weights.some(w=>w.instrument.venue==='coinbase')&&spec.target.weights.some(w=>w.instrument.venue==='robinhood')&&coinbase?.mixed)return coinbase.mixed.markers(rawStrategyId,rawRange as PerformanceRange);
  return ownMarkers(loaded.ledgers,rangeStartDay(rawRange as PerformanceRange,new Date(clock())));
 }
 return {performance,markers};
}
