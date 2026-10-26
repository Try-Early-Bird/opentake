import { lotLosses, lotsSettleIt } from './external-sale';
import { multiplyDecimals } from './decimal';
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import { allocation, amount, append, format, instruction, unreleased } from './ledger';
import { claimed, measuredCash, measuredShares, proportion } from './evidence';

export interface ReconciliationCase {
 id:string;account_id:string;scope:string;cause:string;instrument_ref:string|null;
 observed:string|null;claimed:string|null;difference:string|null;
 impacts:{allocationId:string;quantity:string}[];evidence:Record<string,unknown>;resolved_at:string|null;
}
export async function refreshStatuses(tx:Transaction,accountId:string,now:string) {
 await tx.query(`UPDATE strategy_allocations a SET status=CASE WHEN restore_required THEN 'paused' ELSE coalesce(resume_status,'paused') END,
 resume_status=NULL,updated_at=$2 WHERE account_id=$1 AND status='diverged'
 AND NOT EXISTS(SELECT 1 FROM strategy_reconciliation_cases c WHERE c.account_id=a.account_id AND c.resolved_at IS NULL
 AND c.impacts @> jsonb_build_array(jsonb_build_object('allocationId',a.id::text)))`,[accountId,now]);
}
export async function closeCase(tx:Transaction,accountId:string,scope:string,now:string,resolution='evidence_restored') {
 await tx.query(`UPDATE strategy_reconciliation_cases SET resolved_at=$3,updated_at=$3,resolution=$4
 WHERE account_id=$1 AND scope=$2 AND resolved_at IS NULL`,[accountId,scope,now,resolution]);
 await refreshStatuses(tx,accountId,now);
}
export async function openCase(tx:Transaction,input:{accountId:string;scope:string;cause:string;instrumentRef?:string;
 observed?:string;claimed?:string;difference?:string;impacts:{allocationId:string;quantity:string}[];evidence:Record<string,unknown>},now:string) {
 for(const impact of input.impacts){
  const a=await allocation(tx,impact.allocationId);
  if(a.account_id!==input.accountId)throw new Error('Case crosses accounts');
 }
 const row=(await tx.query<{id:string}>(`INSERT INTO strategy_reconciliation_cases(id,account_id,scope,cause,instrument_ref,observed,claimed,difference,impacts,evidence,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
 ON CONFLICT(account_id,scope) WHERE resolved_at IS NULL DO UPDATE SET observed=excluded.observed,claimed=excluded.claimed,
 difference=excluded.difference,impacts=excluded.impacts,evidence=excluded.evidence,updated_at=excluded.updated_at RETURNING id`,
 [randomUUID(),input.accountId,input.scope,input.cause,input.instrumentRef??null,input.observed??null,input.claimed??null,input.difference??null,JSON.stringify(input.impacts),JSON.stringify(input.evidence),now])).rows[0];
 for(const impact of input.impacts)await tx.query(`UPDATE strategy_allocations SET resume_status=CASE WHEN status IN ('active','paused') THEN status ELSE resume_status END,
 status='diverged',updated_at=$2 WHERE id=$1 AND status IN ${unreleased}`,[impact.allocationId,now]);
 await refreshStatuses(tx,input.accountId,now);return row.id;
}
export interface LotObservation {accountId:string;instrumentRef:string;provider:string;observedAt:string;complete:true;lots:{openLotId:string;quantity:string}[]}
export async function reconcile(tx:Transaction,accountId:string,instrumentRef:string|null,now:string,lots?:LotObservation):Promise<ReconciliationCase|null> {
 const claims=(await claimed(tx,accountId,instrumentRef)).filter(c=>amount(c.quantity)>0n);
 const total=claims.reduce((sum,c)=>sum+amount(c.quantity),0n);
 const scope=instrumentRef===null?'cash':`position:${instrumentRef}`;
 if(total===0n){await closeCase(tx,accountId,scope,now);return null;}
 let observed:bigint|undefined,observationId:string|undefined,mark:string|undefined;
 try{
  if(instrumentRef===null){const m=await measuredCash(tx,accountId,now);observed=m.cash;observationId=m.observationId;}
  else{const m=await measuredShares(tx,accountId,instrumentRef,now);observed=m.quantity;observationId=m.observationId;mark=m.positions.length===1&&m.positions[0].currency==='USD'?m.positions[0].markPrice??undefined:undefined;}
 }catch{/* Missing evidence opens a retryable case; it never guesses a balance. */}
 if(observed!==undefined&&observed>=total){await closeCase(tx,accountId,scope,now);return null;}
 const gap=observed===undefined?undefined:total-(observed<0n?0n:observed);
 let impacts=gap===undefined?claims:proportion(gap,claims);
 let assignment='proportional_proposal';
 if(lots&&gap!==undefined){
  if(lots.accountId!==accountId||lots.instrumentRef!==instrumentRef||!lots.complete||!Number.isFinite(Date.parse(lots.observedAt))||Date.parse(lots.observedAt)>Date.parse(now)||Date.parse(now)-Date.parse(lots.observedAt)>60000)throw new Error('Fresh complete lot evidence required for this account and instrument');
  const bindings=(await tx.query<{allocation_id:string;open_lot_id:string|null}>(`SELECT e.allocation_id,b.open_lot_id FROM strategy_attribution_entries e
   LEFT JOIN strategy_lot_bindings b ON b.entry_id=e.id AND b.provider=$3
   WHERE e.account_id=$1 AND e.instrument_ref=$2 AND e.entry_type IN ('fill','reinvestment') AND e.quantity_delta>0`,[accountId,instrumentRef,lots.provider])).rows;
  const live=new Map<string,string>();for(const lot of lots.lots){if(amount(lot.quantity)<0n||live.has(lot.openLotId))throw new Error('Invalid open lots');live.set(lot.openLotId,lot.quantity);}
  const losses=lotsSettleIt(lotLosses(claims.map(c=>{
   const matches=bindings.filter(b=>b.allocation_id===c.allocationId);
   return {allocationId:c.allocationId,claimed:c.quantity,lotIds:matches.flatMap(b=>b.open_lot_id?[b.open_lot_id]:[]),unmatchedBuys:matches.some(b=>!b.open_lot_id)};
  }),live));
  if(losses&&Object.values(losses).reduce((sum,v)=>sum+amount(v),0n)===gap){impacts=claims.map(c=>({allocationId:c.allocationId,quantity:losses[c.allocationId]??'0'}));assignment='observed_lot_loss';}
 }
 impacts=impacts.filter(p=>amount(p.quantity)>0n);
 const id=await openCase(tx,{accountId,scope,cause:instrumentRef===null?'cash_shortfall':'position_shortfall',instrumentRef:instrumentRef??undefined,
 observed:observed===undefined?undefined:format(observed),claimed:format(total),difference:observed===undefined?undefined:format(observed-total),
 impacts,evidence:{observationId:observationId??null,assignment,...(assignment==='observed_lot_loss'?{lotObservation:lots}:{})}},now);
 const result=(await tx.query<ReconciliationCase>('SELECT * FROM strategy_reconciliation_cases WHERE id=$1',[id])).rows[0];
 if(instrumentRef!==null&&gap!==undefined&&mark!==undefined&&amount(mark)>0n&&amount(multiplyDecimals(format(gap),mark))<10n**18n){
  await reduceClaims(tx,result,now,'automatic_small_gap');return null;
 }
 return result;
}
// The member accepts a proposed proportional reduction. Remeasure inside the same
// transaction: another detach, fill or restored cash may already have covered it.
export async function keepReduced(tx:Transaction,caseId:string,now:string,lots?:LotObservation) {
 const previous=(await tx.query<ReconciliationCase>('SELECT * FROM strategy_reconciliation_cases WHERE id=$1',[caseId])).rows[0];
 if(!previous)throw new Error('Case not found');if(previous.resolved_at)return;
 if(!['cash_shortfall','position_shortfall'].includes(previous.cause))throw new Error('Case requires missing evidence');
 const current=await reconcile(tx,previous.account_id,previous.instrument_ref,now,lots);if(!current)return;
 if(current.observed===null||current.difference===null)throw new Error('Cannot resolve without fresh evidence');
 await reduceClaims(tx,current,now,'keep_reduced');
}
async function reduceClaims(tx:Transaction,current:ReconciliationCase,now:string,resolution:string){
 for(const impact of current.impacts){
  if(amount(impact.quantity)===0n)continue;
  const transactionId=await instruction(tx,{allocationId:impact.allocationId,kind:'reconciliation',cause:`case:${current.id}`},now);
  await append(tx,{allocationId:impact.allocationId,transactionId,
   entryType:current.instrument_ref===null?'capital_released':'external_adjustment',
   cause:`case:${current.id}`,sourceKind:'reconciliation',sourceRef:current.id,occurredAt:now,
   ...(current.instrument_ref===null?{cashDelta:format(-amount(impact.quantity))}:{instrumentRef:current.instrument_ref,quantityDelta:format(-amount(impact.quantity))}),
   metadata:{assignment:current.evidence.assignment,resolution,observed:current.observed}},now);
 }
 await closeCase(tx,current.account_id,current.scope,now,resolution);
}
