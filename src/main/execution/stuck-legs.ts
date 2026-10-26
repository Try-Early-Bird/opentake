import {basketSessionPolicy} from '../trading/session-policy';
import type {BasketSpec} from '../../shared/strategies';
import type {createDatabaseLifecycle} from '../database';
import {regularSessionMinutesBetween} from '../market-series/sessions';
import {AWAITING_CONFIRMATION} from './executor';

// Legs that will never finish. An allocation with an open leg is not planned again: right
// while something is in flight, wrong once nothing is, and then the
// investment sits still with no one to tell it otherwise.
// Only one kind of stuck is safe to clear on our own. A leg planned and
// never handed to the order writer has moved no money, so cancelling it loses
// nothing: the next plan sizes from what the allocation holds and writes the
// leg again if it is still wanted. A leg that may have reached Robinhood (an
// unknown placement, a reconciliation case) is never guessed at; it is
// counted for the member and resolved only by a synced order carrying its
// ref_id.
// Self-hosted difference: a leg held for the member's confirmation (they
// confirm every trade) is waiting on them, not stuck, so it is never swept.
// Hosted's sweep predates that hold and would cancel such a leg.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;

/** A leg queued this long, in regular-session minutes, with nothing placed is not waiting on the provider. */
export const STALE_QUEUED_MINUTES=90;

/**
 * Whether a queued leg has waited long enough to be called stale. Counted in
 * minutes the market was open: placement waits for the session, so a leg
 * queued in the evening has waited nothing by the next morning's open.
 */
export function isStaleQueuedLeg(createdAt:string,nowMs:number,continuous=false):boolean{
 if(continuous)return nowMs-Date.parse(createdAt)>=STALE_QUEUED_MINUTES*60000;
 return regularSessionMinutesBetween(Date.parse(createdAt),nowMs)>=STALE_QUEUED_MINUTES;
}

export interface StuckLegSweep {
 /** Legs cancelled because they were never placed. */
 cancelled:number;
 /** Allocations those legs belonged to, now free to be planned again. */
 allocations:string[];
 /** Legs that need the member's brokerage to answer: Robinhood may already have them. */
 awaitingProvider:number;
}

/** Cancels legs planned but never placed, so their investments can be planned again. */
export async function sweepStuckLegs(database:Database,clock=()=>Date.now()):Promise<StuckLegSweep>{
 const nowMs=clock(),now=new Date(nowMs).toISOString();
 // Clock minutes bound session minutes from above: a cheap prefilter; the session test below is the real one.
 const cutoff=new Date(nowMs-STALE_QUEUED_MINUTES*60_000).toISOString();
 return database.use(db=>db.transaction(async tx=>{
  const candidates=(await tx.query<{id:string;allocation_id:string;created_at:Date;spec:BasketSpec|null;crypto:boolean}>(`SELECT e.id,e.allocation_id,e.created_at,v.spec,e.order_request ? 'currency_pair_id' AS crypto FROM strategy_executions e
   JOIN strategy_allocations a ON a.id=e.allocation_id LEFT JOIN strategy_versions v ON v.id=e.version_id
   WHERE e.status='queued' AND e.order_intent_id IS NULL AND e.created_at<$1
    AND a.planning_reason_code IS DISTINCT FROM $2
   ORDER BY e.created_at LIMIT 200`,[cutoff,AWAITING_CONFIRMATION])).rows;
  const stale=candidates.filter(leg=>isStaleQueuedLeg(new Date(leg.created_at).toISOString(),nowMs,leg.crypto&&basketSessionPolicy(leg.spec).calendar==='continuous'));
  const allocations=[...new Set(stale.map(leg=>leg.allocation_id))];
  if(stale.length>0){
   await tx.query(`UPDATE strategy_executions SET status='cancelled',failure_code='stale_plan',terminal_at=$2,updated_at=$2
    WHERE id=ANY($1) AND status='queued' AND order_intent_id IS NULL`,[stale.map(leg=>leg.id),now]);
   // The allocation was parked behind its own open leg; let the next tick look at it.
   await tx.query(`UPDATE strategy_allocations SET planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=ANY($1)`,[allocations,now]);
  }
  const waiting=(await tx.query<{count:number}>(`SELECT count(*)::int AS count FROM strategy_executions WHERE status IN ('placement_unknown','reconciliation_required')`)).rows[0]!.count;
  return {cancelled:stale.length,allocations,awaitingProvider:waiting};
 }));
}
