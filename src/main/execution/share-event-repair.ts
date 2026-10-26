import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import {normalizeEquityHistoricals} from '../market-series/normalization';
import {easternClock,easternWallTimeToUtc,shiftEasternDate} from '../market-series/sessions';
import {amount,append,instruction,unreleased} from '../allocations/ledger';
import {decimalToScaledInteger,scaledIntegerToDecimal} from '../allocations/decimal';
import type {DailyClose} from '../strategies/model-valuation';
import {readShareEvents} from './share-events';
import {observeDelistings,type DelistingMark} from './delistings';
import {lastCompletedTradingDay} from './planner';

// Share-count events for the self-hosted app. Once a trading day, every symbol a live allocation holds or
// targets is read from Robinhood's raw and split-adjusted daily closes. A new
// step is recorded once per symbol and day:
// - A forward split is arithmetic Robinhood already did to the account, so
//   it is applied at once: each allocation holding shares bought before the
//   event gets one `corporate_action` entry restating its share count (the
//   money and cost basis do not change), as hosted does.
// - A reverse split, or a step that is not a simple fraction, may have paid
//   cash in lieu of a fractional share, and only Robinhood knows. Hosted held
//   those for an operator; here the member is the operator (owner decision
//   2026-10-05): the allocations holding the symbol pause with a card, and the
//   member applies the reverse split or dismisses the reading after checking
//   Robinhood. Anything the account then disagrees with is an ordinary
//   reconciliation difference.
// Every event purges the symbol's stored closes and chart series, which are
// refreshed incrementally and would otherwise mix share bases. A newest bar
// that looks like a split Robinhood has not adjusted for yet, or a failed
// read, holds planning for allocations touching that symbol until the next
// check (hosted's split_unconfirmed and share_check_failed).

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<PGlite,'query'>;
type ReadTool=(name:string,args:Record<string,unknown>)=>Promise<unknown>;

const HISTORICALS_BATCH=10;
/** Days fetched before a window's first day, so the step into that day can be read. */
const LEAD_DAYS=10;
/** How far back a symbol with no attributed shares (a target only) is first checked. */
const TARGET_LOOKBACK_DAYS=30;
/** The planning reason on an allocation paused for a share-count event. */
export const SHARE_EVENT_PAUSE='share_event';

export interface ShareEventRow {
 id:string;symbol:string;effectiveOn:string;kind:'split'|'unclassified';status:'pending_review'|'applied'|'dismissed';
 splitTo:number|null;splitFrom:number|null;observedStep:string;
}
interface Row {id:string;symbol:string;effective_on:string|Date;kind:'split'|'unclassified';status:'pending_review'|'applied'|'dismissed';split_to:number|null;split_from:number|null;observed_step:string;details:Record<string,unknown>}
const day=(value:string|Date)=>typeof value==='string'?value.slice(0,10):value.toISOString().slice(0,10);
const present=(r:Row):ShareEventRow=>({id:r.id,symbol:r.symbol,effectiveOn:day(r.effective_on),kind:r.kind,status:r.status,splitTo:r.split_to,splitFrom:r.split_from,observedStep:r.observed_step});

/** The share-count change a split makes to a holding. */
export function splitQuantityDelta(attributedBefore:string,factor:{splitTo:number;splitFrom:number}):string{
 const before=decimalToScaledInteger(attributedBefore);
 const delta=before*BigInt(factor.splitTo)/BigInt(factor.splitFrom)-before;
 return delta<0n?`-${scaledIntegerToDecimal(-delta)}`:scaledIntegerToDecimal(delta);
}

/** Symbols whose newest reading is unsettled or unread: planning waits for the next check. */
export async function heldSymbols(db:Query):Promise<Set<string>>{
 return new Set((await db.query<{symbol:string}>(`SELECT symbol FROM share_event_checks WHERE failed OR unconfirmed_on IS NOT NULL`)).rows.map(r=>r.symbol));
}

/** Purges a symbol's stored closes and chart series so they refill on one share basis. */
async function purge(tx:Query,symbol:string):Promise<void>{
 await tx.query('DELETE FROM market_daily_closes WHERE symbol=$1',[symbol]);
 await tx.query('DELETE FROM market_series_cache WHERE symbol=$1',[symbol]);
}

