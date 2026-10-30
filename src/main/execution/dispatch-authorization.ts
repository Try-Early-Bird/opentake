import {decimalToScaledInteger} from '../allocations/decimal';
import {riskEligibility,type RiskInput} from '../trading/risk';
import type {ActionJob} from '../venues/types';
import type {AdmissionCheck,AdmissionRefusal} from './admission';

// The last check before an order leaves, the same on every venue: run inside the
// venue's `dispatchOrder` claim, against the final orders (after any re-pricing or
// re-sizing), reading the grant from the database and never from a saved result.
// The core supplies the policy; the venue supplies the evidence it already holds.
// A refusal throws, so the claim fails and nothing is sent.

/** One order as it is about to be sent, in the shape the approval card shows. */
export interface DispatchOrderIntent{symbol:string;side:'buy'|'sell';amountUsd:string|null}
export interface DispatchIntent{
 job:ActionJob;
 orders:DispatchOrderIntent[];
 /** What the member approved, when the trade needed approval; the final orders must stay within it. */
 approved?:DispatchOrderIntent[];
 /** Limit evidence in one currency, when the venue has limits. */
 risk?:RiskInput;
}
export type DispatchRefusal=AdmissionRefusal|'approval_exceeded'|'daily_notional_limit'|'loss_limit_reached';
export class DispatchRefused extends Error{
 constructor(readonly reason:DispatchRefusal){super(`Dispatch refused: ${reason}`);this.name='DispatchRefused';}
}

/** A fresh plan may differ from the approved one by this much per order before the member is asked again. */
export const APPROVAL_DRIFT_BPS=1_000n,APPROVAL_DRIFT_FLOOR=decimalToScaledInteger('1');
/** The fresh orders stay within what the member approved: no new symbol or side, no order much larger. */
export function withinApproved(fresh:DispatchOrderIntent[],approved:DispatchOrderIntent[]):boolean{
 return fresh.every(o=>{
  const was=approved.find(a=>a.symbol===o.symbol&&a.side===o.side);
  if(!was||was.amountUsd===null||o.amountUsd===null)return false;
  const before=decimalToScaledInteger(was.amountUsd),slack=before*APPROVAL_DRIFT_BPS/10_000n;
  return decimalToScaledInteger(o.amountUsd)<=before+(slack>APPROVAL_DRIFT_FLOOR?slack:APPROVAL_DRIFT_FLOOR);
 });
}

export type DispatchAuthorization=(intent:DispatchIntent)=>Promise<void>;
export function dispatchAuthorization(admit:AdmissionCheck):DispatchAuthorization{
 return async intent=>{
  // The job has run by now, so an expired request alone no longer refuses.
  const admission=await admit(intent.job,true);
  if(!admission.admitted)throw new DispatchRefused(admission.reason);
  if(intent.approved&&!withinApproved(intent.orders,intent.approved))throw new DispatchRefused('approval_exceeded');
  if(intent.risk){
   const result=riskEligibility(intent.risk);
   const reason=result.reasons[0]?.code;
   if(reason==='daily_notional_limit'||reason==='loss_limit_reached')throw new DispatchRefused(reason);
   if(!result.ok)throw new DispatchRefused('daily_notional_limit');
  }
 };
}
