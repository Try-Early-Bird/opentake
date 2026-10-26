export interface PendingSubmission<E=unknown>{state:'approval_pending';approvalRef:string;evidence?:E}
/** Adapters classify provider evidence; this lifecycle owns the no-resend boundary. */
export type SubmissionResult<E=unknown,Approval extends PendingSubmission<E>=never>=
 |{state:'accepted';providerRef:string;evidence?:E}
 |{state:'rejected';code?:string;evidence?:E}
 |{state:'unknown';code:string;evidence?:E}
 |Approval;
export interface SubmissionAdapter<E=unknown,Approval extends PendingSubmission<E>=never>{
 /** Invoke beforeSend exactly once, after provider checks and before the write. No transport retries. */
 send(beforeSend:()=>Promise<void>):Promise<SubmissionResult<E,Approval>>;
}
export interface DispatchJournal<E=unknown,Approval extends PendingSubmission<E>=never>{
 /** Atomically revalidate eligibility and claim the persisted order. Must reject an existing attempt. */
 claim():Promise<void>;
 /** Persist evidence without overwriting a concurrently reconciled terminal outcome. */
 record(result:SubmissionResult<E,Approval>):Promise<void>;
 unknown(code:string):Promise<void>;
}
/** A claim failure never sends. Any uncertainty after a committed claim retains the hold.
 * Recovery is a read/reconcile operation: this function never retries a transport. */
export async function dispatchOrder<E,Approval extends PendingSubmission<E>=never>(adapter:SubmissionAdapter<E,Approval>,journal:DispatchJournal<E,Approval>):Promise<SubmissionResult<E,Approval>>{
 let claimed=false,claimInvoked=false,result:SubmissionResult<E,Approval>;
 try{
  result=await adapter.send(async()=>{
   if(claimInvoked)throw new Error('Dispatch claim may only run once');
   claimInvoked=true;await journal.claim();claimed=true;
  });
 }catch(error){
  if(!claimed)throw error;
  await journal.unknown('transport_error');return {state:'unknown',code:'transport_error'};
 }
 if(!claimed)throw new Error('Adapter returned without a durable dispatch claim');
 try{await journal.record(result);}catch{
  await journal.unknown('persistence_error');return {state:'unknown',code:'persistence_error'};
 }
 return result;
}
