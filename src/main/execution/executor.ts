import type {createDatabaseLifecycle} from '../database';
import {PlacementUnknownError} from '../orders/service';
import {tradingSessionPolicy} from '../trading/session-policy';
import type {ExecutionOutcome,Executor,TradingPreferences} from './contracts';

// Delegated placement. An allocation's queued legs go out through the
// same review -> confirm path a member uses by hand (the single order writer),
// sells before buys. Nothing here calls Robinhood directly, so attribution,
// fills and reconciliation behave exactly as for a manual order. The batch
// stops at the first failure or ambiguous submission so a refused sell never
// cascades into buys the allocation cannot fund.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
/** Minimal writer boundary shared by asset adapters; the executor owns batch
 * policy, consent and durable leg state, never provider-specific order calls. */
export interface TakeOrderWriter {
 review(input:{accountId:string;order:unknown;allocationId?:string;transactionId?:string}):Promise<{intent:{id:string};review:unknown}>;
 confirm(id:string):Promise<{status:string;placedAt:string|null}>;
}

/** Reason code when the member confirms every trade and has not confirmed these. */
export const AWAITING_CONFIRMATION='awaiting_confirmation';
/** The allocation's queued legs wait for the regular session; the deferral is the open. */
export const MARKET_CLOSED='market_closed';
/** Reason code when the account cannot fund the queued buys right now. */
export const INSUFFICIENT_BUYING_POWER='insufficient_buying_power';
/** How long an allocation waiting on the member stays out of the placement sweep; confirming clears it. */
const CONFIRMATION_RECHECK_MS=24*60*60_000;
/** After a failed leg the allocation rests before the next pass. */
const FAILURE_PARK_MS=15*60_000;
/** A placement whose outcome stays unknown this long is handed to reconciliation. */
export const UNKNOWN_RECONCILE_MS=60*60_000;
/** Legs whose orders still may reach or already reached Robinhood. */
const UNRESOLVED=['submitting','placement_unknown','reconciliation_required'];

/**
 * A stable code from an error's class: `OrderConflictError` -> `order_conflict`
 * Plain Errors are `unknown`.
 */
export function errorCode(error:unknown):string{
 const name=error instanceof Error?error.constructor.name:'';
 return name!==''&&name!=='Error'?name.replace(/Error$/u,'').replace(/([a-z])([A-Z])/gu,'$1_$2').toLowerCase():'unknown';
}

/** True when the account's buying power is known and cannot cover the buys. */
export function buyingPowerShort(buyTotalUsd:number,buyingPower:string|null|undefined):boolean{
 if(buyTotalUsd<=0||buyingPower===null||buyingPower===undefined)return false;
 const available=Number(buyingPower);
 return Number.isFinite(available)&&available<buyTotalUsd;
}

interface LegRow {id:string;symbol:string;side:'buy'|'sell';transaction_id:string|null;order_request:Record<string,unknown>}

export interface ExecutorDeps {
 orderWriter:TakeOrderWriter;
 clock?:()=>number;
 /** Live buying power for the account; null when unreadable (does not block). Defaults to the last synced portfolio. */
 buyingPower?:(accountId:string)=>Promise<string|null>;
}

export async function readTradingPreferences(database:Database):Promise<TradingPreferences>{
 const row=(await database.use(db=>db.query<{confirm_trades:boolean;blocked_symbols:string[]}>(
  `SELECT p.confirm_trades,p.blocked_symbols FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1`))).rows[0];
 return {confirmTrades:row?.confirm_trades??false,blockedSymbols:(row?.blocked_symbols??[]).map(s=>s.toUpperCase())};
}

