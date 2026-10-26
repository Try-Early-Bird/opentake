import {holdCryptoUnits,type CryptoSellAvailability} from './unit-holds';
import {randomUUID} from 'node:crypto';
import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import {cryptoPreviewInput} from './crypto-preview-contract';
import {amount,positive,fingerprint} from '../allocations/ledger';
import {holdOrderCash} from './cash-holds';
import {reconcileRobinhoodCryptoEvidence,type CryptoSubmissionResult,type CryptoSubmissionScope,type CryptoReconciliationRead} from './robinhood-crypto-adapter';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export interface CryptoIntentRow {
 id:string;account_id:string;allocation_id:string|null;transaction_id:string|null;ref_id:string;
 order_request:ReturnType<typeof cryptoPreviewInput.parse>;maximum_debit:string;status:string;
 approval_ref:string|null;provider_order_ref:string|null;expires_at:Date;review_result:unknown;confirmed_at:Date|null;updated_at:Date;
}
/** Host-only journal for the existing order_intents table. No transport or IPC surface.
 * Buys reserve shared USD; Take sells reserve exact owned units until settlement.
 * A preview estimate is NOT a debit cap. */
export function createCryptoOrderJournal(database:Database,clock=()=>Date.now()){
 const now=()=>new Date(clock()).toISOString();
 const read=async(tx:Pick<Transaction,'query'>,id:string)=>{
  const row=(await tx.query<CryptoIntentRow>(`SELECT *,maximum_debit::text FROM order_intents WHERE id=$1 AND asset_class='crypto'`,[id])).rows[0];
  if(!row)throw Error('Crypto intent not found');return row;
 };
 return {
  get:(id:string)=>database.use(tx=>read(tx,id)),
  async review(input:{accountId:string;order:unknown;maximumDebit:string;review:unknown;allocationId?:string;transactionId?:string}){
   const order=cryptoPreviewInput.parse(input.order),debit=amount(input.maximumDebit);
   if(order.side==='buy')positive(input.maximumDebit);
   else if(debit!==0n||!input.allocationId||!input.transactionId||!order.quantity)throw Error('Crypto sells require Take-owned units and zero cash debit');
   if(order.side==='buy'&&order.dollar_amount&&debit<amount(order.dollar_amount))throw Error('Maximum debit cannot be below the entered USD amount');
   if(order.side==='buy'&&order.quantity&&order.limit_price&&debit*10n**18n<amount(order.quantity)*amount(order.limit_price))throw Error('Maximum debit cannot be below limit notional');
   if((input.allocationId===undefined)!==(input.transactionId===undefined))throw Error('A Take order must name its instruction');
   const id=randomUUID(),at=now();
   await database.use(tx=>tx.query(`INSERT INTO order_intents(id,account_id,allocation_id,transaction_id,asset_class,status,ref_id,order_request,review_result,reviewed_at,expires_at,updated_at,maximum_debit)
    VALUES($1,$2,$3,$4,'crypto','reviewed',$5,$6,$7,$8,$9,$8,$10)`,[id,input.accountId,input.allocationId??null,input.transactionId??null,randomUUID(),JSON.stringify(order),JSON.stringify(input.review),at,new Date(clock()+120000).toISOString(),input.maximumDebit]));
   return database.use(tx=>read(tx,id));
  },
  /** Caller validates current provider eligibility and reviewed terms before calling;
   * authorize rechecks local policy inside this transaction. Never perform network I/O here. */
  claim(id:string,authorize:(tx:Transaction,row:CryptoIntentRow)=>Promise<void>,sellAvailability?:CryptoSellAvailability){
   return database.use(db=>db.transaction(async tx=>{
    const row=await read(tx,id);
    if(row.status!=='reviewed'||new Date(row.expires_at).getTime()<=clock())throw Error('Review expired or order already attempted');
    if(row.allocation_id){
     if(!(await tx.query(`SELECT 1 FROM strategy_allocations a JOIN strategy_allocation_transactions t ON t.allocation_id=a.id
      WHERE a.id=$1 AND t.id=$2 AND a.account_id=$3 AND a.status='active' AND NOT a.restore_required AND t.outcome IS NULL`,[row.allocation_id,row.transaction_id,row.account_id])).rows.length)throw Error('Take instruction is no longer eligible');
    }
    await authorize(tx,row);
    const at=now();
    if(new Date(row.expires_at).getTime()<=clock())throw Error('Review expired during authorization');
    if(row.order_request.side==='sell')await holdCryptoUnits(tx,row,sellAvailability,at);
    else await holdOrderCash(tx,{intentId:id,accountId:row.account_id,allocationId:row.allocation_id,maximumDebit:row.maximum_debit},at);
    const changed=await tx.query(`UPDATE order_intents SET status='placing',confirmed_at=$2,updated_at=$2 WHERE id=$1 AND status='reviewed' AND expires_at>$2 RETURNING id`,[id,now()]);
    if(!changed.rows.length)throw Error('Order already attempted or review expired');
    return row;
   }));
  },
  record(id:string,result:CryptoSubmissionResult){
   return database.use(db=>db.transaction(async tx=>{
    const row=await read(tx,id),at=now();
    if(result.state==='accepted'&&row.status==='placed'&&row.provider_order_ref===result.providerRef)return;
    if(result.state==='approval_pending'&&row.status==='approval_pending'&&row.approval_ref===result.approvalRef)return;
    if(!['placing','placement_unknown'].includes(row.status))throw Error('Submission evidence conflicts with current intent');
    if(row.approval_ref&&result.approvalRef&&row.approval_ref!==result.approvalRef)throw Error('Conflicting crypto approval reference');
    const status=result.state==='accepted'?'placed':result.state==='approval_pending'?'approval_pending':result.state==='rejected'?'rejected':'placement_unknown';
    await tx.query(`UPDATE order_intents SET status=$2,provider_order_ref=$3,approval_ref=coalesce($4,approval_ref),
     error_code=$5,placement_result=$6,placed_at=CASE WHEN $2='placed' THEN $7::timestamptz ELSE placed_at END,updated_at=$7 WHERE id=$1`,
     [id,status,result.state==='accepted'?result.providerRef:null,result.approvalRef??null,
      result.state==='unknown'||result.state==='rejected'?result.code??null:null,JSON.stringify(result.evidence??null),at]);
    // Accepted, pending and uncertain orders retain the entire hold until fills,
    // cancellation and fresh cash evidence are reconciled by the accounting layer.
    if(result.state==='rejected'){
     await tx.query(`UPDATE order_cash_holds SET state='released',released_at=$2 WHERE intent_id=$1 AND state='held'`,[id,at]);
     await tx.query(`UPDATE order_unit_holds SET state='released',released_at=$2 WHERE intent_id=$1 AND state='held'`,[id,at]);
    }
   }));
  },
  /** Read-only provider recovery: never dispatches, and never releases accepted
   * order holds. Fill/cancel settlement belongs to the accounting layer. */
  reconcile(id:string,input:{scope:CryptoSubmissionScope;observedAt:string;read:CryptoReconciliationRead}){
   return database.use(db=>db.transaction(async tx=>{
    const row=await read(tx,id),at=now(),observed=Date.parse(input.observedAt);
    if(input.scope.accountId!==row.account_id||input.scope.clientRef!==row.ref_id||fingerprint(input.scope.order)!==fingerprint(row.order_request))throw Error('Reconciliation does not match the stored order');
    if(!Number.isFinite(observed)||observed>clock()||clock()-observed>60000||row.confirmed_at===null
     ||observed<new Date(row.confirmed_at).getTime()||observed<new Date(row.updated_at).getTime())throw Error('Fresh post-submission evidence required');
    // A late read cannot regress a bound or rejected submission. A transport still
    // running must finish or be marked uncertain before read reconciliation.
    if(!['placement_unknown','approval_pending'].includes(row.status))return row;
    const result=reconcileRobinhoodCryptoEvidence(input.scope,input.read,row.approval_ref);
    if(result.approvalRef&&row.approval_ref!==result.approvalRef)throw Error('Reconciliation changed the approval reference');
    if(result.state==='accepted'){
     await tx.query(`UPDATE order_intents SET status='placed',provider_order_ref=$2,placed_at=$3,updated_at=$3,error_code=NULL,placement_result=$4 WHERE id=$1`,[id,result.providerRef,at,JSON.stringify(result.evidence??null)]);
    }else if(result.state==='rejected'){
     // The reconciliation adapter only rejects a matching provider-declined or
     // provider-expired approval with no contradictory order in a complete read.
     if(!row.approval_ref||!['approval_declined','approval_expired'].includes(result.code??''))throw Error('Insufficient rejection evidence');
     await tx.query(`UPDATE order_intents SET status='rejected',updated_at=$2,error_code=$3,placement_result=$4 WHERE id=$1`,[id,at,result.code,JSON.stringify(result.evidence??null)]);
     await tx.query(`UPDATE order_cash_holds SET state='released',released_at=$2 WHERE intent_id=$1 AND state='held'`,[id,at]);
     await tx.query(`UPDATE order_unit_holds SET state='released',released_at=$2 WHERE intent_id=$1 AND state='held'`,[id,at]);
    }else{
     await tx.query(`UPDATE order_intents SET error_code=$2,updated_at=$3 WHERE id=$1`,[id,result.state==='unknown'?result.code:null,at]);
    }
    return read(tx,id);
   }));
  },
  unknown(id:string,code:string){return database.use(tx=>tx.query(`UPDATE order_intents SET status='placement_unknown',error_code=$2,updated_at=$3
   WHERE id=$1 AND asset_class='crypto' AND status='placing'`,[id,code,now()]));},
  /** Only during startup recovery, before enabling dispatch. Holds survive. */
  recoverInterrupted(){return database.use(tx=>tx.query(`UPDATE order_intents SET status='placement_unknown',error_code='interrupted',updated_at=$1
   WHERE asset_class='crypto' AND status='placing'`,[now()]));},
 };
}
