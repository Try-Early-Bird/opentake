import type {CryptoSellAvailability} from './unit-holds';
import type {Transaction} from '@electric-sql/pglite';
import {dispatchOrder} from '../trading/dispatch';
import {amount,fingerprint} from '../allocations/ledger';
import {classifyRobinhoodCryptoSubmission,type CryptoPendingApproval,type CryptoSubmissionScope} from './robinhood-crypto-adapter';
import type {PlacementResponse} from './contract';
import type {createCryptoOrderJournal,CryptoIntentRow} from './crypto-journal';

type Journal=ReturnType<typeof createCryptoOrderJournal>;
export interface PreparedCryptoSubmission {
 /** Fresh account binding and exact pair resolution for the persisted review. */
 scope:CryptoSubmissionScope;
 /** Verified worst-case debit including fees, never just an estimated total. */
 maximumDebit:string;
 sellAvailability?:CryptoSellAvailability;
 /** Exactly one transport attempt, bound to scope and its original clientRef.
  * Must have no retries, hidden parameter changes, or fresh idempotency keys. */
 send():Promise<PlacementResponse>;
}
/** Shared dispatch orchestration for the Take asset adapter. Capability,
 * account eligibility and the original instruction are checked before claim. */
export function createCryptoOrderExecution(journal:Journal,deps:{
 enabled():boolean;
 /** Refresh provider eligibility and validate reviewed terms before claiming. */
 prepare(review:CryptoIntentRow):Promise<PreparedCryptoSubmission>;
 /** Recheck local trading policy/consent in the same transaction as the cash hold. */
 authorize(tx:Transaction,review:CryptoIntentRow):Promise<void>;
}){
 return {async confirm(id:string){
  if(!deps.enabled())throw Error('Crypto trading is not enabled');
  const review=await journal.get(id);
  if(review.status==='placed'||review.status==='approval_pending')return review;
  if(review.status!=='reviewed')throw Error('Order already attempted; reconcile it instead of submitting again');
  const prepared=await deps.prepare(structuredClone(review));
  if(prepared.scope.accountId!==review.account_id||prepared.scope.clientRef!==review.ref_id
   ||fingerprint(prepared.scope.order)!==fingerprint(review.order_request))throw Error('Prepared order differs from the saved review');
  if((review.order_request.side==='buy'?amount(prepared.maximumDebit)<=0n:amount(prepared.maximumDebit)!==0n)||amount(prepared.maximumDebit)>amount(review.maximum_debit))throw Error('Maximum debit changed; review the order again');
  await dispatchOrder<unknown,CryptoPendingApproval>({send:async beforeSend=>{
   await beforeSend();
   return classifyRobinhoodCryptoSubmission(await prepared.send(),prepared.scope);
  }},{claim:async()=>{
   await journal.claim(id,async(tx,current)=>{
    if(current.account_id!==review.account_id||current.ref_id!==review.ref_id||fingerprint(current.order_request)!==fingerprint(review.order_request)
     ||amount(current.maximum_debit)!==amount(review.maximum_debit))throw Error('Saved review changed during preparation');
    if(!deps.enabled())throw Error('Crypto trading was disabled before submission');
    await deps.authorize(tx,current);
    if(!deps.enabled())throw Error('Crypto trading was disabled during authorization');
   },prepared.sellAvailability);
  },record:result=>journal.record(id,result),unknown:code=>journal.unknown(id,code).then(()=>{})});
  return journal.get(id);
 }};
}
