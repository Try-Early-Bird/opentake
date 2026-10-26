import {coinbaseCryptoSession} from '../trading/session-policy';
import type {AccountQueues} from '../execution/account-queues';
import {executionBasket} from '../mixed-execution/basket';
import {CoinbaseRebalanceCashError,rebalanceClaimsEvidence} from './rebalance-warning';
import type {RebalanceReason} from '../../shared/diagnostics';
import {coinbaseDriftExceeded} from './drift';
import {readCoinbaseClaims} from './allocations';
import type {CoinbaseSpotPosition} from '../../shared/portfolio';
import type {NotificationWriter,NotificationKey} from '../../shared/notifications';
import {randomUUID} from 'node:crypto';
import type {createDatabaseLifecycle} from '../database';
import {lastRebalanceDayFor} from '../strategies/model-valuation';
import {basketSchema} from '../../shared/strategies';
import {NoCoinbaseOrdersError,ruleTradeHoldsTake,type createCoinbaseOrderReviews} from './order-reviews';
import type {createCoinbaseExecution} from './execution';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Run={id:string;allocation_id:string;scheduled_on:string;review_id:string|null;phase:'initial'|'buy';attempts:number;trigger:'schedule'|'drift'};
/** Coinbase trades around the clock; schedule periods use UTC calendar days. */
export function coinbaseScheduledDay(schedule:Parameters<typeof lastRebalanceDayFor>[1],now:number){
 const today=new Date(now).toISOString().slice(0,10);
 const days=Array.from({length:370},(_,i)=>new Date(now-(369-i)*86400000).toISOString().slice(0,10));
 return lastRebalanceDayFor(days,schedule,today);
}
type Candidate={id:string;strategy_id:string;version_id:string;take_id:string;spec:unknown;created_at:Date;quote:string;drift_enabled:boolean;account_id:string};
export function createCoinbaseScheduler(database:Database,orders:ReturnType<typeof createCoinbaseOrderReviews>,execution:ReturnType<typeof createCoinbaseExecution>,enabled:()=>boolean,clock=Date.now,notifications?:NotificationWriter,log?:(reason:RebalanceReason,takeId:string)=>void,accounts?:AccountQueues){
 const last=new Map<string,number>();
 function report(reason:RebalanceReason,takeId:string){const key=`${takeId}:${reason}`;const prior=last.get(key);if(prior!==undefined&&clock()-prior<300000)return;if(last.size>1000)last.clear();last.set(key,clock());log?.(reason,takeId);}
 let working:Promise<void>|undefined;
 const iso=()=>new Date(clock()).toISOString();
 async function pass(signal?:AbortSignal){
  if(!coinbaseCryptoSession.isOpen(clock()))return;
  if(!enabled()||(!accounts&&execution.busy()))return;
  const candidates=await database.use(async db=>(await db.query<Candidate>(`SELECT a.id,a.strategy_id,a.version_id,a.account_id,a.drift_enabled,t.id AS take_id,v.spec,greatest(a.created_at,(SELECT max(d.created_at) FROM coinbase_allocation_decisions d WHERE d.allocation_id=a.id AND d.kind='adopt')) AS created_at,
   (SELECT e.asset FROM coinbase_allocation_entries e WHERE e.allocation_id=a.id AND e.kind='capital' AND e.asset IN ('USD','USDC') ORDER BY e.occurred_at DESC LIMIT 1) AS quote
   FROM coinbase_allocations a JOIN strategies s ON s.id=a.strategy_id JOIN strategy_versions v ON v.id=s.current_version_id
   JOIN takes t ON t.strategy_id=s.id JOIN linked_accounts la ON la.id=a.account_id JOIN platform_connections c ON c.id=la.connection_id JOIN coinbase_connection_details d ON d.connection_id=c.id
   WHERE a.status='active' AND NOT a.restore_required AND a.version_id=v.id AND v.source_proposal_id=s.draft_revision_id
    AND s.archived_at IS NULL AND s.status='committed' AND c.status='connected' AND la.available AND d.can_trade
    AND NOT EXISTS(SELECT 1 FROM strategy_rule_trades r WHERE r.take_id=t.id AND ${ruleTradeHoldsTake('r')})
    AND NOT EXISTS(SELECT 1 FROM mixed_take_executions m WHERE m.take_id=t.id AND m.state<>'completed')
    AND NOT EXISTS(SELECT 1 FROM mixed_take_withdrawals w WHERE w.take_id=t.id AND w.state IN ('running','attention'))
    AND EXISTS(SELECT 1 FROM coinbase_allocation_entries e WHERE e.allocation_id=a.id GROUP BY e.asset HAVING sum(e.quantity)>0)
   ORDER BY a.id`)).rows);
  for(const candidate of candidates){
   if(!enabled()||signal?.aborted||(!accounts&&execution.busy()))return;
   // The account queue keeps this rebalance apart from rule trades, manual orders and
   // investments on the same account; other accounts are not held up.
   if(accounts)await accounts.run([candidate.account_id],()=>rebalance(candidate),{label:'coinbase rebalance',signal});
   else await rebalance(candidate);
  }
 }
 async function rebalance(candidate:Candidate){
  const parsed=basketSchema.safeParse(candidate.spec);
  if(!parsed.success||!['USD','USDC'].includes(candidate.quote))return;
  try{parsed.data=await database.use(db=>executionBasket(db,parsed.data,{strategyId:candidate.strategy_id,versionId:candidate.version_id,accountId:candidate.account_id},'coinbase'));}catch{return;}
  const scheduled=coinbaseScheduledDay(parsed.data.rebalance.schedule,clock());
  let due=scheduled&&candidate.created_at.toISOString().slice(0,10)<scheduled?scheduled:null;
  let trigger:'schedule'|'drift'='schedule';
  if((await database.use(db=>db.query("SELECT 1 FROM coinbase_rebalance_runs WHERE allocation_id=$1 AND state='attention' LIMIT 1",[candidate.id]))).rows.length)return;
  if(due&&(await database.use(db=>db.query("SELECT 1 FROM coinbase_rebalance_runs WHERE allocation_id=$1 AND scheduled_on=$2 AND trigger='schedule'",[candidate.id,due]))).rows.length)due=null;
  if(!due&&candidate.drift_enabled){
   const drift=await database.use(async db=>{
    const observation=(await db.query<{observed_at:Date;data:{warnings?:string[];portfolio:{currency:string};spotPositions:CoinbaseSpotPosition[]}}>('SELECT observed_at,data FROM coinbase_portfolio_observations WHERE account_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1',[candidate.account_id])).rows[0];
    if(!observation||clock()-observation.observed_at.getTime()>900000||clock()<observation.observed_at.getTime()||observation.data.warnings?.length){report('stale_data',candidate.take_id);return false;}
    return coinbaseDriftExceeded(parsed.data,(await readCoinbaseClaims(db,candidate.account_id)).filter(c=>c.allocationId===candidate.id),observation.data.spotPositions,observation.data.portfolio.currency);
   });
   if(drift){report('drift_detected',candidate.take_id);due=new Date(clock()).toISOString().slice(0,10);trigger='drift';}
  }
  // Existing runs finish before a later period is considered; uncertain orders never replay.
  let run=await database.use(async db=>(await db.query<Run>("SELECT id,allocation_id,scheduled_on::text,review_id,phase,attempts,trigger FROM coinbase_rebalance_runs WHERE allocation_id=$1 AND state IN ('pending','working') ORDER BY scheduled_on LIMIT 1",[candidate.id])).rows[0]);
  if(!run){
   if(!due)return;
   if(trigger==='drift'&&(await database.use(db=>db.query("SELECT 1 FROM coinbase_rebalance_runs WHERE allocation_id=$1 AND state='completed' AND (phase='buy' OR EXISTS(SELECT 1 FROM coinbase_allocation_orders o JOIN account_orders p ON p.account_id=o.account_id AND p.provider='coinbase' AND p.provider_ref=o.provider_order_ref WHERE o.cause LIKE 'review:'||coinbase_rebalance_runs.review_id::text||':%' AND p.state='filled')) AND (updated_at AT TIME ZONE 'UTC')::date=$2::date LIMIT 1",[candidate.id,due]))).rows.length){report('daily_limit',candidate.take_id);return;}
   // Recover legacy no-order completions only. Never reopen a run with a bound review
   // or a completed sell phase, where an exchange-side effect may already exist.
   if(trigger==='drift')await database.use(db=>db.query(`UPDATE coinbase_rebalance_runs SET state='pending',next_attempt_at=greatest(next_attempt_at,updated_at+interval '5 minutes')
    WHERE allocation_id=$1 AND scheduled_on=$2 AND trigger='drift' AND state='completed' AND review_id IS NULL AND phase='initial'`,[candidate.id,due]));
   await database.use(db=>db.query(`INSERT INTO coinbase_rebalance_runs(id,allocation_id,scheduled_on,next_attempt_at,created_at,updated_at,trigger) VALUES($1,$2,$3,$4,$4,$4,$5) ON CONFLICT(allocation_id,scheduled_on,trigger) DO NOTHING`,[randomUUID(),candidate.id,due,iso(),trigger]));
   run=await database.use(async db=>(await db.query<Run>("SELECT id,allocation_id,scheduled_on::text,review_id,phase,attempts,trigger FROM coinbase_rebalance_runs WHERE allocation_id=$1 AND scheduled_on=$2 AND trigger=$3 AND state='pending'",[candidate.id,due,trigger])).rows[0]);
  }
  if(!run)return;
  // Unsent drift retries must still meet the current rule and have fresh data.
  if(run.trigger==='drift'&&run.phase==='initial'&&!run.review_id&&(!candidate.drift_enabled||trigger!=='drift'))return;
  const claimsEvidence=await database.use(async db=>rebalanceClaimsEvidence((await readCoinbaseClaims(db,candidate.account_id)).filter(c=>c.allocationId===candidate.id)));
  const ready=await database.use(async db=>(await db.query("SELECT 1 FROM coinbase_rebalance_runs WHERE id=$1 AND state<>'attention' AND (next_attempt_at<=$2 OR (warning_code IS NOT NULL AND (warning_details->>'claimsHash' IS DISTINCT FROM $3)))",[run.id,iso(),claimsEvidence])).rows.length);
  if(!ready)return;
  try{
   if(run.review_id){
    const review=await execution.view(run.review_id);
    if(review.state==='confirmed'){
     const unsent=review.orders.every(o=>!o.execution||o.execution.state==='reserved');
     if(unsent&&review.needsConfirmation)await notify(run.id,true);
     if(unsent&&!review.needsConfirmation&&enabled())await execution.submit(review.id);
     return;
    }
    if(review.state==='settled'){
     // Terminal partial results are reconciled, not an unresolved dispatch.
     // Keep their holdings/cash eligible for future scheduled or drift runs.
     if(!review.orders.every(o=>o.execution?.state==='filled')){await finish(run.id,'completed');return;}
     if(review.phase==='sell'&&run.phase==='initial'){
      await database.use(db=>db.query("UPDATE coinbase_rebalance_runs SET phase='buy',review_id=NULL,updated_at=$2 WHERE id=$1",[run.id,iso()]));
      run={...run,phase:'buy',review_id:null};
     }else{report('completed',candidate.take_id);await finish(run.id,'completed');return;}
    }else if(review.state==='cancelled'){await finish(run.id,'completed');return;
    }else if(review.state==='preview'){
     if(!enabled())return;
     const reserved=await orders.confirm(review.id);
     if(reserved.needsConfirmation){report('approval_required',candidate.take_id);await notify(run.id,true);}
     else if(enabled()){await notify(run.id,false);await execution.submit(review.id);}
     return;
    }else{await finish(run.id,'attention');return;}
   }
   const blocked=await database.use(async db=>(await db.query(`SELECT 1 FROM coinbase_allocation_orders WHERE allocation_id=$1 AND state<>'closed'
    UNION ALL SELECT 1 FROM coinbase_investments i JOIN takes t ON t.id=i.take_id JOIN coinbase_allocations a ON a.strategy_id=t.strategy_id WHERE a.id=$1 AND i.state IN ('started','funded','ready') LIMIT 1`,[candidate.id])).rows.length);
   if(blocked){report('orders_pending',candidate.take_id);return;}
   if(!enabled())return;
   const review=await orders.preview({takeId:candidate.take_id,quote:candidate.quote},undefined,{scheduledOn:run.scheduled_on,phase:run.phase,trigger:run.trigger});
   // A sell phase must finish and reconcile before buys can use its proceeds.
   if(run.phase==='buy'&&review.phase==='sell'){await finish(run.id,'attention');return;}
   await database.use(db=>db.query("UPDATE coinbase_rebalance_runs SET review_id=$2,state='working',warning_code=NULL,warning_details=NULL,updated_at=$3 WHERE id=$1",[run.id,review.id,iso()]));
   if(!enabled())return;
   const reserved=await orders.confirm(review.id);
   if(reserved.needsConfirmation){report('approval_required',candidate.take_id);await notify(run.id,true);}
     else if(enabled()){await notify(run.id,false);await execution.submit(review.id);}
  }catch(error){
   if(error instanceof NoCoinbaseOrdersError){const belowMinimum=error.message.includes('below Coinbase minimum');await database.use(db=>db.query('UPDATE coinbase_rebalance_runs SET warning_code=$2,warning_details=$3 WHERE id=$1',[run.id,belowMinimum?'below_minimum':null,JSON.stringify({claimsHash:claimsEvidence})]));report(belowMinimum?'below_minimum':'on_target',candidate.take_id);
    if(run.trigger==='drift'&&run.phase==='initial'){
     await database.use(db=>db.query("UPDATE coinbase_rebalance_runs SET state='pending',next_attempt_at=$2::timestamptz+interval '5 minutes',updated_at=$2 WHERE id=$1",[run.id,iso()]));
    }else await finish(run.id,'completed');
    return;}
   // Once a review is bound, leave any uncertain dispatch for reconciliation/member action.
   const bound=await database.use(async db=>(await db.query<{review_id:string|null}>('SELECT review_id FROM coinbase_rebalance_runs WHERE id=$1',[run.id])).rows[0]);
   const insufficient=error instanceof Error&&['Coinbase order amounts and fees exceed this Take’s available cash. Retry the investment preview.','Sale proceeds do not cover fees.','Insufficient unassigned cash for this investment.'].includes(error.message);
   await database.use(db=>db.query(`UPDATE coinbase_rebalance_runs SET state=$2,attempts=attempts+1,next_attempt_at=$3::timestamptz+interval '1 minute'*least($4::int,power(2,least(attempts,10))),updated_at=$3 WHERE id=$1`,[run.id,bound.review_id?'attention':'pending',iso(),insufficient?5:1440]));
   await database.use(db=>db.query('UPDATE coinbase_rebalance_runs SET warning_code=$2,warning_details=$3 WHERE id=$1',[run.id,insufficient?'insufficient_funds':null,JSON.stringify({claimsHash:claimsEvidence,...(error instanceof CoinbaseRebalanceCashError?{cash:error.cash}:{})})]));
   report(insufficient?'insufficient_funds':bound.review_id?'attention_required':'retry_scheduled',candidate.take_id);
   if(bound.review_id)await notify(run.id,true,'Rebalance needs attention');
  }
 }
 async function finish(id:string,state:'completed'|'attention'){await notify(id,state==='attention',state==='attention'?'Rebalance needs attention':undefined);await database.use(db=>db.query('UPDATE coinbase_rebalance_runs SET state=$2,updated_at=$3 WHERE id=$1',[id,state,iso()]));}
 async function notify(id:string,attention:boolean,title='Rebalance ready for review'){
  if(!notifications)return;
  const row=await database.use(async db=>(await db.query<{strategy_id:string}>(`SELECT a.strategy_id FROM coinbase_rebalance_runs r JOIN coinbase_allocations a ON a.id=r.allocation_id WHERE r.id=$1`,[id])).rows[0]);
  if(!row)return;
  const key:NotificationKey={kind:'trading_waiting',context:{strategyId:row.strategy_id},source:{type:'trading_queue',id},eventKey:'coinbase-rebalance'};
  if(attention)await notifications.record({...key,tier:'act_now',requiresAction:true,occurredAt:iso(),title,body:'Open this Take to review its Coinbase rebalance.'});
  else await notifications.resolve(key);
 }
 return {tick(signal?:AbortSignal){if(!working)working=pass(signal).finally(()=>{working=undefined;});return working;}};
}
