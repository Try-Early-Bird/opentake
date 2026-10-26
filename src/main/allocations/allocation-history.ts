import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import type {MarketSeries,PriceRange,SymbolSeries} from '../../shared/market-series';
import type {AllocationHistory,AllocationHistoryRange} from '../../shared/portfolio';
import {amount,format} from './ledger';
import type {ImportMapping} from './portfolio-import';
import {seriesIntervalMilliseconds} from '../market-series/series';
import {easternClock,easternWallTimeToUtc} from '../market-series/sessions';

// An allocation's value over time,
// rebuilt on read from its attribution ledger and daily closes. Imported
// allocations replay the immutable source ledger, then the local entries
// recorded since; the import's opening claims restate that same source
// balance, so they are skipped rather than counted twice.

export interface LedgerEntry {entryType:string;symbol:string|null;quantityDelta:string|null;cashDelta:string|null;occurredAt:string}
type Entry=LedgerEntry;
export interface DailyClose {day:string;close:string}
const SCALE=10n**18n;

const signed=(value:string|null)=>value===null?0n:amount(value);

function tradingDayOf(timestamp:string,interval:SymbolSeries['interval']):string{
 return seriesIntervalMilliseconds[interval]>=86_400_000?new Date(timestamp).toISOString().slice(0,10):easternClock(Date.parse(timestamp)).date;
}

/** One close per Eastern trading day: the last regular bar, or the last bar of any session when the day has none. */
export function dailyClosesFromSeries(series:readonly SymbolSeries[]):Map<string,DailyClose[]>{
 const result=new Map<string,DailyClose[]>();
 for(const item of series){
  const byDay=new Map<string,{close:string;regular:boolean}>();
  for(const point of item.points){
   const day=tradingDayOf(point.t,item.interval),regular=point.s==='regular',current=byDay.get(day);
   if(current===undefined||regular||!current.regular)byDay.set(day,{close:point.c,regular});
  }
  result.set(item.symbol.toUpperCase(),[...byDay].sort(([a],[b])=>a.localeCompare(b)).map(([day,v])=>({day,close:v.close})));
 }
 return result;
}

/** Values the allocation at the close of each day; days an attributed symbol has no close yet are skipped. */
export function computeAllocationHistory(input:{entries:readonly Entry[];closesBySymbol:ReadonlyMap<string,readonly DailyClose[]>;days:readonly string[]}):{day:string;totalValue:string;capitalAllocated:string}[]{
 const entries=[...input.entries].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
 const closeOn=(symbol:string,day:string)=>{
  let last:DailyClose|undefined;
  for(const close of input.closesBySymbol.get(symbol)??[]){if(close.day>day)break;last=close;}
  return last===undefined?null:amount(last.close);
 };
 let cursor=0,cash=0n,capital=0n;const quantities=new Map<string,bigint>();const points:{day:string;totalValue:string;capitalAllocated:string}[]=[];
 for(const day of input.days){
  const cutoff=easternWallTimeToUtc(day,24*60);
  while(cursor<entries.length&&Date.parse(entries[cursor]!.occurredAt)<=cutoff){
   const entry=entries[cursor++]!;
   cash+=signed(entry.cashDelta);
   if(entry.entryType==='capital_allocated'||entry.entryType==='capital_released')capital+=signed(entry.cashDelta);
   if(entry.symbol!==null&&entry.quantityDelta!==null)quantities.set(entry.symbol,(quantities.get(entry.symbol)??0n)+signed(entry.quantityDelta));
  }
  if(cursor===0)continue;
  let positionsValue=0n,complete=true;
  for(const [symbol,quantity] of quantities){
   if(quantity===0n)continue;
   const close=closeOn(symbol,day);
   if(close===null){complete=false;break;}
   positionsValue+=quantity*close/SCALE;
  }
  if(complete)points.push({day,totalValue:format(cash+positionsValue),capitalAllocated:format(capital)});
 }
 return points;
}

