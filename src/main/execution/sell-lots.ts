import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import type {createAllocationCore} from '../allocations/service';
import {amount,unreleased} from '../allocations/ledger';
import {normalizeRobinhoodTaxLots,selectLotsForSale,selectLotsWithFallback,type RobinhoodTaxLot} from '../allocations/tax-lots';
import {easternClock,easternWallTimeToUtc} from '../market-series/sessions';

// Strategy-owned tax lots. A strategy buy's fill is bound to the
// Robinhood open lot it created (strategy_lot_bindings); a strategy sell
// names its own lots so it never consumes the member's shares, and the
// member's own sell names unclaimed lots so first-in-first-out cannot take a
// strategy's. Allocations with no bound lots (imports carry none) keep the
// provider's default, as hosted buckets without known lots did.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<PGlite,'query'>;
export type TaxLotReader=(accountId:string,symbol:string)=>Promise<RobinhoodTaxLot[]>;
export type SellLots={kind:'provider_default'}|{kind:'lots';taxLots:{open_lot_id:string;quantity:string}[]}|{kind:'unavailable'}|{kind:'unsettled'};
const MAX_LOT_PAGES=10;
const PROVIDER='robinhood';

/** Every open-lot page for one symbol through the member's connection. */
export function taxLotReaderFor(read:(args:Record<string,unknown>,accountId:string)=>Promise<unknown>):TaxLotReader{
 return async(accountId,symbol)=>{
  const lots:RobinhoodTaxLot[]=[];let cursor:string|undefined;
  for(let page=0;page<MAX_LOT_PAGES;page++){
   const result=normalizeRobinhoodTaxLots(await read({symbol,...(cursor===undefined?{}:{cursor})},accountId));
   lots.push(...result.lots);
   if(result.nextCursor===null)break;
   cursor=result.nextCursor;
  }
  return lots;
 };
}

/** Symbols an allocation holds with at least one bound lot: the only ones whose sells need live lots. */
export async function boundSymbols(db:Query,allocationId:string):Promise<string[]>{
 return (await db.query<{symbol:string}>(`SELECT DISTINCT upper(e.symbol) AS symbol FROM strategy_lot_bindings b JOIN strategy_attribution_entries e ON e.id=b.entry_id
  WHERE e.allocation_id=$1 AND e.symbol IS NOT NULL`,[allocationId])).rows.map(r=>r.symbol);
}

/** Live lots for an allocation's bound symbols, read before the planner's transaction opens. */
export async function prefetchSellLots(database:Database,read:TaxLotReader|undefined,allocationId:string):Promise<Map<string,RobinhoodTaxLot[]>>{
 const lots=new Map<string,RobinhoodTaxLot[]>();
 if(read===undefined)return lots;
 const [account,symbols]=await database.use(async db=>[(await db.query<{account_id:string}>('SELECT account_id FROM strategy_allocations WHERE id=$1',[allocationId])).rows[0]?.account_id,await boundSymbols(db,allocationId)] as const);
 if(account===undefined)return lots;
 for(const symbol of symbols)lots.set(symbol,await read(account,symbol));
 return lots;
}

/**
 * Which lots a strategy sell names. Own lots when
 * they cover it; a lot bought today cannot be named until it settles, so the
 * sell goes unnamed only when the allocation holds the whole position and
 * otherwise waits; when the member's own sale took the strategy's lots it
 * borrows unclaimed ones, unless the account no longer covers every claim.
 */
