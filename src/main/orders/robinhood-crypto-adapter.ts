import {cryptoRejectionCode,cryptoRejectionDiagnostic} from './crypto-rejection';
import {z} from 'zod';
import {cryptoDecimal, cryptoPreviewInput} from './crypto-preview-contract';
import type {PlacementResponse} from './contract';
import type {SubmissionResult,PendingSubmission} from '../trading/dispatch';
import {recoverOrder} from '../trading/recovery';
import {decimalToScaledInteger as units} from '../allocations/decimal';

const id=z.string().min(1).max(256);
const object=z.record(z.string(),z.unknown());
const orderSchema=z.object({id,ref_id:id,currency_pair_id:id,side:z.enum(['buy','sell']),
 type:z.enum(['market','limit']),time_in_force:z.literal('gtc'),quantity:cryptoDecimal,
 cumulative_quantity:cryptoDecimal,state:z.string().min(1).max(100),speculative:z.boolean().optional(),
 limit_price:cryptoDecimal.nullish()});
const proposalSchema=z.object({asset_class:z.literal('ASSET_CLASS_CRYPTO'),symbol:z.string(),
 side:z.enum(['buy','sell']),order_type:z.enum(['market','limit']),time_in_force:z.literal('gtc'),
 quantity:cryptoDecimal.optional(),dollar_amount:z.object({amount:cryptoDecimal,currency_code:z.literal('USD')}).nullish(),
 limit_price:z.object({amount:cryptoDecimal,currency_code:z.literal('USD')}).nullish()});
const approvalSchema=z.object({approval_id:id,account_number:id,asset_class:z.literal('ASSET_CLASS_CRYPTO'),
 state:z.string(),is_edited:z.boolean(),proposed_order:proposalSchema});
export type CryptoPendingApproval=PendingSubmission;
export type CryptoSubmissionResult=SubmissionResult<unknown,CryptoPendingApproval>&{approvalRef?:string};
export interface CryptoSubmissionScope {
 accountId:string;accountNumber:string;cryptoAccountNumber:string;clientRef:string;symbol:string;
 order:z.infer<typeof cryptoPreviewInput>;
}
const unknown=(code:string):CryptoSubmissionResult=>({state:'unknown',code});
function sameAmount(a:string|undefined|null,b:string|undefined|null){
 return a==null||b==null?a==null&&b==null:units(a)===units(b);
}
function matchesProposal(proposal:z.infer<typeof proposalSchema>,scope:CryptoSubmissionScope){
 const order=scope.order;
 return proposal.symbol===scope.symbol&&proposal.side===order.side&&proposal.order_type===order.type
  &&sameAmount(proposal.quantity,order.quantity)&&sameAmount(proposal.dollar_amount?.amount,order.dollar_amount)
  &&sameAmount(proposal.limit_price?.amount,order.limit_price);
}
function matchesOrder(order:z.infer<typeof orderSchema>,scope:CryptoSubmissionScope){
 return order.currency_pair_id===scope.order.currency_pair_id&&order.side===scope.order.side&&order.type===scope.order.type
  &&order.speculative!==true&&(!scope.order.quantity||sameAmount(order.quantity,scope.order.quantity))
  &&sameAmount(order.limit_price,scope.order.limit_price)&&units(order.quantity)>0n
  &&units(order.cumulative_quantity)<=units(order.quantity);
}
/** Parse only the verified crypto envelope. Approval IDs must never masquerade as order IDs.
 * Malformed or mismatched evidence retains uncertainty; a tool guide cannot authorize a retry. */
export function classifyRobinhoodCryptoSubmission(response:PlacementResponse,scope:CryptoSubmissionScope):CryptoSubmissionResult{
 const parsed=z.object({data:object}).safeParse(response.data);
 if(response.isError){
  if(parsed.success&&(parsed.data.data.order!=null||parsed.data.data.approval!=null))return unknown('contradictory_error_evidence');
  if(response.errorCategory!=='invalid_request')return unknown('tool_error');
  const details=response.errorDetails??response.data;
  const diagnostic=cryptoRejectionDiagnostic(details);
  return {state:'rejected',code:cryptoRejectionCode(details),...(diagnostic?{evidence:{rejectionDiagnostic:diagnostic}}:{})};
 }
 if(!parsed.success)return unknown('invalid_crypto_response');
 const data=parsed.data.data;
 const hasOrder=data.order!=null,hasApproval=data.approval!=null;
 if(hasOrder===hasApproval)return unknown('ambiguous_crypto_response');
 if(hasOrder){
  const order=orderSchema.safeParse(data.order);
  if(!order.success||data.crypto_account_number!==scope.cryptoAccountNumber
   ||order.data.ref_id!==scope.clientRef||!matchesOrder(order.data,scope))return unknown('crypto_order_identity_mismatch');
  return {state:'accepted',providerRef:order.data.id,evidence:order.data};
 }
 const approval=approvalSchema.safeParse(data.approval);
 if(!approval.success||approval.data.account_number!==scope.accountNumber||!matchesProposal(approval.data.proposed_order,scope))return unknown('crypto_approval_identity_mismatch');
 const {approval_id:approvalRef,state,is_edited:isEdited}=approval.data;
 const evidence={approvalRef,state,isEdited};
 if(state==='APPROVAL_STATE_PENDING'&&!isEdited)return {state:'approval_pending',approvalRef,evidence};
 if(['APPROVAL_STATE_DECLINED','APPROVAL_STATE_EXPIRED'].includes(state))return {state:'rejected',code:state==='APPROVAL_STATE_DECLINED'?'approval_declined':'approval_expired',approvalRef,evidence};
 // Approved is not filled, nor proof of absence: fetch the order by approval ID.
 return {state:'unknown',code:'approval_requires_reconciliation',approvalRef,evidence};
}

