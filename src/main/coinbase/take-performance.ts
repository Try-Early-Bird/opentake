import type {LiveCoinbasePrice} from './live-valuation';
import {loadAllocationEntries} from '../allocations/allocation-history';
import type {PriceRange,SymbolSeries} from '../../shared/market-series';
import type {createDatabaseLifecycle} from '../database';
import type {createCoinbasePriceCache} from './price-cache';
import type {BasketSpec} from '../../shared/strategies';
import type {PerformanceRange,StrategyPerformance,StrategyMarker} from '../../shared/strategy-performance';
import type {CoinbaseSpotPosition} from '../../shared/portfolio';
import {computeModelValuations,performanceStat,scheduledRebalanceDays} from '../strategies/model-valuation';
import type {DailyClose} from '../allocations/allocation-history';
import {rangeStartDay} from '../strategies/performance';

export interface TakeMovement {asset:string;quantity:string;kind:string;at:string}
export interface TakeMark {at:string;value:number;unitValue:number;netCapital:number}
/** Issue/redeem units only for external capital. Fill debits already include fees. */
export function valueTakeMovements(entries:TakeMovement[],times:string[],price:(asset:string,at:string)=>number|null):TakeMark[]{
 const sorted=[...entries].sort((a,b)=>a.at.localeCompare(b.at));
 const balances=new Map<string,number>();let cursor=0,units=0,netCapital=0,lastUnit=100;
 const result:TakeMark[]=[];
 const value=(at:string)=>{let total=0;for(const [asset,q] of balances){if(Math.abs(q)<1e-14)continue;const p=price(asset,at);if(p===null||!Number.isFinite(p)||p<=0)return null;total+=q*p;}return total;};
 for(const at of [...new Set([...times,...sorted.map(e=>e.at)])].sort()){
  const before=value(at);if(before===null)return [];
  let flow=0;
  while(cursor<sorted.length&&sorted[cursor].at<=at){const e=sorted[cursor++];const q=Number(e.quantity);
   if(e.kind==='capital'||e.kind==='release'){const p=price(e.asset,e.at);if(p===null)return [];flow+=q*p;}
   balances.set(e.asset,(balances.get(e.asset)??0)+q);
  }
  if([...balances.values()].some(q=>q < -1e-10))return [];
  const unit=units>1e-12?before/units:lastUnit;
  if(flow!==0){if(unit<=0)return [];units+=flow/unit;netCapital+=flow;}
  const after=value(at);if(after===null)return [];
  if(units>1e-12){lastUnit=after/units;result.push({at,value:after,unitValue:lastUnit,netCapital});}
 }
 return result;
}

