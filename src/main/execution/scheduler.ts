import {cryptoInstrumentFromRef} from '../orders/crypto-take-identity';
import {executionBasket} from '../mixed-execution/basket';
import { supportsBasketExecution,instrumentKey,hasPendingInstrumentSupport } from '../../shared/strategies';
import type {createDatabaseLifecycle} from '../database';
import {sweepStuckLegs} from './stuck-legs';
import {heldSymbols} from './share-event-repair';
import {easternClock,shiftEasternDate} from '../market-series/sessions';
import {basketSessionPolicy,basketCalendar} from '../trading/session-policy';
import {retryBackoffMs} from '../allocations/allocation-transactions';
import {driftBreach,dueForScheduledRebalance} from '../strategies/model-valuation';
import type {BasketSpec} from '../../shared/strategies';
import type {Executor,Planner,PlanTrigger} from './contracts';

// The local dispatcher. Work is derived from allocation
// state on every tick rather than from a queue, so anything that came due
// while the machine slept or the host was quit is caught up on the next tick:
// allocations behind their strategy's committed version are re-planned,
// queued legs are placed during the session, scheduled and drift-band
// rebalances run inside the session (drift checked once per trading day), and
// due member instructions run first. A planning error backs the allocation
// off (doubling to a day). The background host ticks this with the window
// closed; the venue queue arbitrates connection access.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
/** Allocations considered per tick, as the hosted page size. */
const PAGE=50;
const OPEN_LEG=`('queued','reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required')`;

export interface SchedulerDeps {
 planner:Planner;
 executor:Executor;
 clock?:()=>number;
 /** True while another connection task runs; the tick waits for it (see busyWait), then steps aside. */
 busy?:()=>boolean;
 /** How long a tick waits for a busy connection, polling every pollMs; 20 s by default, inside the 30 s timer. */
 busyWait?:{ms:number;pollMs:number};
 /** Member instructions that had to wait (e.g. lots unsettled); run inside the session ahead of ordinary plans. Returns the allocations they touched. */
 instructions?:{runDue(now:number):Promise<string[]>};
}

interface Candidate {
 id:string;account_id:string;strategy_id:string;status:string;applied_version_id:string;current_version_id:string|null;spec:BasketSpec|null;
 last_rebalanced_on:string|null;last_drift_check_on:string|null;activated_at:Date|null;created_at:Date;
 open_leg:boolean;queued_leg:boolean;applied_version_sequence:number;current_sequence:number|null;
}