/** Reconcile fetched rows within the selected account. Approval-created orders use the
 * approval ID as ref_id, so match both durable references. Never guess by ticker/amount. */
export function recoverRobinhoodCryptoOrder(scope:CryptoSubmissionScope,batch:{accountId:string;orders:readonly unknown[]},approvalEvidence?:{approvalRef:string;approval:unknown}){
 let approvalRef:string|undefined;
 if(approvalEvidence){
  const parsed=approvalSchema.parse(approvalEvidence.approval);
  if(parsed.approval_id!==approvalEvidence.approvalRef||parsed.account_number!==scope.accountNumber||!matchesProposal(parsed.proposed_order,scope))throw Error('Crypto approval identity mismatch');
  if(parsed.is_edited||!['APPROVAL_STATE_APPROVED','APPROVAL_STATE_AUTO_APPROVED'].includes(parsed.state))throw Error('Crypto approval requires reconciliation before binding an order');
  approvalRef=parsed.approval_id;
 }
 if(batch.accountId!==scope.accountId)throw Error('Crypto reconciliation account mismatch');
 const references=new Set([scope.clientRef,...(approvalRef?[approvalRef]:[])]);
 const candidates=batch.orders.filter(row=>{
  const parsed=object.safeParse(row);
  return parsed.success&&typeof parsed.data.ref_id==='string'&&references.has(parsed.data.ref_id);
 });
 if(candidates.length===0)return null;
 // A contradictory row cannot be silently skipped in favor of another plausible one.
 const evidence=candidates.map(row=>{
  const order=orderSchema.parse(row);
  if(!matchesOrder(order,scope))throw Error('Crypto order requires reconciliation against reviewed terms');
  return {venue:'robinhood' as const,accountId:scope.accountId,clientRef:scope.clientRef,providerRef:order.id,order};
 });
 return recoverOrder({venue:'robinhood',accountId:scope.accountId,clientRef:scope.clientRef},evidence);
}

/** Cancellation acknowledgment never proves a terminal order state or releases funds. */
export function classifyRobinhoodCryptoCancellation(response:PlacementResponse):'requested'|'rejected'|'unknown'{
 if(response.isError)return response.errorCategory==='invalid_request'?'rejected':'unknown';
 const result=z.object({data:z.object({accepted:z.boolean()})}).safeParse(response.data);
 return result.success?(result.data.data.accepted?'requested':'rejected'):'unknown';
}


export interface CryptoReconciliationRead {
 accountId:string;complete:boolean;orders:readonly unknown[];approvals:readonly unknown[];
}
/** Only complete, account-scoped reads may resolve a pending submission. Absence
 * never proves that an order failed. Approval expiry must come from the provider,
 * not from a local timer or a missing row in a pending-only listing. */
export function reconcileRobinhoodCryptoEvidence(scope:CryptoSubmissionScope,read:CryptoReconciliationRead,approvalRef:string|null):CryptoSubmissionResult{
 if(read.accountId!==scope.accountId||!read.complete)return unknown('incomplete_reconciliation');
 if(read.orders.length>14000||read.approvals.length>100)return unknown('invalid_reconciliation');
 try{
  let approval:ReturnType<typeof approvalSchema.parse>|undefined;
  if(approvalRef){
   const matches=read.approvals.filter(row=>object.safeParse(row).data?.approval_id===approvalRef);
   if(matches.length!==1)return unknown('approval_evidence_missing_or_ambiguous');
   approval=approvalSchema.parse(matches[0]);
   if(approval.account_number!==scope.accountNumber||!matchesProposal(approval.proposed_order,scope))return unknown('crypto_approval_identity_mismatch');
   if(approval.is_edited)return unknown('edited_approval_requires_reconciliation');
   const linkedOrders=read.orders.filter(row=>{
    const ref=object.safeParse(row).data?.ref_id;return ref===scope.clientRef||ref===approvalRef;
   });
   if(!['APPROVAL_STATE_APPROVED','APPROVAL_STATE_AUTO_APPROVED'].includes(approval.state)){
    if(linkedOrders.length)return unknown('contradictory_approval_order_evidence');
    return classifyRobinhoodCryptoSubmission({isError:false,errorCategory:null,data:{data:{approval}}},scope);
   }
  }
  const match=recoverRobinhoodCryptoOrder(scope,read,approval&&approvalRef?{approvalRef,approval}:undefined);
  return match?{state:'accepted',providerRef:match.providerRef,...(approvalRef?{approvalRef}:{}),evidence:match.order}:unknown('order_not_observed');
 }catch{return unknown('invalid_reconciliation');}
}
