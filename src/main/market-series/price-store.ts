import {trackedRobinhoodAssets} from '../assets/tracker';
import type {PriceFailureDetails} from '../../shared/price-diagnostics';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import type {createConnections} from '../connections';
import {ConnectionFailure} from '../connection-errors';
import {normalizeEquityHistoricals,normalizeEquityQuoteDetails} from './normalization';
import {easternClock,isTradingDay,shiftEasternDate,regularCloseMinutes} from './sessions';
import type {DailyClose} from '../allocations/allocation-history';
import type {SymbolSeries} from '../../shared/market-series';
import type {SeriesCache} from './service';

// The self-hosted stand-in for the hosted market data cache: the background
// host polls the member's own Robinhood connection for the symbols that
// matter here (held, targeted by a strategy, or the default benchmark) and
// keeps the latest quote and a year of daily closes in the local database.
// Readers (strategy performance, allocation history) use the store and fall
// back to a live read for anything it does not yet cover. Polling yields to
// any other connection work: a busy connection skips the tick.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Connections=Pick<ReturnType<typeof createConnections>,'status'|'readTool'>;
const SLICE=10;
const HISTORY_DAYS=370;
export const DEFAULT_BENCHMARK='SPY';
export class PriceRefreshFailure extends Error{constructor(readonly details:PriceFailureDetails){super(`Robinhood ${details.operation}: ${details.errorCode}`);}}
const TICKER=/^[A-Z][A-Z0-9.-]{0,11}$/u;

/** The newest Eastern trading day whose regular session has closed. */
export function newestSettledTradingDay(nowMs:number):string{
 const clock=easternClock(nowMs);
 let day=clock.date;
 if(!isTradingDay(day)||clock.minutesOfDay<regularCloseMinutes(day)){day=shiftEasternDate(day,-1);while(!isTradingDay(day))day=shiftEasternDate(day,-1);}
 return day;
}

/** How long quotes may age before the next poll: fast while the member watches during the session. */
export function quoteInterval(nowMs:number,engaged:boolean):number{
 const clock=easternClock(nowMs);
 const trading=isTradingDay(clock.date),minutes=clock.minutesOfDay;
 const regular=trading&&minutes>=570&&minutes<regularCloseMinutes(clock.date),extended=trading&&minutes>=240&&minutes<1200;
 return regular?(engaged?60_000:300_000):extended?(engaged?300_000:900_000):3_600_000;
}

