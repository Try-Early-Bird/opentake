import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import {easternWallTimeToUtc,tradingDaysBetween} from '../market-series/sessions';
import {append,instruction,unreleased} from '../allocations/ledger';
import {normalizeTradability} from '../strategies/tradability';
import type {DailyClose,DelistedSymbol} from '../strategies/model-valuation';

// Delistings. The daily share-count check already reads every held or targeted symbol's raw
// closes; a symbol whose latest close is behind while others keep closing is
// counted, and after three trading days without a close it is asked about.
// Robinhood reporting it not tradable marks it delisted at its last close:
// the model closes the sleeve to cash, the planner never targets it again,
// and each allocation holding it releases the shares with no trade. Whatever
// the account received for them (a merger's cash, or nothing) stays the
// member's own, because only Robinhood knows which it was.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<PGlite,'query'>;
type ReadTool=(name:string,args:Record<string,unknown>)=>Promise<unknown>;

/** Consecutive trading days without a close, other symbols still closing, before a not-tradable symbol is marked delisted. */
export const DELISTING_MISSING_DAYS=3;

export interface DelistingMark {symbol:string;day:string;lastClose:string}

const day=(value:string|Date)=>typeof value==='string'?value.slice(0,10):value.toISOString().slice(0,10);

/** Delisting marks among `symbols` (all when omitted), for the model and the planner. */
export async function delistedMarks(db:Query,symbols?:readonly string[]):Promise<Map<string,DelistedSymbol>>{
 const rows=(await db.query<{symbol:string;delisted_on:string|Date;last_close:string}>(`SELECT symbol,delisted_on,last_close::text AS last_close FROM symbol_delistings
  WHERE delisted_on IS NOT NULL AND ($1::text[] IS NULL OR symbol=ANY($1))`,[symbols===undefined?null:[...symbols]])).rows;
 return new Map(rows.map(r=>[r.symbol,{day:day(r.delisted_on),lastClose:r.last_close}]));
}

/**
 * Release a delisted holding: one `detachment` entry under an
 * `attribution_release` instruction per allocation still attributing the
 * symbol, taking the shares and their share of the cost out with no trade.
 * Idempotent per allocation and mark.
 */
export async function releaseDelistedHolding(tx:Transaction,mark:DelistingMark,now:string):Promise<number>{
 const occurredAt=new Date(easternWallTimeToUtc(mark.day,0)).toISOString();
 const holdings=(await tx.query<{allocation_id:string;instrument_ref:string;quantity:string}>(`SELECT e.allocation_id,max(e.instrument_ref) AS instrument_ref,sum(e.quantity_delta)::text AS quantity
  FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
  WHERE a.status IN ${unreleased} AND upper(e.symbol)=$1 GROUP BY e.allocation_id HAVING sum(e.quantity_delta)>0`,[mark.symbol])).rows;
 let released=0;
 for(const h of holdings){
  const cause=`symbol-delisted:${mark.symbol}:${mark.day}`;
  const transactionId=await instruction(tx,{allocationId:h.allocation_id,kind:'attribution_release',cause},now);
  await append(tx,{allocationId:h.allocation_id,transactionId,entryType:'detachment',cause,instrumentRef:h.instrument_ref,symbol:mark.symbol,quantityDelta:`-${h.quantity}`,
   sourceKind:'symbol_delisted',sourceRef:`${mark.symbol}:${mark.day}`,occurredAt,metadata:{delistedOn:mark.day,lastClose:mark.lastClose,releasedQuantity:h.quantity}},now);
  released+=1;
 }
 return released;
}

/**
 * Observe and clear, over one check's raw closes:
 * counts lagging symbols, asks Robinhood about those three trading days
 * behind, marks the not-tradable ones delisted and releases their holdings.
 * Only meaningful when some symbol is current; otherwise the gap is the data's.
 */
export async function observeDelistings(database:Database,readTool:ReadTool,input:{closesBySymbol:ReadonlyMap<string,readonly DailyClose[]>;expectedThrough:string;now:string}):Promise<DelistingMark[]>{
 const symbols=[...input.closesBySymbol.keys()];
 const latest=(symbol:string)=>input.closesBySymbol.get(symbol)?.at(-1);
 const lagging=symbols.filter(symbol=>{const last=latest(symbol);return last!==undefined&&last.day<input.expectedThrough;});
 const current=symbols.filter(symbol=>latest(symbol)?.day===input.expectedThrough);
 // Symbols closing again are no longer lagging.
 if(current.length)await database.use(db=>db.query(`UPDATE symbol_delistings SET no_close_since=NULL,updated_at=$2 WHERE symbol=ANY($1) AND no_close_since IS NOT NULL AND delisted_on IS NULL`,[current,input.now]));
 if(current.length===0||lagging.length===0)return [];
 const existing=new Map((await database.use(db=>db.query<{symbol:string;no_close_since:string|Date|null;delisted_on:string|Date|null}>(
  `SELECT symbol,no_close_since,delisted_on FROM symbol_delistings WHERE symbol=ANY($1)`,[lagging]))).rows.map(r=>[r.symbol,r]));
 const candidates:string[]=[];
 for(const symbol of lagging){
  const row=existing.get(symbol);
  if(row?.delisted_on!=null)continue;
  // The gap starts the trading day after the last close, or where an earlier check already placed it, whichever is earlier.
  const gapStart=tradingDaysBetween(latest(symbol)!.day,input.expectedThrough)[1]??input.expectedThrough;
  const recorded=row?.no_close_since==null?null:day(row.no_close_since);
  const since=recorded!==null&&recorded<gapStart?recorded:gapStart;
  await database.use(db=>db.query(`INSERT INTO symbol_delistings(symbol,no_close_since,updated_at) VALUES($1,$2,$3)
   ON CONFLICT(symbol) DO UPDATE SET no_close_since=$2,updated_at=$3`,[symbol,since,input.now]));
  if(tradingDaysBetween(since,input.expectedThrough).length>=DELISTING_MISSING_DAYS)candidates.push(symbol);
 }
 if(candidates.length===0)return [];
 // Robinhood's verdict for the selected account; anything but an explicit "not tradable" leaves the symbol counting.
 const verdicts=new Map<string,boolean|null>();
 for(let i=0;i<candidates.length;i+=10){
  const batch=candidates.slice(i,i+10);
  for(const fact of normalizeTradability(await readTool('get_equity_tradability',{symbols:batch}),batch))verdicts.set(fact.symbol,fact.tradable);
 }
 const marked:DelistingMark[]=[];
 for(const symbol of candidates){
  if(verdicts.get(symbol)!==false)continue;
  const mark={symbol,day:input.expectedThrough,lastClose:latest(symbol)!.close};
  await database.use(db=>db.transaction(async tx=>{
   await tx.query(`UPDATE symbol_delistings SET delisted_on=$2,last_close=$3,updated_at=$4 WHERE symbol=$1`,[symbol,mark.day,mark.lastClose,input.now]);
   await releaseDelistedHolding(tx,mark,input.now);
  }));
  marked.push(mark);
 }
 return marked;
}
