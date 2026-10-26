import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import type {AllocationReview} from '../../shared/allocations';
import {allocation,amount,append,format,holdings,instruction,unreleased} from './ledger';
import {claimed,measuredCash,measuredShares} from './evidence';
import {closeCase,keepReduced,reconcile,type ReconciliationCase} from './reconciliation';

// Review and resume. An allocation imported from another app,
// or paused by a database restore, carries `restore_required` and never
// trades until the member has seen what it claims against what the account
// holds now. The review re-measures every claim from fresh account evidence
// (the reconciliation core opens a case for any shortfall and settles gaps
// under $1 itself); resuming is refused while any case touches the
// allocation, and otherwise clears the fence, settles the import's
// reconciliation instruction and makes it active. Pause/resume after that
// follows the hosted status rules: resume refuses an open case.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
const decimal=(value:string|null)=>value===null?null:format(amount(value));

export function createAllocationResume(database:Database,clock=()=>Date.now()){
 const atomic=<T>(work:(tx:Transaction,now:string)=>Promise<T>)=>database.use(db=>db.transaction(tx=>work(tx,new Date(clock()).toISOString())));

 async function review(tx:Transaction,allocationId:string,now:string):Promise<AllocationReview>{
  const a=await allocation(tx,allocationId);
  if(!['active','paused','diverged'].includes(a.status))throw new Error('Allocation is not following its take');
  const blockers:string[]=[];
  if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND attribution_state='pending' LIMIT 1`,[a.account_id])).rows.length)blockers.push('fills_pending');
  // A reverse split or unread share change waits for the member's decision on its own card.
  const shareEvents=(await tx.query<{id:string;symbol:string;effective_on:string|Date;kind:'split'|'unclassified';split_to:number|null;split_from:number|null}>(
   `SELECT id,symbol,effective_on,kind,split_to,split_from FROM symbol_share_events WHERE status='pending_review' AND details->'paused' ? $1 ORDER BY effective_on`,[a.id])).rows
   .map(e=>({id:e.id,symbol:e.symbol,effectiveOn:typeof e.effective_on==='string'?e.effective_on.slice(0,10):e.effective_on.toISOString().slice(0,10),kind:e.kind,splitTo:e.split_to,splitFrom:e.split_from}));
  if(shareEvents.length)blockers.push('share_event_pending');
  const held=await holdings(tx,a.id);
  const owned=held.positions.filter(p=>amount(p.quantity)!==0n);
  // Measure first: stale or unsettled evidence is reported, never turned into a case.
  const measured=new Map<string,bigint>();let cash:bigint|null=null;
  try{
   for(const p of owned)measured.set(p.instrumentRef,(await measuredShares(tx,a.account_id,p.instrumentRef,now)).quantity);
   cash=(await measuredCash(tx,a.account_id,now)).cash;
  }catch{blockers.push('evidence_stale');}
  if(blockers.length===0){
   // Re-measure the account's claims; a shortfall opens (or refreshes) its case, gaps under $1 settle.
   for(const p of owned)await reconcile(tx,a.account_id,p.instrumentRef,now);
   await reconcile(tx,a.account_id,null,now);
  }
  const free=async(instrumentRef:string|null,observed:bigint|null|undefined)=>{
   if(observed===null||observed===undefined)return null;
   const others=(await claimed(tx,a.account_id,instrumentRef)).filter(c=>c.allocationId!==a.id).reduce((n,c)=>n+amount(c.quantity),0n);
   return format(observed-others<0n?0n:observed-others);
  };
  const after=await holdings(tx,a.id);
  const positions:AllocationReview['positions']=[];
  for(const p of after.positions.filter(p=>amount(p.quantity)!==0n))positions.push({instrumentRef:p.instrumentRef,symbol:p.symbol,claimed:p.quantity,available:await free(p.instrumentRef,measured.get(p.instrumentRef))});
  const cashAvailable=await free(null,cash);
  const cases=(await tx.query<ReconciliationCase&{symbol:string|null}>(`SELECT c.*,(SELECT max(e.symbol) FROM strategy_attribution_entries e WHERE e.account_id=c.account_id AND e.instrument_ref=c.instrument_ref) AS symbol
   FROM strategy_reconciliation_cases c WHERE c.account_id=$1 AND c.resolved_at IS NULL
   AND c.impacts @> jsonb_build_array(jsonb_build_object('allocationId',$2::text)) ORDER BY c.created_at,c.id`,[a.account_id,a.id])).rows;
  const fresh=await tx.query<{status:string;restore_required:boolean;planning_reason_code:string|null}>('SELECT status,restore_required,planning_reason_code FROM strategy_allocations WHERE id=$1',[a.id]);
  const state=fresh.rows[0];
  // An import leaves its reconciliation instruction open until the first resume; a restore pauses without one.
  const importing=state.restore_required&&(await tx.query(`SELECT 1 FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='reconciliation' AND pending_reason='import_reconciliation_required' AND outcome IS NULL LIMIT 1`,[a.id])).rows.length>0;
  const pauseReason:AllocationReview['pauseReason']=state.status==='active'?null:state.restore_required?(importing?'imported':'restored')
   :state.status==='diverged'?'account_changed':state.planning_reason_code==='loss_limit_reached'?'loss_limit'
   :state.planning_reason_code==='share_event'||shareEvents.length?'share_event':'paused_by_you';
  return {
   allocationId:a.id,status:state.status as AllocationReview['status'],restoreRequired:state.restore_required,pauseReason,shareEvents,reviewedAt:now,
   positions,cash:{claimed:after.cash,available:cashAvailable},
   cases:cases.map(c=>c.cause==='negative_subledger_balance'
    // The take's own books went below zero: what it holds is shown as claimed, the shortfall as the difference.
    ?{id:c.id,cause:c.cause,symbol:null,claimed:after.cash,observed:null,difference:amount(after.cash)<0n?format(-amount(after.cash)):null,yourShare:null,canKeepReduced:false,
     canCover:amount(after.cash)<0n&&!after.positions.some(p=>amount(p.quantity)<0n),
     oversold:after.positions.filter(p=>amount(p.quantity)<0n).map(p=>({symbol:p.symbol,quantity:format(-amount(p.quantity))}))}
    :{id:c.id,cause:c.cause,symbol:c.symbol,claimed:decimal(c.claimed),observed:decimal(c.observed),difference:decimal(c.difference),
    yourShare:decimal(c.impacts.find(i=>i.allocationId===a.id)?.quantity??null),canKeepReduced:['cash_shortfall','position_shortfall'].includes(c.cause)&&c.observed!==null}),
   blockers:[...new Set(blockers)],
   ready:cases.length===0&&blockers.length===0,
  };
 }

 return {
  /** Re-measures the allocation's claims from fresh evidence; opens or settles cases as found. */
  review:(allocationId:string)=>atomic((tx,now)=>review(tx,allocationId,now)),
  /** Accepts a shortfall case: the claims shrink to what the account still holds. */
  keepReduced:(allocationId:string,caseId:string)=>atomic(async(tx,now)=>{
   const c=(await tx.query<ReconciliationCase>('SELECT * FROM strategy_reconciliation_cases WHERE id=$1',[caseId])).rows[0];
   if(!c||!c.impacts.some(i=>i.allocationId===allocationId))throw new Error('Case does not concern this allocation');
   await keepReduced(tx,caseId,now);
   return review(tx,allocationId,now);
  }),
  /**
   * The take spent more cash than its books held: an order it placed was paid for partly
   * from the member's own cash in the same account. Hosted had an operator record the
   * shortfall as capital the member put in (ledger-correction.ts); here the member does.
   * Nothing is bought, sold or moved: the entry records what already happened, under its
   * own instruction and source kind, and the case closes as covered. Refused unless the
   * books are below zero now; a take that sold shares it did not hold cannot be covered.
   */
  coverShortfall:(allocationId:string,caseId:string)=>atomic(async(tx,now)=>{
   const c=(await tx.query<ReconciliationCase>('SELECT * FROM strategy_reconciliation_cases WHERE id=$1',[caseId])).rows[0];
   if(!c||c.resolved_at||c.cause!=='negative_subledger_balance'||!c.impacts.some(i=>i.allocationId===allocationId))throw new Error('There is no shortfall to cover on this take');
   const a=await allocation(tx,allocationId);
   const held=await holdings(tx,allocationId);
   if(held.positions.some(p=>amount(p.quantity)<0n))throw new Error('This take sold more shares than it held; close it instead');
   const shortfall=-amount(held.cash);
   if(shortfall<=0n){await closeCase(tx,a.account_id,c.scope,now,'ledger_not_negative');return review(tx,allocationId,now);}
   const covered=format(shortfall);
   const transactionId=await instruction(tx,{allocationId,kind:'reconciliation',cause:`cover:${c.id}`,requestedAmount:covered},now);
   await append(tx,{allocationId,transactionId,entryType:'capital_allocated',cashDelta:covered,cause:`cover:${c.id}`,
    sourceKind:'member_correction',sourceRef:c.id,occurredAt:now,
    metadata:{correction:true,reason:'Take spent more cash than it held; the member covered the shortfall from their own account cash',caseId:c.id}},now);
   await tx.query(`UPDATE strategy_allocations SET allocation_value=allocation_value+$2::numeric,
    planning_reason_code=CASE WHEN planning_reason_code='negative_subledger_balance' THEN NULL ELSE planning_reason_code END,
    planning_deferred_until=CASE WHEN planning_reason_code='negative_subledger_balance' THEN NULL ELSE planning_deferred_until END,updated_at=$3 WHERE id=$1`,[allocationId,covered,now]);
   await closeCase(tx,a.account_id,c.scope,now,'member_capital');
   return review(tx,allocationId,now);
  }),
  /** Reviewed and clean: lift the restore fence (or a member pause) and follow the strategy again. */
  resume:(allocationId:string)=>atomic(async(tx,now)=>{
   const result=await review(tx,allocationId,now);
   if(!result.ready)throw new Error(result.cases.length?'Resolve the differences before resuming':'Sync the account before resuming');
   if(result.status!=='paused')throw new Error('Only a paused allocation can resume');
   await tx.query(`UPDATE strategy_allocations SET status='active',restore_required=false,resume_status=NULL,updated_at=$2 WHERE id=$1 AND status IN ${unreleased}`,[allocationId,now]);
   // An imported allocation already holds its applied version: record its sequence so the
   // planner treats it as current rather than a first purchase or a pending republish.
   await tx.query(`UPDATE strategy_allocations a SET applied_version_sequence=v.sequence,activated_at=coalesce(a.activated_at,$2)
    FROM strategy_versions v WHERE a.id=$1 AND v.id=a.applied_version_id AND a.applied_version_sequence<v.sequence`,[allocationId,now]);
   // The import's opening instruction waited on exactly this review.
   await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE allocation_id=$1 AND kind='reconciliation' AND pending_reason='import_reconciliation_required'`,[allocationId]);
   return review(tx,allocationId,now);
  }),
  /** The member stops new orders; claims and history are unchanged. */
  pause:(allocationId:string)=>atomic(async(tx,now)=>{
   const a=await allocation(tx,allocationId);
   if(a.status!=='active')throw new Error('Only an active allocation can pause');
   await tx.query(`UPDATE strategy_allocations SET status='paused',updated_at=$2 WHERE id=$1`,[allocationId,now]);
   return review(tx,allocationId,now);
  }),
 };
}