export function createCoinbaseTakePerformance(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,prices:Pick<ReturnType<typeof createCoinbasePriceCache>,'candles'|'dailySpot'>,clock=Date.now,equities?:{series(strategyId:string,symbols:string[],range:PriceRange):Promise<SymbolSeries[]>},livePrice:LiveCoinbasePrice=()=>null){
 async function load(strategyId:string){return database.use(async db=>{
  const rows=(await db.query<TakeMovement & {allocationId:string}>(`SELECT e.asset,e.quantity::text,e.kind,e.occurred_at AS at,e.allocation_id AS "allocationId" FROM coinbase_allocation_entries e JOIN coinbase_allocations a ON a.id=e.allocation_id WHERE a.strategy_id=$1 ORDER BY e.occurred_at,e.id`,[strategyId])).rows;
  const entries=rows.map(e=>({...e,at:new Date(e.at).toISOString()}));
  let unsafe=(await db.query(`SELECT 1 FROM coinbase_allocations WHERE strategy_id=$1 AND (restore_required OR status='reconciliation_required')`,[strategyId])).rows.length>0;
  const observations=(await db.query<{observed_at:Date;data:{portfolio:{currency:string};spotPositions:CoinbaseSpotPosition[];warnings?:string[]}}>(`SELECT DISTINCT ON (o.account_id) o.observed_at,o.data FROM coinbase_portfolio_observations o JOIN coinbase_allocations a ON a.account_id=o.account_id WHERE a.strategy_id=$1 ORDER BY o.account_id,o.observed_at DESC,o.id DESC`,[strategyId])).rows;
  if(equities){
   const allocations=(await db.query<{id:string;restore_required:boolean;status:string}>('SELECT id,restore_required,status FROM strategy_allocations WHERE strategy_id=$1',[strategyId])).rows;
   for(const a of allocations){
    unsafe ||= a.restore_required||a.status==='diverged';
    const ledger=await loadAllocationEntries(db,a.id);
    for(const e of ledger?.entries??[]){
     const kind=e.entryType==='capital_allocated'?'capital':e.entryType==='capital_released'?'release':'fill';
     if(e.cashDelta&&Number(e.cashDelta)!==0)entries.push({allocationId:a.id,asset:'USD',quantity:e.cashDelta,kind,at:e.occurredAt});
     if(e.symbol&&e.quantityDelta&&Number(e.quantityDelta)!==0)entries.push({allocationId:a.id,asset:`robinhood:${e.symbol.toUpperCase()}`,quantity:e.quantityDelta,kind:e.entryType==='detachment'?'release':'fill',at:e.occurredAt});
    }
   }
   entries.sort((a,b)=>a.at.localeCompare(b.at));
  }
  return {entries,unsafe,observations};
 });}
 async function calculate(strategyId:string){
  const loaded=await load(strategyId),now=clock(),hour=3600000;
  if(!loaded.entries.length||loaded.unsafe)return {...loaded,marks:[] as TakeMark[],currentAt:null as string|null};
  const first=Date.parse(loaded.entries[0].at),step=now-first>90*86400000?86400000:hour;
  const start=Math.floor(first/step)*step-step,end=Math.floor(now/step)*step;
  const byAsset=new Map<string,{at:number;value:number}[]>();const times=new Set<string>();
  for(const asset of new Set(loaded.entries.map(e=>e.asset))){
   if(asset==='USD')continue;
   if(asset.startsWith('robinhood:')){
    const range:PriceRange=now-first>365*86400000?'all':now-first>90*86400000?'1y':now-first>30*86400000?'3m':now-first>7*86400000?'1m':'1w';
    const series=await equities!.series(strategyId,[asset.slice(10)],range);
    const points=series.flatMap(s=>s.points.map(p=>({at:Date.parse(p.t),value:Number(p.c)}))).sort((a,b)=>a.at-b.at);
    byAsset.set(asset,points);for(const p of points)if(p.at>=first)times.add(new Date(p.at).toISOString());
    continue;
   }
   const points:{at:number;value:number}[]=[];
   // USDC-USD is not an Advanced Trade candle product. Use the existing
   // cached daily spot fallback, available only for completed UTC dates.
   if(asset==='USDC'){
    try{for(let day=Math.floor(start/86400000)*86400000-86400000;day<Math.floor(now/86400000)*86400000;day+=86400000){
     const value=Number(await prices.dailySpot('USDC-USD',new Date(day).toISOString().slice(0,10)));
     if(!Number.isFinite(value)||value<=0)throw Error('Missing USDC rate');
     points.push({at:day+86400000,value});
    }}catch{return {...loaded,marks:[] as TakeMark[],currentAt:null as string|null};}
    byAsset.set(asset,points);continue;
   }
   try{for(let from=start;from<end;from+=350*step){
    const read=await prices.candles(`${asset}-USD`,new Date(from).toISOString(),new Date(Math.min(end,from+350*step)).toISOString(),step/1000);
    if(read.stale)return {...loaded,marks:[] as TakeMark[],currentAt:null as string|null};
    for(const c of read.candles){const at=Number(c.start)*1000+step;points.push({at,value:Number(c.close)});if(at>=first)times.add(new Date(at).toISOString());}
   }}catch{return {...loaded,marks:[] as TakeMark[],currentAt:null as string|null};}
   byAsset.set(asset,points.sort((a,b)=>a.at-b.at));
  }
  // Use fresh account marks for the endpoint, never their unrelated holdings.
  const current=new Map<string,number>();
  for(const o of loaded.observations){if(now-o.observed_at.getTime()>900000||o.observed_at.getTime()>now||o.data.warnings?.length||o.data.portfolio.currency!=='USD')continue;
   for(const p of o.data.spotPositions)if(p.currency==='USD'&&Number(p.quantity)>0){
    const live=p.isCash?null:livePrice(p.asset+'-USD');
    current.set(p.asset,live!==null&&Number.isFinite(Number(live))&&Number(live)>0?Number(live):Number(p.marketValue)/Number(p.quantity));
   }
  }
  if(equities){const symbols=[...byAsset.keys()].filter(s=>s.startsWith('robinhood:'));const quotes=await database.use(db=>db.query<{symbol:string;price:string}>('SELECT symbol,price::text FROM market_quotes WHERE symbol=ANY($1) AND observed_at BETWEEN $2 AND $3',[symbols.map(s=>s.slice(10)),new Date(now-900000).toISOString(),new Date(now).toISOString()]));for(const q of quotes.rows)current.set(`robinhood:${q.symbol}`,Number(q.price));}
  const held=new Map<string,number>();for(const e of loaded.entries)held.set(e.asset,(held.get(e.asset)??0)+Number(e.quantity));
  const currentAt=[...held].every(([asset,q])=>Math.abs(q)<1e-14||asset==='USD'||current.has(asset))?new Date(now).toISOString():null;
  if(currentAt)times.add(currentAt);
  const marks=valueTakeMovements(loaded.entries,[...times],(asset,at)=>{
   if(asset==='USD')return 1;
   const time=Date.parse(at);if(time===now&&current.has(asset))return current.get(asset)!;
   const point=byAsset.get(asset)?.filter(p=>p.at<=time).at(-1);
   return point&&time-point.at<=(asset.startsWith('robinhood:')?4*86400000:asset==='USDC'?86400000:step)?point.value:null;
  });
  return {...loaded,marks,currentAt};
 }
 async function model(strategyId:string,range:PerformanceRange,spec:BasketSpec,versions:{id:string;sequence:number;spec:BasketSpec;createdAt:Date}[]):Promise<StrategyPerformance>{
  const now=clock(),day=86400000,end=Math.floor(now/day)*day;
  const startDay=rangeStartDay(range==='1d'?'1m':range,new Date(now));
  const start=startDay?Date.parse(startDay):Date.UTC(2015,0,1);
  const allocations=versions.length?versions.map(v=>({id:v.id,sequence:v.sequence,weights:v.spec.target.weights.map(w=>({symbol:w.instrument.venue==='robinhood'?`robinhood:${w.instrument.symbol}`:w.instrument.symbol,weightPercent:w.bps/100})),cashPercent:v.spec.target.cashBps/100,effectiveOn:new Date(v.createdAt).toISOString().slice(0,10)})):[{id:'draft',sequence:0,weights:spec.target.weights.map(w=>({symbol:w.instrument.venue==='robinhood'?`robinhood:${w.instrument.symbol}`:w.instrument.symbol,weightPercent:w.bps/100})),cashPercent:spec.target.cashBps/100,effectiveOn:'9999-12-31'}];
  const closesBySymbol=new Map<string,DailyClose[]>();
  for(const symbol of new Set(allocations.flatMap(a=>a.weights.map(w=>w.symbol)))){
   const closes:DailyClose[]=[];
   if(symbol.startsWith('robinhood:')){
    const rows=await equities!.series(strategyId,[symbol.slice(10)],range==='3y'||range==='5y'?'all':range==='1d'?'1m':range);
    const byDay=new Map(rows.flatMap(s=>s.points.map(p=>[p.t.slice(0,10),{day:p.t.slice(0,10),close:p.c}] as const)));
    closesBySymbol.set(symbol,[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day)));continue;
   }
   for(let from=start;from<end;from+=350*day){
    const result=await prices.candles(`${symbol}-USD`,new Date(from).toISOString(),new Date(Math.min(end,from+350*day)).toISOString(),86400);
    if(result.stale)throw Error('Coinbase price history is temporarily unavailable.');
    for(const candle of result.candles)closes.push({day:new Date(Number(candle.start)*1000).toISOString().slice(0,10),close:candle.close});
   }
   closesBySymbol.set(symbol,closes.sort((a,b)=>a.day.localeCompare(b.day)));
  }
  // Crypto trades every day. Require a price on that day for every basket asset;
  // never fill a missing candle with an old price to invent a flat return.
  const days=[...new Set([...closesBySymbol.values()].flatMap(rows=>rows.map(r=>r.day)))].filter(date=>[...closesBySymbol.values()].every(rows=>rows.some(r=>r.day===date))).sort();
  const computed=computeModelValuations({allocations,closesBySymbol,days,rebalanceDays:scheduledRebalanceDays(days,spec.rebalance.schedule),driftBands:spec.rebalance});
  const stat=performanceStat(computed.some(p=>p.source==='live')?'live':'backtested',computed);
  const {entries}=await load(strategyId),firstFill=entries.find(e=>e.kind==='fill');
  return {strategyId,range,basis:'model',actualAvailable:!!firstFill,actualSince:firstFill?.at??null,investors:0,rebalance:spec.rebalance,lastRebalancedAt:null,dividends:'excluded',intraday:null,points:computed.map(p=>({day:p.valuedOn,unitValue:p.unitValue,source:p.source})),stats:stat?[stat]:[]};
 }
 const pending=new Map<string,Promise<Awaited<ReturnType<typeof calculate>>>>();
 async function read(id:string){let work=pending.get(id);if(!work){work=calculate(id);pending.set(id,work);try{return await work;}finally{pending.delete(id);}}return work;}
 return {
  async summary(strategyId:string){const {marks,currentAt}=await read(strategyId),last=marks.at(-1);return last&&last.at===currentAt?{gain:String(last.value-last.netCapital),returnPercent:last.netCapital>0?String((last.value-last.netCapital)/last.netCapital*100):null,currency:'USD'}:null;},
  async performance(strategyId:string,range:PerformanceRange,spec:BasketSpec,basis:'actual'|'model'='actual',versions:{id:string;sequence:number;spec:BasketSpec;createdAt:Date}[]=[]):Promise<StrategyPerformance>{
   if(basis==='model')return model(strategyId,range,spec,versions);
   const {entries,marks,unsafe}=await read(strategyId),firstFill=entries.find(e=>e.kind==='fill');
   const since=range==='1d'?clock()-86400000:rangeStartDay(range,new Date(clock()));
   const start=typeof since==='number'?since:since?Date.parse(since):0;
   const visible=marks.filter(p=>Date.parse(p.at)>=start);
   const prior=marks.filter(p=>Date.parse(p.at)<start).at(-1),base=prior?.unitValue??100;
   const points=visible.map(p=>({t:p.at,c:String(p.unitValue/base*100),s:'regular' as const}));
   const last=marks.at(-1);
   return {unavailableReason:marks.length?undefined:unsafe?'This Take needs reconciliation before performance can be calculated.':!firstFill?'Actual performance starts after the first trade fills.':equities?'Price history from both platforms is required for this Take.':'Coinbase price history is incomplete for this Take.',strategyId,range,basis:'actual',actualAvailable:!!firstFill,actualSince:firstFill?.at??null,investors:new Set(entries.map(e=>e.allocationId)).size,rebalance:spec.rebalance,lastRebalancedAt:null,dividends:'excluded',points:range==='1d'?[]:[...new Map(visible.map(p=>[p.at.slice(0,10),{day:p.at.slice(0,10),unitValue:String(p.unitValue/base*100),source:'live' as const}])).values()],
    intraday:points.length?{sessionDate:null,dayStart:points[0].t,dayEnd:points.at(-1)!.t,points}:null,
    stats:last?[{source:'live',asOf:last.at,startedAt:entries[0]?.at??null,allTimeReturnPercent:String(last.unitValue-100),oneDayReturnPercent:range==='1d'?String(Number(points.at(-1)?.c??100)-100):null}]:[]};
  },
  async markers(strategyId:string,range:PerformanceRange):Promise<StrategyMarker[]>{const {entries}=await load(strategyId);const start=range==='1d'?clock()-86400000:Date.parse(rangeStartDay(range,new Date(clock()))??'1970-01-01');let invested=false;return entries.flatMap(e=>{
   // Zero releases mark processed/cancelled attempts, not money moving out.
   if((e.kind!=='capital'&&e.kind!=='release')||Number(e.quantity)===0)return [];const kind=e.kind==='release'?'withdrew':invested?'deposit':'invested';if(e.kind==='capital')invested=true;
   if(Date.parse(e.at)<start)return [];return [{at:e.at,direction:kind==='withdrew'?'out' as const:'in' as const,party:'viewer' as const,members:1,amount:['USD','USDC'].includes(e.asset)?String(Math.abs(Number(e.quantity))):null,currency:e.asset,kinds:{[kind]:1}}];
  });}
 };
}
