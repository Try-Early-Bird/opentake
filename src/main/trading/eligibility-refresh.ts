import {createReadCoalescer} from '../venue-queue';

/** Scope is host-owned metadata, never credentials or renderer authority. */
export interface EligibilityScope {
 venue:'robinhood'|'coinbase'; environment:string; accountId:string; authority:string;
}
export interface EligibilityEvidence<T> {value:T;observedAt:number}

/** Share pending reads only. Completed evidence is deliberately not cached:
 * execution callers still get fresh provider facts on every subsequent call.
 * Eligibility evaluation, consent and atomic reservations remain separate. */
export function createEligibilityRefresh(clock=()=>Date.now()){
 const reads=createReadCoalescer();let revision=0;
 return {
  async refresh<T>(scope:EligibilityScope,resource:string,load:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<EligibilityEvidence<T>>{
   if(!scope.environment||!scope.accountId||!scope.authority||!resource)throw Error('Eligibility scope incomplete');
   const generation=revision;
   const key=JSON.stringify([generation,scope.venue,scope.environment,scope.accountId,scope.authority,resource]);
   const evidence=await reads.run(key,async sharedSignal=>{
    sharedSignal.throwIfAborted();
    const value=await load(sharedSignal);
    sharedSignal.throwIfAborted();
    if(generation!==revision)throw Error('Eligibility evidence invalidated');
    return {value,observedAt:clock()};
   },signal);
   signal?.throwIfAborted();
   if(generation!==revision)throw Error('Eligibility evidence invalidated');
   // A consumer must never mutate another consumer's evidence.
   return structuredClone(evidence);
  },
  invalidate(){revision++;reads.clear();},
 };
}
export type EligibilityRefresh=ReturnType<typeof createEligibilityRefresh>;