/** Current sleeve weights from the ledger and stored quotes; null when any held symbol has no price. */
export async function currentSleeves(database:Database,allocationId:string,spec:BasketSpec,now:number){
 const rows=(await database.use(db=>db.query<{ref:string|null;asset_class:string|null;symbol:string|null;quantity:string;cash:string}>(`SELECT instrument_ref AS ref,max(asset_class) AS asset_class,upper(max(symbol)) AS symbol,coalesce(sum(quantity_delta),0)::text AS quantity,sum(cash_delta)::text AS cash
  FROM strategy_attribution_entries WHERE allocation_id=$1 GROUP BY instrument_ref`,[allocationId]))).rows;
 const cash=rows.reduce((n,r)=>n+Number(r.cash),0);
 const held=rows.filter(r=>r.symbol!==null&&Number(r.quantity)!==0).map(r=>({symbol:r.asset_class==='crypto'?r.ref!:r.symbol!,crypto:r.asset_class==='crypto',quantity:Number(r.quantity)}));
 const targets=spec.target.weights.map(w=>({symbol:w.instrument.market?instrumentKey(w.instrument):w.instrument.symbol.toUpperCase(),percent:w.bps/100}));
 const symbols=[...new Set([...held.filter(h=>!h.crypto).map(h=>h.symbol),...spec.target.weights.filter(w=>!w.instrument.market).map(w=>w.instrument.symbol.toUpperCase())])];
 const prices=new Map((await database.use(db=>db.query<{symbol:string;price:string}>(`SELECT symbol,price::text AS price FROM market_quotes WHERE symbol=ANY($1) AND observed_at >= $2 AND observed_at <= $3`,[symbols,new Date(now-10*60_000).toISOString(),new Date(now+60_000).toISOString()]))).rows.map(r=>[r.symbol,Number(r.price)]));
 if(held.some(h=>h.crypto)||spec.target.weights.some(w=>w.instrument.market?.kind==='crypto')){
  const snapshot=(await database.use(db=>db.query<{data:{instrumentRef:string;symbol:string|null;markPrice:string|null;priceObservedAt?:string|null}[]}>(`SELECT p.data FROM strategy_allocations a JOIN account_observations o ON o.account_id=a.account_id AND o.resource='crypto_positions'
   JOIN position_snapshots p ON p.id=o.position_snapshot_id AND p.account_id=a.account_id WHERE a.id=$1 ORDER BY o.observed_at DESC,o.id LIMIT 1`,[allocationId]))).rows[0];
  const seen=new Set<string>();
  for(const p of snapshot?.data??[]){
   if(seen.has(p.instrumentRef))return null;seen.add(p.instrumentRef);
   if(!cryptoInstrumentFromRef(p.instrumentRef,p.symbol??''))return null;
   const at=Date.parse(p.priceObservedAt??''),price=Number(p.markPrice);
   if(Number.isFinite(at)&&at<=now&&now-at<=60000&&Number.isFinite(price)&&price>0)prices.set(p.instrumentRef,price);
  }
 }
 if(held.some(h=>!(prices.get(h.symbol)!>0)))return null;
 const values=new Map<string,number>();
 for(const h of held){if(!Number.isFinite(h.quantity)||h.quantity<0)return null;values.set(h.symbol,(values.get(h.symbol)??0)+h.quantity*prices.get(h.symbol)!);}
 const total=cash+[...values.values()].reduce((n,v)=>n+v,0);
 if(!(total>0))return null;
 return targets.map(t=>({symbol:t.symbol,targetWeightPercent:t.percent,currentWeightPercent:((values.get(t.symbol)??0)/total)*100}));
}