export function createExecutor(database:Database,deps:ExecutorDeps):Executor{
 const clock=deps.clock??(()=>Date.now());
 const iso=(ms=clock())=>new Date(ms).toISOString();
 // One placement pass per allocation at a time; the host is one process.
 const placing=new Set<string>();
 const storedBuyingPower=async(accountId:string)=>{
  const row=(await database.use(db=>db.query<{bp:string|null}>(`SELECT p.data->>'buyingPower' AS bp FROM account_observations o JOIN portfolio_snapshots p ON p.id=o.portfolio_snapshot_id
   WHERE o.account_id=$1 AND o.resource='portfolio' ORDER BY o.observed_at DESC LIMIT 1`,[accountId]))).rows[0];
  return row?.bp??null;
 };
 const buyingPower=deps.buyingPower??storedBuyingPower;
 const park=(allocationId:string,reason:string,untilMs:number)=>database.use(db=>db.query(
  `UPDATE strategy_allocations SET planning_reason_code=$2,planning_deferred_until=$3,updated_at=$4 WHERE id=$1`,[allocationId,reason,iso(untilMs),iso()]));
 const markFailed=(id:string,code:string)=>database.use(db=>db.query(
  `UPDATE strategy_executions SET status='failed',failure_code=$2,terminal_at=$3,updated_at=$3 WHERE id=$1 AND status IN ('queued','reviewed')`,[id,code,iso()]));
 const legStatus=async(id:string)=>(await database.use(db=>db.query<{status:string}>('SELECT status FROM strategy_executions WHERE id=$1',[id]))).rows[0]?.status;

 async function place(allocationId:string,accountId:string,base:ExecutionOutcome,blocked:ReadonlySet<string>):Promise<ExecutionOutcome>{
  const legs=(await database.use(db=>db.query<LegRow>(`SELECT id,symbol,side,transaction_id,order_request FROM strategy_executions
   WHERE allocation_id=$1 AND status='queued' ORDER BY CASE side WHEN 'sell' THEN 0 ELSE 1 END,symbol`,[allocationId]))).rows;
  if(legs.length===0)return {...base,parkedReason:'nothing_queued'};
  // A previous pass may have died after a sell was accepted: its buys must not spend that cash yet.
  if((await database.use(db=>db.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status=ANY($2) LIMIT 1`,[allocationId,UNRESOLVED]))).rows.length)
   return {...base,parkedReason:'placement_unresolved'};
  // A crypto-only batch can run continuously. Mixed batches wait together so
  // opening crypto buys cannot get ahead of equity sells that fund them.
  const sessions=legs.map(leg=>tradingSessionPolicy('robinhood',Object.hasOwn(leg.order_request,'currency_pair_id')?'crypto':'equity'));
  const now=clock(),closed=sessions.filter(session=>!session.isOpen(now));
  if(closed.length){
   await park(allocationId,MARKET_CLOSED,Math.max(...closed.map(session=>session.nextOpen(now))));
   return {...base,parkedReason:MARKET_CLOSED};
  }
  // Pre-flight: one read of buying power, net of the sells that go out first.
  const quotes=new Map((await database.use(db=>db.query<{symbol:string;price:string}>(`SELECT symbol,price::text AS price FROM market_quotes WHERE symbol=ANY($1)`,[legs.filter(l=>!Object.hasOwn(l.order_request,'currency_pair_id')).map(l=>l.symbol)]))).rows.map(r=>[r.symbol,Number(r.price)]));
  const buys=legs.filter(l=>l.side==='buy').reduce((n,l)=>n+(Number(l.order_request.dollar_amount)||0),0);
  const sells=legs.filter(l=>l.side==='sell').reduce((n,l)=>{
   const dollars=Number(l.order_request.dollar_amount),quantity=Number(l.order_request.quantity),price=Object.hasOwn(l.order_request,'currency_pair_id')?undefined:quotes.get(l.symbol);
   return n+(Number.isFinite(dollars)&&dollars>0?dollars:Number.isFinite(quantity)&&price!==undefined?quantity*price:0);
  },0);
  const buyTotal=Math.max(0,Math.round((buys-sells)*100)/100);
  if(buyTotal>0){
   const available=await buyingPower(accountId).catch(()=>null);
   if(buyingPowerShort(buyTotal,available)){
    await park(allocationId,INSUFFICIENT_BUYING_POWER,clock()+FAILURE_PARK_MS);
    return {...base,parkedReason:INSUFFICIENT_BUYING_POWER};
   }
  }
  let placed=0;
  for(const leg of legs){
   if(leg.transaction_id===null){
    await markFailed(leg.id,'invalid_execution_plan');
    await park(allocationId,'delegated_invalid_execution_plan',clock()+FAILURE_PARK_MS);
    return {...base,placed,failed:1};
   }
   // A buy planned before the member blocked its ticker never goes out; the rest carries on.
   if(leg.side==='buy'&&blocked.has(leg.symbol.toUpperCase())){await markFailed(leg.id,'symbol_blocked');continue;}
   let intentId:string|null=null;
   try{
    const {intent}=await deps.orderWriter.review({accountId,order:leg.order_request,allocationId,transactionId:leg.transaction_id});
    intentId=intent.id;
    const claimed=await database.use(db=>db.query(`UPDATE strategy_executions SET status='reviewed',order_intent_id=$2,reviewed_at=$3,updated_at=$3 WHERE id=$1 AND status='queued' RETURNING id`,[leg.id,intent.id,iso()]));
    if(!claimed.rows.length)continue; // another pass took this leg
    await database.use(db=>db.query(`UPDATE strategy_executions SET status='submitting',updated_at=$2 WHERE id=$1`,[leg.id,iso()]));
    const done=await deps.orderWriter.confirm(intent.id);
    if(done.status==='approval_pending'){
     await database.use(db=>db.query(`UPDATE strategy_executions SET status='placement_unknown',failure_code='provider_approval_pending',updated_at=$2 WHERE id=$1`,[leg.id,iso()]));
     await park(allocationId,'provider_approval_pending',clock()+FAILURE_PARK_MS);
     return {...base,placed,parkedReason:'provider_approval_pending'};
    }
    if(['placing','placement_unknown'].includes(done.status))throw new PlacementUnknownError('Submission requires reconciliation');
    if(done.status!=='placed')throw new Error('Order was not accepted');
    await database.use(db=>db.query(`UPDATE strategy_executions SET status='submitted',submitted_at=$2,updated_at=$2 WHERE id=$1`,[leg.id,done.placedAt??iso()]));
    placed+=1;
   }catch(error){
    if(error instanceof PlacementUnknownError){
     // Never resent: the next sync matches it by ref_id; later buys wait for it.
     await database.use(db=>db.query(`UPDATE strategy_executions SET status='placement_unknown',failure_code='placement_unknown',updated_at=$2 WHERE id=$1`,[leg.id,iso()]));
     return {...base,placed,parkedReason:'placement_unresolved'};
    }
    const current=await legStatus(leg.id);
    // A leg another pass already took is not this pass's failure.
    if(current!==undefined&&!['queued','reviewed','submitting','failed'].includes(current)){
     if(UNRESOLVED.includes(current))return {...base,placed,parkedReason:'placement_unresolved'};
     continue;
    }
    // Robinhood refusing the request outright is provider_invalid_request; anything else is named by its class.
    const intentStatus=intentId===null?undefined:(await database.use(db=>db.query<{status:string}>('SELECT status FROM order_intents WHERE id=$1',[intentId]))).rows[0]?.status;
    const code=intentStatus==='rejected'?'provider_invalid_request':`delegated_${errorCode(error)}`;
    await database.use(db=>db.query(`UPDATE strategy_executions SET status='failed',failure_code=$2,terminal_at=$3,updated_at=$3,order_intent_id=coalesce(order_intent_id,$4) WHERE id=$1 AND status IN ('queued','reviewed','submitting')`,[leg.id,code,iso(),intentId]));
    await park(allocationId,code,clock()+FAILURE_PARK_MS);
    return {...base,placed,failed:1};
   }
  }
  return {...base,placed};
 }

 return {
  async executeAllocation(allocationId,options={}){
   const base:ExecutionOutcome={allocationId,placed:0,failed:0,parkedReason:null};
   const a=(await database.use(db=>db.query<{status:string;account_id:string;orders_confirmed_at:Date|null;restore_required:boolean}>(
    'SELECT status,account_id,orders_confirmed_at,restore_required FROM strategy_allocations WHERE id=$1',[allocationId]))).rows[0];
   if(!a)return {...base,parkedReason:'allocation_not_found'};
   if(a.status!=='active'||a.restore_required)return {...base,parkedReason:a.restore_required?'restore_required':`allocation_${a.status}`};
   // Confirming from the queue: the member has seen every leg planned so far.
   let confirmedAt=a.orders_confirmed_at===null?null:new Date(a.orders_confirmed_at).toISOString();
   if(options.confirmed){
    confirmedAt=iso();
    await database.use(db=>db.query(`UPDATE strategy_allocations SET orders_confirmed_at=$2,planning_reason_code=CASE WHEN planning_reason_code=$3 THEN NULL ELSE planning_reason_code END,
     planning_deferred_until=CASE WHEN planning_reason_code=$3 THEN NULL ELSE planning_deferred_until END,updated_at=$2 WHERE id=$1`,[allocationId,confirmedAt,AWAITING_CONFIRMATION]));
   }
   const preferences=await readTradingPreferences(database);
   // A member who confirms every trade holds any leg planned after their last confirmation.
   if(preferences.confirmTrades){
    const unconfirmed=(await database.use(db=>db.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status='queued' AND ($2::timestamptz IS NULL OR created_at>$2) LIMIT 1`,[allocationId,confirmedAt]))).rows.length;
    if(unconfirmed){
     await park(allocationId,AWAITING_CONFIRMATION,clock()+CONFIRMATION_RECHECK_MS);
     return {...base,parkedReason:AWAITING_CONFIRMATION};
    }
   }
   if(placing.has(allocationId))return {...base,parkedReason:'placement_in_progress'};
   placing.add(allocationId);
   try{return await place(allocationId,a.account_id,base,new Set(preferences.blockedSymbols));}
   finally{placing.delete(allocationId);}
  },

  async settleLegs(accountId){
   await database.use(db=>db.transaction(async tx=>{
    const now=iso();
    // Intent outcomes: a placement the writer recorded (or the sync matched by ref_id) moves its leg on.
    await tx.query(`UPDATE strategy_executions e SET status='submitted',submitted_at=coalesce(e.submitted_at,i.placed_at,$2),failure_code=NULL,updated_at=$2
     FROM order_intents i WHERE e.order_intent_id=i.id AND e.account_id=$1 AND i.status='placed' AND e.status IN ('reviewed','submitting','placement_unknown','reconciliation_required')`,[accountId,now]);
    await tx.query(`UPDATE strategy_executions e SET status='failed',failure_code=coalesce(i.error_code,CASE i.status WHEN 'expired' THEN 'review_expired' ELSE 'provider_invalid_request' END),terminal_at=$2,updated_at=$2
     FROM order_intents i WHERE e.order_intent_id=i.id AND e.account_id=$1 AND i.status IN ('rejected','expired') AND (e.status IN ('reviewed','submitting') OR (e.status='placement_unknown' AND e.failure_code='provider_approval_pending'))`,[accountId,now]);
    await tx.query(`UPDATE strategy_executions e SET status='placement_unknown',updated_at=$2
     FROM order_intents i WHERE e.order_intent_id=i.id AND e.account_id=$1 AND i.status IN ('placement_unknown','placing') AND e.status IN ('reviewed','submitting')`,[accountId,now]);
    // Unknown too long: a person (reconciliation) decides, never a resend.
    await tx.query(`UPDATE strategy_executions e SET status='reconciliation_required',failure_code='placement_unknown',updated_at=$2
     FROM order_intents i WHERE e.order_intent_id=i.id AND e.account_id=$1 AND i.status='placement_unknown' AND e.status='placement_unknown' AND i.updated_at<$3`,[accountId,now,iso(clock()-UNKNOWN_RECONCILE_MS)]);
    // Crypto fills are accounted atomically in the shared Take ledger before a
    // checkpoint exists. Never send them through the equity attribution sweep.
    await tx.query(`UPDATE strategy_executions e SET status=CASE WHEN f.snapshot->>'state'='filled' THEN 'filled'
      WHEN f.snapshot->>'state' IN ('canceled','voided') THEN 'cancelled'
      WHEN f.snapshot->>'state' IN ('rejected','failed') THEN 'failed' ELSE 'partially_filled' END,
      terminal_at=CASE WHEN (f.snapshot->>'terminal')::boolean THEN $2::timestamptz ELSE NULL END,updated_at=$2
      FROM order_intents i JOIN order_fill_checkpoints f ON f.intent_id=i.id
      WHERE e.order_intent_id=i.id AND e.account_id=$1 AND i.asset_class='crypto' AND e.status IN ('submitted','partially_filled')
       AND ((f.snapshot->>'terminal')::boolean OR f.snapshot->>'state'='partially_filled')`,[accountId,now]);
    // Synced order states move submitted legs to their end.
    await tx.query(`UPDATE strategy_executions e SET status=CASE WHEN o.state='filled' THEN 'filled' WHEN o.state IN ('cancelled','canceled','voided','expired') THEN 'cancelled' WHEN o.state IN ('rejected','failed') THEN 'failed' ELSE 'partially_filled' END,
     failure_code=CASE WHEN o.state IN ('rejected','failed') THEN 'provider_'||o.state ELSE e.failure_code END,
     terminal_at=CASE WHEN o.terminal THEN $2::timestamptz ELSE NULL END,updated_at=$2
     FROM order_intents i JOIN account_orders o ON o.account_id=i.account_id AND o.provider='robinhood' AND o.provider_ref=i.provider_order_ref
     WHERE e.order_intent_id=i.id AND i.asset_class='equity' AND e.account_id=$1 AND e.status IN ('submitted','partially_filled') AND (o.terminal OR o.state='partially_filled')`,[accountId,now]);
   }));
  },
 };
}