export async function lotsForAllocationSell(tx:Query,input:{allocationId:string;symbol:string;quantity:string;live:RobinhoodTaxLot[]|undefined;nowMs:number}):Promise<SellLots>{
 // Keyed by ticker throughout: bindings may point at entries recorded under an
 // instrument id before claims were re-keyed (rekey.ts), so the entry's own ref is not used.
 const symbol=input.symbol.toUpperCase();
 const known=(await tx.query<{open_lot_id:string;occurred_at:Date;account_id:string}>(`SELECT b.open_lot_id,e.occurred_at,e.account_id FROM strategy_lot_bindings b
  JOIN strategy_attribution_entries e ON e.id=b.entry_id WHERE e.allocation_id=$1 AND upper(e.symbol)=$2 AND b.provider=$3`,[input.allocationId,symbol,PROVIDER])).rows;
 if(known.length===0||input.live===undefined)return {kind:'provider_default'};
 const accountId=known[0]!.account_id;
 const knownIds=new Set(known.map(k=>k.open_lot_id));
 const own=selectLotsForSale(input.live,knownIds,input.quantity);
 const named=(taxLots:{openLotId:string;quantity:string}[]):SellLots=>({kind:'lots',taxLots:taxLots.map(l=>({open_lot_id:l.openLotId,quantity:l.quantity}))});
 const todayStart=easternWallTimeToUtc(easternClock(input.nowMs).date,0);
 const unsettled=new Set([...input.live.filter(l=>l.selectable===false).map(l=>l.openLotId),...known.filter(k=>new Date(k.occurred_at).getTime()>=todayStart).map(k=>k.open_lot_id)]);
 const namesUnsettled=(lots:{openLotId:string}[])=>lots.some(l=>unsettled.has(l.openLotId));
 // What the account holds now: the newest complete snapshot plus fills since, so a fill
 // that synced after the snapshot does not make a whole position look shared.
 const held=async()=>{
  const row=(await tx.query<{quantity:string;observed_at:Date}>(`SELECT p->>'quantity' AS quantity,o.observed_at FROM account_observations o JOIN position_snapshots s ON s.id=o.position_snapshot_id,jsonb_array_elements(s.data) p
   WHERE o.account_id=$1 AND o.resource='equity_positions' AND upper(coalesce(p->>'symbol',p->>'instrumentRef'))=$2 ORDER BY o.observed_at DESC LIMIT 1`,[accountId,symbol])).rows[0];
  if(row===undefined)return null;
  const since=(await tx.query<{q:string}>(`SELECT coalesce(sum(CASE WHEN data->>'side'='sell' THEN -(data->>'quantity')::numeric ELSE (data->>'quantity')::numeric END),0)::text AS q
   FROM account_executions WHERE account_id=$1 AND asset_class='equity' AND upper(data->>'symbol')=$2 AND occurred_at>$3`,[accountId,symbol,row.observed_at])).rows[0]!.q;
  return amount(row.quantity)+amount(since);
 };
 // Whether the allocation owns every share is a question of quantity, not lot ids.
 const wholePosition=async()=>{
  const attributed=amount((await tx.query<{q:string}>(`SELECT coalesce(sum(quantity_delta),0)::text AS q FROM strategy_attribution_entries WHERE allocation_id=$1 AND upper(symbol)=$2`,[input.allocationId,symbol])).rows[0]!.q);
  const position=await held();
  const difference=position===null?null:position-attributed;
  const tolerance=10n**12n; // a millionth of a share
  return difference!==null&&(difference<0n?-difference:difference)<=tolerance;
 };
 // Its own lots: named when settled; a lot bought today sells unnamed when the allocation
 // holds the whole position, and otherwise waits for settlement.
 if(own.covered){
  if(!namesUnsettled(own.taxLots))return named(own.taxLots);
  return await wholePosition()?{kind:'provider_default'}:{kind:'unsettled'};
 }
 // The member's own sale, or an import with no bound lots, leaves its own lots short: if the
 // account still covers every claim, borrow unclaimed lots.
 const claims=(await tx.query<{q:string}>(`SELECT coalesce(sum(e.quantity_delta),0)::text AS q FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
  WHERE a.account_id=$1 AND upper(e.symbol)=$2 AND a.status IN ${unreleased}`,[accountId,symbol])).rows[0]!.q;
 const position=await held();
 if(position===null||position<amount(claims))return {kind:'unavailable'};
 const claimed=new Set((await tx.query<{open_lot_id:string}>(`SELECT b.open_lot_id FROM strategy_lot_bindings b JOIN strategy_attribution_entries e ON e.id=b.entry_id
  JOIN strategy_allocations a ON a.id=e.allocation_id WHERE a.account_id=$1 AND upper(e.symbol)=$2 AND b.provider=$3 AND a.status IN ${unreleased}`,[accountId,symbol,PROVIDER])).rows.map(r=>r.open_lot_id));
 const unclaimed=new Set(input.live.map(l=>l.openLotId).filter(id=>!claimed.has(id)));
 // Settled lots first: Robinhood refuses a sell naming a lot bought today (live
 // EQUITY_TAX_LOT_STALE, 2026-10-05), and settled lots often cover the sale on their own.
 const settledLive=input.live.filter(l=>!unsettled.has(l.openLotId));
 const settled=selectLotsWithFallback(settledLive,new Set([...knownIds].filter(id=>!unsettled.has(id))),new Set([...unclaimed].filter(id=>!unsettled.has(id))),input.quantity);
 if(settled.covered)return named(settled.taxLots);
 if(await wholePosition())return {kind:'provider_default'};
 return selectLotsWithFallback(input.live,knownIds,unclaimed,input.quantity).covered?{kind:'unsettled'}:{kind:'unavailable'};
}