/** Allocations holding `symbol` from before the event, with what they held then. */
async function holding(tx:Query,symbol:string,effectiveOn:string){
 const cutoff=new Date(easternWallTimeToUtc(effectiveOn,0)).toISOString();
 return (await tx.query<{allocation_id:string;status:string;instrument_ref:string;before:string}>(`SELECT e.allocation_id,a.status,max(e.instrument_ref) AS instrument_ref,
  coalesce(sum(e.quantity_delta) FILTER (WHERE e.occurred_at<$2),0)::text AS before
  FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
  WHERE a.status IN ${unreleased} AND upper(e.symbol)=$1 GROUP BY e.allocation_id,a.status
  HAVING coalesce(sum(e.quantity_delta) FILTER (WHERE e.occurred_at<$2),0)>0 AND sum(e.quantity_delta)>0`,[symbol,cutoff])).rows;
}

/**
 * Restates each holding allocation's share count by the split factor, as one
 * `corporate_action` entry under a `corporate_action` instruction. Idempotent
 * per allocation and event.
 */
async function restate(tx:Transaction,event:ShareEventRow,now:string):Promise<number>{
 const factor={splitTo:event.splitTo!,splitFrom:event.splitFrom!};
 const occurredAt=new Date(easternWallTimeToUtc(event.effectiveOn,0)).toISOString();
 let written=0;
 for(const h of await holding(tx,event.symbol,event.effectiveOn)){
  const quantityDelta=splitQuantityDelta(h.before,factor);
  if(amount(quantityDelta)===0n)continue;
  const cause=`share-event:${event.id}`;
  const transactionId=await instruction(tx,{allocationId:h.allocation_id,kind:'corporate_action',cause},now);
  await append(tx,{allocationId:h.allocation_id,transactionId,entryType:'corporate_action',cause,instrumentRef:h.instrument_ref,symbol:event.symbol,quantityDelta,
   sourceKind:'share_event',sourceRef:event.id,occurredAt,metadata:{shareEventId:event.id,effectiveOn:event.effectiveOn,splitTo:factor.splitTo,splitFrom:factor.splitFrom,attributedBefore:h.before}},now);
  written+=1;
 }
 return written;
}

/** Pauses the active allocations holding the symbol, recording which, so a decision resumes exactly those. */
async function pauseHolders(tx:Transaction,event:ShareEventRow,now:string):Promise<string[]>{
 const paused:string[]=[];
 for(const h of await holding(tx,event.symbol,event.effectiveOn)){
  if(h.status!=='active')continue;
  const r=await tx.query(`UPDATE strategy_allocations SET status='paused',paused_at=$2,planning_reason_code=$3,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1 AND status='active'`,[h.allocation_id,now,SHARE_EVENT_PAUSE]);
  if((r.affectedRows??0)>0)paused.push(h.allocation_id);
 }
 return paused;
}

/** How long after a failed read the next tick may try again. */
const RETRY_AFTER_MS=10*60_000;