export function createPriceStore(database:Database,connections:Connections,clock=()=>Date.now(),
 /** Rebuilds today's chart series for the held symbols, so charts open on fresh data. */
 warm:(held:string[])=>Promise<void>=async()=>{},
 /** Equities on lists the member viewed recently: quoted with the rest, but they never pull daily-close history. */
 listed:()=>string[]=()=>[],
){
 let operation:PriceFailureDetails['operation']='account_status',activeSymbols:string[]=[];
 let lastQuotes=0,lastCloses=0,lastWarm=0,running:Promise<void>|undefined;

 /** Held equities, every strategy target and ledger symbol, and the default benchmark. */
 async function watched(db:Pick<PGlite,'query'>):Promise<string[]>{
  const assets=await trackedRobinhoodAssets(db);
  return [...new Set([DEFAULT_BENCHMARK,...assets.filter(a=>a.identity.kind==='equity').map(a=>a.symbol).filter(s=>TICKER.test(s))])].sort();
 }

 async function heldSymbols(db:Pick<PGlite,'query'>):Promise<string[]>{
  const assets=await trackedRobinhoodAssets(db);
  return assets.filter(a=>a.identity.kind==='equity'&&a.reasons.includes('holding')).map(a=>a.symbol).filter(s=>TICKER.test(s)).sort().slice(0,50);
 }

 async function refreshQuotes(symbols:string[]){
  const now=new Date(clock()).toISOString();
  for(let start=0;start<symbols.length;start+=SLICE){
   operation='quotes';activeSymbols=symbols.slice(start,start+SLICE);
   const quotes=normalizeEquityQuoteDetails(await connections.readTool('get_equity_quotes',{symbols:symbols.slice(start,start+SLICE)},undefined,AbortSignal.timeout(20_000)));
   await database.use(async db=>{
    for(const [symbol,q] of quotes){
     if(!TICKER.test(symbol)||q.lastTradePrice===undefined)continue;
     await db.query(`INSERT INTO market_quotes(symbol,price,previous_close,extended_price,last_trade_at,observed_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(symbol) DO UPDATE SET price=excluded.price,previous_close=excluded.previous_close,extended_price=excluded.extended_price,last_trade_at=excluded.last_trade_at,observed_at=excluded.observed_at,price_provider='robinhood',price_source_id=NULL,price_source_revision=NULL,price_source_feed=NULL`,
      [symbol,q.lastTradePrice,q.previousClose??null,q.lastExtendedTradePrice??null,q.lastTradeAt??null,now]);
    }
   });
  }
 }

 /** Tops up each symbol's daily closes to the newest settled session; a new symbol gets a year. */
 async function refreshCloses(symbols:string[]){
  operation='daily_closes';activeSymbols=symbols;
  const nowMs=clock(),settled=newestSettledTradingDay(nowMs),now=new Date(nowMs).toISOString();
  const latest=new Map((await database.use(db=>db.query<{symbol:string;day:string}>(`SELECT symbol,max(day)::text AS day FROM market_daily_closes WHERE symbol=ANY($1) GROUP BY symbol`,[symbols]))).rows.map(r=>[r.symbol,r.day]));
  const behind=symbols.filter(s=>(latest.get(s)??'')<settled);
  // Group by fetch start so one request covers symbols in the same state.
  const groups=new Map<string,string[]>();
  for(const symbol of behind){
   const last=latest.get(symbol);
   // Re-read a week before the last stored day: provisional bars settle, splits adjust.
   const from=last===undefined?new Date(nowMs-HISTORY_DAYS*86_400_000).toISOString():new Date(Date.parse(`${last}T00:00:00Z`)-7*86_400_000).toISOString();
   const key=last===undefined?'full':from;
   groups.set(key,[...(groups.get(key)??[]),symbol]);
  }
  for(const [key,group] of groups){
   const start=key==='full'?new Date(nowMs-HISTORY_DAYS*86_400_000).toISOString():key;
   for(let i=0;i<group.length;i+=SLICE){
    const slice=group.slice(i,i+SLICE);
    activeSymbols=slice;
    const bars=normalizeEquityHistoricals(await connections.readTool('get_equity_historicals',{symbols:slice,start_time:start,interval:'day',bounds:'regular',adjustment_type:'split'},undefined,AbortSignal.timeout(30_000)));
    await database.use(async db=>{
     for(const [symbol,list] of bars){
      if(!slice.includes(symbol))continue;
      for(const bar of list){
       const day=bar.beginsAt.slice(0,10);
       // Only settled sessions: today's daily bar is provisional until the close.
       if(day>settled||!(Number(bar.close)>0))continue;
       await db.query(`INSERT INTO market_daily_closes(symbol,day,close,observed_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(symbol,day) DO UPDATE SET close=excluded.close,observed_at=excluded.observed_at`,[symbol,day,bar.close,now]);
      }
     }
    });
   }
  }
 }

 async function poll(engaged:boolean){
  const nowMs=clock();
  operation='account_status';activeSymbols=[];
  try{
  const state=await connections.status();
  if(state.status!=='connected'||!state.accounts.some(a=>a.selected&&a.agenticAllowed))return;
  operation='watchlist_load';
  const symbols=await database.use(watched);
   if(nowMs-lastQuotes>=quoteInterval(nowMs,engaged)){await refreshQuotes([...new Set([...symbols,...listed().filter(s=>TICKER.test(s))])]);lastQuotes=nowMs;}
   if(nowMs-lastWarm>=quoteInterval(nowMs,engaged)){
    operation='chart_series';activeSymbols=[];
    const held=await database.use(heldSymbols);activeSymbols=held;
    if(held.length)await warm(held);
    lastWarm=nowMs;
   }
   // Closes change once a day; look hourly so a missed evening still catches up.
   if(nowMs-lastCloses>=3_600_000){await refreshCloses(symbols);lastCloses=nowMs;}
  }catch(error){
   // Another connection task is running; try on the next tick.
   if(error instanceof ConnectionFailure&&error.code==='busy')return;
   const errorCode=error instanceof ConnectionFailure?error.code:error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'timeout':'unknown';
   throw new PriceRefreshFailure({venue:'robinhood',operation,symbols:activeSymbols,errorCode:errorCode==='busy'?'transient':errorCode});
  }
 }

 /** The chart series cache, persisted (see seriesCacheMigration). */
 const seriesCache:SeriesCache={
  async load(range,symbols){
   const rows=(await database.use(db=>db.query<{symbol:string;fetched_at:Date;series:SymbolSeries}>(`SELECT symbol,fetched_at,series FROM market_series_cache WHERE range=$1 AND symbol=ANY($2)`,[range,[...symbols]]))).rows;
   return new Map(rows.map(r=>[r.symbol,{at:new Date(r.fetched_at).getTime(),series:r.series}]));
  },
  async save(range,entries){
   if(!entries.length)return;
   await database.use(async db=>{for(const e of entries)await db.query(`INSERT INTO market_series_cache(symbol,range,fetched_at,series) VALUES($1,$2,$3,$4)
    ON CONFLICT(range,symbol) DO UPDATE SET fetched_at=excluded.fetched_at,series=excluded.series`,[e.symbol,range,new Date(e.at).toISOString(),JSON.stringify(e.series)]);});
  },
 };

 return {
  /** One polling pass; concurrent calls share it. Errors other than a busy connection surface to the caller. */
  tick(engaged=false):Promise<void>{
   if(!running)running=poll(engaged).finally(()=>{running=undefined;});
   return running;
  },
  watched:()=>database.use(watched),
  seriesCache,
  /** Stored daily closes per symbol from `fromDay` (inclusive). */
  async closes(symbols:readonly string[],fromDay:string|null,query?:Pick<PGlite,'query'>):Promise<Map<string,DailyClose[]>>{
   const read=(db:Pick<PGlite,'query'>)=>db.query<{symbol:string;day:string;close:string}>(`SELECT symbol,day::text AS day,close::text AS close FROM market_daily_closes
    WHERE symbol=ANY($1) AND ($2::date IS NULL OR day>=$2::date) ORDER BY symbol,day`,[[...symbols],fromDay]);
   const rows=(await (query?read(query):database.use(read))).rows;
   const result=new Map<string,DailyClose[]>();
   for(const row of rows)result.set(row.symbol,[...(result.get(row.symbol)??[]),{day:row.day,close:row.close.replace(/\.?0+$/u,'')}]);
   return result;
  },
  /** Whether every symbol has closes back to `fromDay` and up to the newest settled session. */
  async covers(symbols:readonly string[],fromDay:string):Promise<boolean>{
   if(symbols.length===0)return true;
   const settled=newestSettledTradingDay(clock());
   const rows=(await database.use(db=>db.query<{symbol:string;first:string;last:string}>(`SELECT symbol,min(day)::text AS first,max(day)::text AS last FROM market_daily_closes WHERE symbol=ANY($1) GROUP BY symbol`,[[...symbols]]))).rows;
   // A week of slack at the start: the store's year begins on a trading day near it.
   const start=shiftEasternDate(fromDay,7);
   return symbols.every(s=>{const r=rows.find(row=>row.symbol===s);return r!==undefined&&r.first<=start&&r.last>=settled;});
  },
 };
}