/**
 * After a sync: binds strategy buy fills to the lots they created.
 * Unmatched fills are retried next sync and
 * never guessed.
 */
export async function bindStrategyLots(database:Database,core:Pick<ReturnType<typeof createAllocationCore>,'resolveLots'>,read:TaxLotReader,accountId:string,clock=()=>Date.now()):Promise<{matched:number;unmatched:number}>{
 const pending=(await database.use(db=>db.query<{instrument_ref:string;symbol:string}>(`SELECT DISTINCT e.instrument_ref,upper(e.symbol) AS symbol FROM strategy_attribution_entries e
  LEFT JOIN strategy_lot_bindings b ON b.entry_id=e.id JOIN strategy_allocations a ON a.id=e.allocation_id
  WHERE e.account_id=$1 AND e.provider=$2 AND e.entry_type IN ('fill','reinvestment') AND e.quantity_delta>0 AND e.unit_cost IS NOT NULL
  AND e.symbol IS NOT NULL AND b.entry_id IS NULL AND a.status IN ${unreleased}`,[accountId,PROVIDER]))).rows;
 let matched=0,unmatched=0;
 for(const item of pending){
  const lots=await read(accountId,item.symbol);
  const result=await core.resolveLots({accountId,provider:PROVIDER,instrumentRef:item.instrument_ref,lots,observedAt:new Date(clock()).toISOString(),complete:true});
  matched+=result.matched;unmatched+=result.unmatched;
 }
 return {matched,unmatched};
}

/**
 * The member's own sell names lots no strategy claims, so the provider's
 * first-in-first-out cannot reach a strategy's shares. Null when no strategy has bound
 * lots in the symbol: there is nothing for the default to take by mistake
 * that the share guard has not already refused.
 */
export async function ownLotsForSale(db:Query,read:TaxLotReader,input:{accountId:string;instrumentRef:string;symbol:string;quantity:string}):Promise<{open_lot_id:string;quantity:string}[]|null>{
 const claimed=new Set((await db.query<{open_lot_id:string}>(`SELECT b.open_lot_id FROM strategy_lot_bindings b JOIN strategy_attribution_entries e ON e.id=b.entry_id
  JOIN strategy_allocations a ON a.id=e.allocation_id WHERE a.account_id=$1 AND e.instrument_ref=$2 AND b.provider=$3 AND a.status IN ${unreleased}`,[input.accountId,input.instrumentRef,PROVIDER])).rows.map(r=>r.open_lot_id));
 if(claimed.size===0)return null;
 const live=(await read(input.accountId,input.symbol)).filter(l=>l.selectable!==false);
 const mine=new Set(live.map(l=>l.openLotId).filter(id=>!claimed.has(id)));
 const selection=selectLotsForSale(live,mine,input.quantity);
 if(!selection.covered)throw new Error(`Your own ${input.symbol} lots do not cover this sale; the rest belong to your takes`);
 return selection.taxLots.map(l=>({open_lot_id:l.openLotId,quantity:l.quantity}));
}