export function createShareEventTracker(database:Database,readTool:ReadTool,clock=()=>Date.now()){
 const iso=()=>new Date(clock()).toISOString();
 // One reading per Eastern day once every symbol was read; a failed read is retried ten minutes later.
 let lastRun:string|null=null,retryAt=0,delisted:DelistingMark[]=[];
 const read=readTool;

 /** Raw and split-adjusted daily closes per symbol, read in batches from one start day. */
 async function fetchCloses(symbols:string[],fromDay:string){
  const raw=new Map<string,DailyClose[]>(),adjusted=new Map<string,DailyClose[]>(),failed=new Set<string>();
  for(let i=0;i<symbols.length;i+=HISTORICALS_BATCH){
   const batch=symbols.slice(i,i+HISTORICALS_BATCH);
   for(const adjustment of ['none','split'] as const){
    try{
     const bars=normalizeEquityHistoricals(await read('get_equity_historicals',{symbols:batch,start_time:`${fromDay}T00:00:00.000Z`,interval:'day',bounds:'regular',adjustment_type:adjustment}));
     // Daily bars carry their trading day as the UTC date.
     for(const symbol of batch)(adjustment==='none'?raw:adjusted).set(symbol,(bars.get(symbol)??[]).filter(bar=>Number(bar.close)>0).map(bar=>({day:bar.beginsAt.slice(0,10),close:bar.close})));
    }catch{for(const symbol of batch)failed.add(symbol);}
   }
  }
  return {raw,adjusted,failed};
 }

 async function decide(tx:Transaction,event:Row,status:'applied'|'dismissed',now:string){
  const e=present(event);
  const restated=status==='applied'&&e.kind==='split'?await restate(tx,e,now):0;
  await purge(tx,e.symbol);
  await tx.query(`UPDATE symbol_share_events SET status=$2,decided_at=$3,updated_at=$3,details=details||$4::jsonb WHERE id=$1`,[e.id,status,now,JSON.stringify({decision:{status,at:now,restated}})]);
  // Resume what this event paused, unless another pending event still holds it.
  const paused=Array.isArray(event.details.paused)?event.details.paused as string[]:[];
  for(const id of paused){
   const other=(await tx.query(`SELECT 1 FROM symbol_share_events s WHERE s.status='pending_review' AND s.id<>$2 AND ($1::uuid)::text=ANY(SELECT jsonb_array_elements_text(s.details->'paused'))`,[id,e.id])).rows.length;
   if(!other)await tx.query(`UPDATE strategy_allocations SET status='active',paused_at=NULL,planning_reason_code=NULL,updated_at=$2 WHERE id=$1 AND status='paused' AND planning_reason_code=$3 AND NOT restore_required`,[id,now,SHARE_EVENT_PAUSE]);
  }
  return restated;
 }

 async function check():Promise<ShareEventRow[]>{
   const today=easternClock(clock()).date;
   if(lastRun===today||clock()<retryAt)return [];
   const symbols=await database.use(async db=>(await db.query<{symbol:string;first_day:string|null;checked_on:string|Date|null}>(`
    WITH held AS (SELECT upper(e.symbol) AS symbol,min(e.occurred_at) AS first_at FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
      WHERE a.status IN ${unreleased} AND e.symbol IS NOT NULL GROUP BY 1 HAVING sum(e.quantity_delta)>0),
     targeted AS (SELECT DISTINCT upper(w->'instrument'->>'symbol') AS symbol FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id
      JOIN strategy_versions v ON v.id=a.accepted_version_id,jsonb_array_elements(v.spec->'target'->'weights') w WHERE a.status IN ${unreleased}),
     wanted AS (SELECT symbol,min(first_at) AS first_at FROM (SELECT symbol,first_at FROM held UNION ALL SELECT symbol,NULL FROM targeted) x GROUP BY symbol)
    SELECT w.symbol,to_char(w.first_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS first_day,c.checked_on FROM wanted w LEFT JOIN share_event_checks c ON c.symbol=w.symbol
    WHERE c.checked_on IS NULL OR c.checked_on<$1::date ORDER BY w.symbol`,[today])).rows);
   if(symbols.length===0)return [];
   // Each symbol's window starts where its last check ended, or at its first attributed share.
   const windows=new Map(symbols.map(s=>[s.symbol,s.checked_on!==null?day(s.checked_on):s.first_day??shiftEasternDate(today,-TARGET_LOOKBACK_DAYS)]));
   const groups=new Map<string,string[]>();
   for(const [symbol,start] of windows){const from=shiftEasternDate(start,-LEAD_DAYS);groups.set(from,[...(groups.get(from)??[]),symbol]);}
   const recorded:ShareEventRow[]=[];
   const rawCloses=new Map<string,DailyClose[]>();
   let failures=0;
   for(const [from,group] of groups){
    const fetched=await fetchCloses(group,from);
    failures+=fetched.failed.size;
    for(const symbol of group){
     const now=iso(),windowStart=windows.get(symbol)!;
     if(fetched.failed.has(symbol)){
      // Not read: planning waits; the window is kept so the next read covers the gap.
      await database.use(db=>db.query(`INSERT INTO share_event_checks(symbol,checked_on,failed,updated_at) VALUES($1,$2,true,$3)
       ON CONFLICT(symbol) DO UPDATE SET failed=true,updated_at=$3`,[symbol,windowStart,now]));
      continue;
     }
     rawCloses.set(symbol,fetched.raw.get(symbol)??[]);
     const reading=readShareEvents(fetched.raw.get(symbol)??[],fetched.adjusted.get(symbol)??[]);
     await database.use(db=>db.transaction(async tx=>{
      for(const step of reading.events){
       if(step.day<=windowStart)continue;
       const forward=step.kind==='split'&&step.splitTo!>step.splitFrom!;
       const inserted=(await tx.query<Row>(`INSERT INTO symbol_share_events(symbol,effective_on,kind,status,split_to,split_from,observed_step,detected_on,details,updated_at)
        VALUES($1,$2,$3,'pending_review',$4,$5,$6,$7,$8,$9) ON CONFLICT(symbol,effective_on) DO NOTHING RETURNING *`,
        [symbol,step.day,step.kind,step.splitTo,step.splitFrom,step.observedStep,today,JSON.stringify({detected:{at:now,previousDay:step.previousDay}}),now])).rows[0];
       if(inserted===undefined)continue;
       if(forward){await decide(tx,inserted,'applied',now);recorded.push({...present(inserted),status:'applied'});continue;}
       await purge(tx,symbol);
       const paused=await pauseHolders(tx,present(inserted),now);
       await tx.query(`UPDATE symbol_share_events SET details=details||$2::jsonb WHERE id=$1`,[inserted.id,JSON.stringify({paused})]);
       recorded.push(present(inserted));
      }
      await tx.query(`INSERT INTO share_event_checks(symbol,checked_on,unconfirmed_on,failed,updated_at) VALUES($1,$2,$3,false,$4)
       ON CONFLICT(symbol) DO UPDATE SET checked_on=$2,unconfirmed_on=$3,failed=false,updated_at=$4`,[symbol,today,reading.unconfirmedOn,now]);
     }));
    }
   }
   // The same raw closes show which symbols stopped trading.
   try{delisted=await observeDelistings(database,read,{closesBySymbol:rawCloses,expectedThrough:lastCompletedTradingDay(today),now:iso()});}
   catch{failures+=1;}
   if(failures===0)lastRun=today;else retryAt=clock()+RETRY_AFTER_MS;
   return recorded;
  }
 let checking:Promise<ShareEventRow[]>|undefined;
 return {
  check():Promise<ShareEventRow[]>{
   if(!checking)checking=check().finally(()=>{checking=undefined;});
   return checking;
  },

  /** Symbols the last check marked delisted. */
  lastDelisted:()=>delisted,

  /** Pending events affecting an allocation, for its card. */
  async pendingFor(allocationId:string):Promise<ShareEventRow[]>{
   return (await database.use(db=>db.query<Row>(`SELECT * FROM symbol_share_events WHERE status='pending_review' AND details->'paused' ? $1 ORDER BY effective_on`,[allocationId]))).rows.map(present);
  },

  /** The member's decision on a pending event, after checking Robinhood: apply a reverse split, or dismiss the reading. */
  async decide(eventId:string,decision:'apply'|'dismiss'):Promise<ShareEventRow>{
   return database.use(db=>db.transaction(async tx=>{
    const event=(await tx.query<Row>(`SELECT * FROM symbol_share_events WHERE id=$1 FOR UPDATE`,[eventId])).rows[0];
    if(!event)throw new Error('Share change not found');
    if(event.status!=='pending_review')throw new Error('This share change was already decided');
    if(decision==='apply'&&event.kind!=='split')throw new Error('This change is not a split; dismiss it, and any difference in your account will show in the account review');
    const now=iso();
    await decide(tx,event,decision==='apply'?'applied':'dismissed',now);
    return {...present(event),status:decision==='apply'?'applied':'dismissed'};
   }));
  },
 };
}