/** The allocation's whole ledger: the imported source entries, then local ones since (opening claims skipped). */
export async function loadAllocationEntries(db:Pick<PGlite,'query'>,allocationId:string):Promise<{accountId:string;entries:Entry[]}|null>{
 const allocation=(await db.query<{accountId:string}>(`SELECT account_id AS "accountId" FROM strategy_allocations WHERE id=$1`,[allocationId])).rows[0];
 if(!allocation)return null;
 const local=(await db.query<Entry>(`SELECT e.entry_type AS "entryType",coalesce(e.symbol,(SELECT max(x.symbol) FROM strategy_attribution_entries x WHERE x.allocation_id=e.allocation_id AND x.instrument_ref=e.instrument_ref)) AS symbol,
  e.quantity_delta::text AS "quantityDelta",e.cash_delta::text AS "cashDelta",e.occurred_at AS "occurredAt"
  FROM strategy_attribution_entries e WHERE e.allocation_id=$1 AND e.source_kind<>'development_import' ORDER BY e.sequence`,[allocationId])).rows;
 const saved=(await db.query<{source_data:{allocations:{id:string;entries:Entry[]}[]};mapping:ImportMapping}>(`SELECT source_data,mapping FROM strategy_portfolio_imports WHERE account_id=$1`,[allocation.accountId])).rows[0];
 const source=saved?.source_data.allocations.find(a=>saved.mapping.allocations[a.id]===allocationId)?.entries??[];
 return {accountId:allocation.accountId,entries:[...source,...local].map(e=>({...e,occurredAt:new Date(e.occurredAt).toISOString()}))};
}

function rangeStartDay(range:AllocationHistoryRange,now:Date):string|null{
 if(range==='all')return null;
 const months=range==='1m'?1:range==='3m'?3:12;
 return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-months,now.getUTCDate())).toISOString().slice(0,10);
}

export function createAllocationHistory(
 database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,
 series:(request:{accountId:string;range:PriceRange;symbols?:string[]})=>Promise<MarketSeries>,
 clock=()=>Date.now(),
 /** The local price store: daily closes when it covers the range, else null and a live read is made. */
 storedCloses:(symbols:string[],range:AllocationHistoryRange)=>Promise<Map<string,DailyClose[]>|null>=async()=>null,
){
 return async(allocationId:unknown,range:unknown):Promise<AllocationHistory>=>{
  if(typeof allocationId!=='string'||!['1m','3m','1y','all'].includes(range as string))throw new Error('Invalid allocation history request');
  const historyRange=range as AllocationHistoryRange;
  const loaded=await database.use(db=>loadAllocationEntries(db,allocationId));
  if(!loaded||loaded.entries.length===0)return {allocationId,range:historyRange,points:[]};
  // The series service fills ten symbols per call; keep asking while it is
  // still filling so the history is complete on return, as the hosted read is.
  // Every symbol the ledger ever held, as the hosted read prices them, so a
  // holding sold since still values the days it was held.
  const symbols=[...new Set(loaded.entries.flatMap(e=>e.symbol===null?[]:[e.symbol.toUpperCase()]))].sort().slice(0,50);
  let closesBySymbol=await storedCloses(symbols,historyRange).catch(()=>null);
  if(closesBySymbol===null){
   const request={accountId:loaded.accountId,range:historyRange,...(symbols.length?{symbols}:{})};
   let market=await series(request);
   for(let attempt=0;market.pendingSymbols.length>0&&attempt<5;attempt++)market=await series(request);
   closesBySymbol=dailyClosesFromSeries(market.series);
  }
  const startDay=rangeStartDay(historyRange,new Date(clock()));
  const firstDay=[...loaded.entries].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))[0]!.occurredAt.slice(0,10);
  const days=[...new Set([...closesBySymbol.values()].flatMap(closes=>closes.map(c=>c.day)))].sort()
   .filter(day=>day>=firstDay&&(startDay===null||day>=startDay));
  return {allocationId,range:historyRange,points:computeAllocationHistory({entries:loaded.entries,closesBySymbol,days}).map(({day,totalValue})=>({day,totalValue}))};
 };
}
