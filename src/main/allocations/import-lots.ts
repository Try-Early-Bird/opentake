import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import {matchFillToLot,type RobinhoodTaxLot} from './tax-lots';
import {unreleased} from './ledger';
import type {ImportMapping} from './portfolio-import';

// Binds an imported take's claims to the Robinhood lots its hosted buys
// created (migration 43). Hosted stamped each buy with its lot when the fill
// synced (lot-resolution.ts resolveStrategyLotIds); an imported take arrived
// as one opening claim per symbol, so it had no lots and its sells went out
// unnamed. After each sync, each stored source buy (the immutable export in
// strategy_portfolio_imports) is bound once to a lot still open in the
// account: hosted's own lot id when a newer export carried it, otherwise
// hosted's matcher (exact quantity, then same day, then closest cost). A buy
// whose lot was since sold, or partly sold, has no open lot of that size and
// stays unbound, as hosted's matcher leaves it. The lot is bound to the
// take's current opening claim for the symbol, so sells name it.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<Transaction,'query'>;
export type TaxLotReader=(accountId:string,symbol:string)=>Promise<RobinhoodTaxLot[]>;
const PROVIDER='robinhood';
interface SourceEntry {id:string;entryType:string;symbol:string|null;quantityDelta:string|null;unitCost:string|null;occurredAt:string;openLotId?:string|null}
interface SourceBuy {sourceId:string;allocationId:string;symbol:string;quantity:string;price:string;occurredAt:string}

/** Source buys of unreleased imported takes on this account that have no binding yet. */
export async function pendingImportedBuys(db:Query,accountId:string):Promise<SourceBuy[]>{
 const imports=(await db.query<{source_data:{allocations:{id:string;entries:SourceEntry[]}[]};mapping:ImportMapping}>(
  'SELECT source_data,mapping FROM strategy_portfolio_imports WHERE account_id=$1',[accountId])).rows;
 const bound=new Set((await db.query<{source_ref:string}>(`SELECT source_ref FROM strategy_lot_bindings WHERE account_id=$1 AND source_ref IS NOT NULL`,[accountId])).rows.map(r=>r.source_ref));
 const live=new Set((await db.query<{id:string}>(`SELECT id::text FROM strategy_allocations WHERE account_id=$1 AND status IN ${unreleased}`,[accountId])).rows.map(r=>r.id));
 const buys:SourceBuy[]=[];
 for(const row of imports)for(const source of row.source_data.allocations){
  const allocationId=row.mapping.allocations[source.id];if(!allocationId||!live.has(allocationId))continue;
  for(const e of source.entries){
   if(!['fill','income'].includes(e.entryType)||e.symbol===null||e.quantityDelta===null||e.unitCost===null||e.quantityDelta.startsWith('-')||bound.has(e.id))continue;
   buys.push({sourceId:e.id,allocationId,symbol:e.symbol.toUpperCase(),quantity:e.quantityDelta,price:e.unitCost,occurredAt:e.occurredAt});
  }
 }
 return buys.sort((l,r)=>l.occurredAt.localeCompare(r.occurredAt));
}

/** Binds one symbol's pending source buys against the account's open lots now. */
export async function bindImportedSymbol(tx:Query,accountId:string,symbol:string,buys:readonly SourceBuy[],lots:readonly RobinhoodTaxLot[],now:string):Promise<{matched:number;unmatched:number}>{
 const used=new Set((await tx.query<{open_lot_id:string}>(`SELECT open_lot_id FROM strategy_lot_bindings WHERE account_id=$1 AND provider=$2`,[accountId,PROVIDER])).rows.map(r=>r.open_lot_id));
 const hints=new Map((await tx.query<{source_entry_id:string;open_lot_id:string}>(`SELECT source_entry_id::text,open_lot_id FROM strategy_import_lot_ids WHERE account_id=$1 AND source_entry_id=ANY($2::uuid[])`,
  [accountId,buys.map(b=>b.sourceId)])).rows.map(r=>[r.source_entry_id,r.open_lot_id]));
 let matched=0;
 for(const buy of buys){
  // The take's current opening claim for the symbol: the newest import entry not reversed since (re-keying re-records it).
  const anchor=(await tx.query<{id:string}>(`SELECT e.id FROM strategy_attribution_entries e WHERE e.allocation_id=$1 AND upper(e.symbol)=$2 AND e.source_kind='development_import'
   AND e.entry_type='external_adjustment' AND e.quantity_delta>0 AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries r WHERE r.reversal_of=e.id) ORDER BY e.sequence DESC LIMIT 1`,[buy.allocationId,symbol])).rows[0];
  if(!anchor)continue;
  const hinted=hints.get(buy.sourceId);
  const lot=hinted!==undefined&&!used.has(hinted)?lots.find(l=>l.openLotId===hinted)??null
   :hinted===undefined?matchFillToLot(lots,{quantity:buy.quantity,price:buy.price,occurredAt:buy.occurredAt},used):null;
  if(lot===null)continue;
  await tx.query(`INSERT INTO strategy_lot_bindings(entry_id,account_id,provider,open_lot_id,matched_at,source_ref) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
   [anchor.id,accountId,PROVIDER,lot.openLotId,now,buy.sourceId]);
  used.add(lot.openLotId);matched++;
 }
 return {matched,unmatched:buys.length-matched};
}

// A buy whose lot was sold never matches; its symbol is read again at most hourly, not every sync.
const RETRY_MS=60*60*1000;
const attempted=new Map<string,{at:number;pending:number}>();

/** After a sync: binds imported takes' source buys to open lots, one Robinhood read per symbol with work to do. */
export async function bindImportedLots(database:Database,read:TaxLotReader,accountId:string,clock=()=>Date.now()):Promise<{matched:number;unmatched:number}>{
 const buys=await database.use(db=>pendingImportedBuys(db,accountId));
 const bySymbol=new Map<string,SourceBuy[]>();for(const b of buys)bySymbol.set(b.symbol,[...(bySymbol.get(b.symbol)??[]),b]);
 let matched=0,unmatched=0;
 for(const [symbol,list] of bySymbol){
  const key=`${accountId}:${symbol}`,last=attempted.get(key);
  if(last&&last.pending===list.length&&clock()-last.at<RETRY_MS){unmatched+=list.length;continue;}
  attempted.set(key,{at:clock(),pending:list.length});
  const lots=await read(accountId,symbol);
  const result=await database.use(db=>db.transaction(tx=>bindImportedSymbol(tx,accountId,symbol,list,lots,new Date(clock()).toISOString())));
  matched+=result.matched;unmatched+=result.unmatched;
 }
 return {matched,unmatched};
}