export function createExecutionScheduler(database:Database,deps:SchedulerDeps){
 const clock=deps.clock??(()=>Date.now());
 let running:Promise<void>|undefined;
 let cursor='00000000-0000-0000-0000-000000000000';
 const busyWait=deps.busyWait??{ms:20_000,pollMs:500};
 // The connection runs one task at a time. Losing a whole tick to it, on a 30-second timer that
 // fires beside the quote refresh's, could keep losing in step, so a tick waits briefly instead.
 async function connectionFree(){
  for(let waited=0;deps.busy?.();waited+=busyWait.pollMs){if(waited>=busyWait.ms)return false;await new Promise(resolve=>setTimeout(resolve,busyWait.pollMs));}
  return true;
 }
 const iso=(ms=clock())=>new Date(ms).toISOString();

 async function plan(id:string,trigger:PlanTrigger,session:boolean){
  try{
   const result=await deps.planner.planAllocation(id,trigger);
   await database.use(db=>db.query(`UPDATE strategy_allocations SET planning_failures=0 WHERE id=$1 AND planning_failures>0`,[id]));
   // Placement happens inside the session; outside it the queued legs wait (the executor parks them until the open).
   if(trigger==='drift'&&!['deferred','failed'].includes(result.disposition))await database.use(db=>db.query('UPDATE strategy_allocations SET last_drift_check_on=$2 WHERE id=$1',[id,easternClock(clock()).date]));
   if(result.executionIds.length>0&&session)await deps.executor.executeAllocation(id);
  }catch{
   // Consecutive planning errors back off, doubling to a day.
   await database.use(db=>db.query(`UPDATE strategy_allocations SET planning_failures=planning_failures+1,planning_reason_code='retry_backoff',
    planning_deferred_until=$2::timestamptz+make_interval(secs=>$3::double precision*power(2,least(planning_failures,10))/1000),updated_at=$2 WHERE id=$1`,
    [id,iso(),retryBackoffMs(1)]));
  }
 }

 async function pass(){
  if(!await connectionFree())return;
  const now=clock(),today=easternClock(now).date;
  // Legs planned but never placed for 90 market minutes free their allocation first.
  await sweepStuckLegs(database,clock).catch(()=>undefined);
  // Due instructions first: the member asked for these; they take the allocation for this tick.
  const instructed=new Set(deps.instructions?await deps.instructions.runDue(now).catch(()=>[]):[]);
  const candidates=(await database.use(db=>db.query<Candidate>(`SELECT a.id,a.account_id,a.strategy_id,a.status,a.applied_version_id,a.applied_version_sequence,v.sequence AS current_sequence,a.accepted_version_id AS current_version_id,v.spec,a.last_rebalanced_on,a.last_drift_check_on,a.activated_at,a.created_at,
   EXISTS(SELECT 1 FROM strategy_executions e WHERE e.allocation_id=a.id AND e.status IN ${OPEN_LEG}) AS open_leg,
   EXISTS(SELECT 1 FROM strategy_executions e WHERE e.allocation_id=a.id AND e.status='queued') AS queued_leg
   FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id LEFT JOIN strategy_versions v ON v.id=a.accepted_version_id
   WHERE a.status='active' AND NOT a.restore_required AND s.archived_at IS NULL
    -- Waiting on the member to hold or sell (archived, or a close failed): only their decision moves it, never a rebalance.
    AND NOT EXISTS(SELECT 1 FROM strategy_allocation_closures c WHERE c.allocation_id=a.id AND c.status IN ('awaiting','failed'))
    AND NOT EXISTS(SELECT 1 FROM mixed_take_executions m JOIN takes t ON t.id=m.take_id WHERE t.strategy_id=a.strategy_id AND m.state<>'completed')
    AND NOT EXISTS(SELECT 1 FROM mixed_take_withdrawals w JOIN takes wt ON wt.id=w.take_id WHERE wt.strategy_id=a.strategy_id AND w.state IN ('running','attention'))
    AND (a.planning_deferred_until IS NULL OR a.planning_deferred_until<$1)
   ORDER BY (a.id>$2::uuid) DESC,a.id LIMIT ${PAGE}`,[iso(now),cursor]))).rows;
  if(candidates.length)cursor=candidates.at(-1)!.id;
  for(const c of candidates){if(c.spec&&!supportsBasketExecution(c.spec)&&c.current_version_id){try{c.spec=await database.use(db=>executionBasket(db,c.spec!,{strategyId:c.strategy_id,versionId:c.current_version_id!,accountId:c.account_id},'robinhood'));}catch{continue;}}}
  const eligible=candidates.filter(c=>!instructed.has(c.id) && (c.spec===null || supportsBasketExecution(c.spec)));
  const triggers=new Map<string,PlanTrigger>();
  const placeOnly:string[]=[];
  // A symbol whose newest bar looks like an unadjusted split, or that could not be read, holds planning until the next check (split_unconfirmed / share_check_failed).
  const unsettled=await database.use(db=>heldSymbols(db));
  const touchesUnsettled=new Set<string>();
  if(unsettled.size>0){
   const holders=(await database.use(db=>db.query<{allocation_id:string}>(`SELECT DISTINCT allocation_id FROM strategy_attribution_entries WHERE asset_class='equity' AND upper(symbol)=ANY($1) AND allocation_id=ANY($2)`,[[...unsettled],candidates.map(c=>c.id)]))).rows;
   for(const h of holders)touchesUnsettled.add(h.allocation_id);
   for(const c of eligible)if(c.spec?.target.weights.some(w=>!w.instrument.market&&unsettled.has(w.instrument.symbol.toUpperCase())))touchesUnsettled.add(c.id);
  }
  for(const c of eligible){
   if(touchesUnsettled.has(c.id))continue;
   // Behind the strategy: a newer committed version than the one this allocation follows.
   if(!c.open_leg&&c.current_version_id!==null&&c.applied_version_id!==c.current_version_id){triggers.set(c.id,'republish');continue;}
   // Fill-backed replanning: a run that queued legs leaves the applied sequence where it
   // was, and once they are terminal the next run sizes from what filled and either finds
   // nothing to do (advancing it) or plans the shortfall.
   if(!c.open_leg&&c.current_sequence!==null&&c.applied_version_sequence<c.current_sequence){triggers.set(c.id,'republish');continue;}
   // Legs planned earlier (outside the session, after a failure) go out while the market is open.
   if(c.queued_leg&&basketSessionPolicy(c.spec).isOpen(now)){
    const onlyQueued=!(await database.use(db=>db.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ('reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required') LIMIT 1`,[c.id]))).rows.length;
    if(onlyQueued){placeOnly.push(c.id);continue;}
   }
  }
  // Each basket selects its calendar. Mixed baskets retain equity-session
  // sequencing; crypto-only baskets include weekends and holidays.
  {
   const driftChecked:string[]=[];
   for(const c of eligible){
    if(touchesUnsettled.has(c.id)||triggers.has(c.id)||placeOnly.includes(c.id)||c.open_leg||c.spec===null)continue;
    if(!basketSessionPolicy(c.spec).isOpen(now))continue;
    const calendar=basketCalendar(c.spec,shiftEasternDate(today,-400),today);
    const rule=c.spec.rebalance;
    const activatedAt=new Date(c.activated_at??c.created_at).toISOString();
    if(dueForScheduledRebalance({lastRebalancedOn:c.last_rebalanced_on,activatedAt},rule,calendar,today)){triggers.set(c.id,'scheduled');continue;}
    const hasBands=rule.driftBandPoints!==null||rule.driftBandRelative!==null;
    if(!hasBands||c.last_drift_check_on===today)continue;
    const sleeves=await currentSleeves(database,c.id,c.spec,now).catch(()=>null);
    if(sleeves===null)continue;
    if(driftBreach(sleeves,rule)!==null)triggers.set(c.id,'drift');
    else driftChecked.push(c.id);
   }
   if(driftChecked.length)await database.use(db=>db.query(`UPDATE strategy_allocations SET last_drift_check_on=$2 WHERE id=ANY($1)`,[driftChecked,today]));
  }
  // An archived take is skipped above, but sells it queued for the member's close still go out at the open.
  {
   const closing=(await database.use(db=>db.query<{id:string;spec:BasketSpec|null}>(`SELECT DISTINCT a.id,v.spec FROM strategy_allocations a LEFT JOIN strategy_versions v ON v.id=a.accepted_version_id
    JOIN strategy_allocation_closures c ON c.allocation_id=a.id AND c.status='selling'
    JOIN strategies s ON s.id=a.strategy_id AND s.archived_at IS NOT NULL
    WHERE a.status='active' AND EXISTS(SELECT 1 FROM strategy_executions e WHERE e.allocation_id=a.id AND e.status='queued')
     AND NOT EXISTS(SELECT 1 FROM strategy_executions e WHERE e.allocation_id=a.id AND e.status IN ('reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required'))`))).rows;
   for(const c of closing)if(c.spec&&!hasPendingInstrumentSupport(c.spec)&&basketSessionPolicy(c.spec).isOpen(now)&&!placeOnly.includes(c.id))placeOnly.push(c.id);
  }
  for(const id of placeOnly){if(!await connectionFree())return;await deps.executor.executeAllocation(id).catch(()=>{});}
  for(const [id,trigger] of triggers){if(!await connectionFree())return;await plan(id,trigger,basketSessionPolicy(eligible.find(c=>c.id===id)?.spec??null).isOpen(now));}
 }

 return {
  /** One pass; concurrent ticks share it. */
  tick():Promise<void>{
   if(!running)running=pass().finally(()=>{running=undefined;});
   return running;
  },
 };
}
