import {mixedLegFinished} from '../../shared/mixed-execution';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {MixedPreview, MixedVenue} from '../../shared/mixed-execution';

import type {MixedLegState,MixedExecutionLeg,MixedExecution} from '../../shared/mixed-execution';
export type {MixedLegState,MixedExecutionLeg,MixedExecution} from '../../shared/mixed-execution';
export interface MixedExecutionStore {
 find(id:string):Promise<MixedExecution|null>;
 /** Must lock the preview/Take, recheck both accounts and atomically reserve both
  * ledgers plus this journal. A failure rolls back ALL local funding. No network
  * calls belong in this transaction. Child operation IDs are allocated first. */
 fund(id:string,preview:MixedPreview,legs:{venue:MixedVenue;accountId:string;operationId:string}[]):Promise<MixedExecution>;
 claimDispatch(id:string,leg:MixedExecutionLeg):Promise<boolean>;
 saveLeg(id:string,leg:MixedExecutionLeg):Promise<MixedExecution>;
}
export interface MixedExecutionAdapter {
 /** Only called for a never-dispatched child. Use the persisted operation ID. */
 dispatch(leg:MixedExecutionLeg):Promise<Pick<MixedExecutionLeg,'state'|'message'>>;
 /** Reconcile using the durable child reference; MUST NOT duplicate an attempted order.
  * A venue may resume a provably unsent durable instruction through its existing
  * dispatcher (including a waiting-market child); never create a replacement. */
 reconcile(leg:MixedExecutionLeg):Promise<Pick<MixedExecutionLeg,'state'|'message'>>;
}
const request=z.object({operationId:z.uuid(),previewId:z.uuid()}).strict();
/** One coordinator for member investing, regardless of the participating venues.
 * Funding is an atomic local ownership change. External orders are independent;
 * a provider failure never undoes a fill or silently repeats a dispatch. */
export function createMixedExecution(deps:{
 preview(id:string):Promise<MixedPreview>;
 validate(preview:MixedPreview):Promise<void>;
 store:MixedExecutionStore;
 adapters:Record<MixedVenue,MixedExecutionAdapter>;
 clock?:()=>number;
}) {
 const clock=deps.clock??Date.now;
 const active=new Map<string,{previewId:string;work:Promise<MixedExecution>}>();
 async function advance(initial:MixedExecution):Promise<MixedExecution>{
  let run=initial;
  for(const original of initial.legs){
   if(mixedLegFinished(original.state))continue;
   let leg=original;
   try{
    if(leg.state==='reserved'){
     // Persist before the external side effect. A crash from this point onward
     // uses reconcile, even if it happened before the provider received a call.
     if(!await deps.store.claimDispatch(run.id,leg)) {
      run=(await deps.store.find(run.id))!;
      continue;
     }
     leg={...leg,state:'dispatching',message:null};
     const result=await deps.adapters[leg.venue].dispatch(leg);
     if(result.state==='reserved'||result.state==='dispatching')throw Error('Venue returned an unresolved dispatch state.');
     run=await deps.store.saveLeg(run.id,{...leg,...result});
    }else{
     const result=await deps.adapters[leg.venue].reconcile(leg);
     if(result.state==='reserved')throw Error('An attempted order cannot return to automatic dispatch.');
     run=await deps.store.saveLeg(run.id,{...leg,...result});
    }
   }catch{
    // Do not expose raw broker exceptions. The durable child is the authority
    // for detailed status, including unknown outcomes and remaining cash.
    run=await deps.store.saveLeg(run.id,{...leg,state:'attention',message:'Checking this account’s order outcome. Funds remain assigned to this Take.'});
   }
  }
  return run;
 }
 function start(raw:unknown):Promise<MixedExecution>{
  const input=request.parse(raw);
  const running=active.get(input.operationId);
  if(running){if(running.previewId!==input.previewId)return Promise.reject(Error('Investment request changed.'));return running.work;}
  const work=(async()=>{
   const saved=await deps.store.find(input.operationId);
   if(saved){if(saved.previewId!==input.previewId)throw Error('Investment request changed.');return advance(saved);}
   const preview=await deps.preview(input.previewId);
   if(!preview.executionEnabled)throw Error('Mixed execution adapters are not enabled.');
   if(preview.id!==input.previewId||preview.state==='blocked'||!Number.isFinite(Date.parse(preview.expiresAt))||Date.parse(preview.expiresAt)<=clock())throw Error('Review expired or is blocked. Preview again.');
   if(preview.legs.length<2||new Set(preview.legs.map(l=>l.venue)).size!==preview.legs.length||new Set(preview.legs.map(l=>l.accountId)).size!==preview.legs.length||preview.legs.some(l=>!Object.hasOwn(deps.adapters,l.venue)||l.state==='blocked'))throw Error('Choose an eligible account on each platform.');
   await deps.validate(preview);
   // Validation can involve provider reads; expiry is checked again afterwards.
   if(Date.parse(preview.expiresAt)<=clock())throw Error('Review expired. Preview again.');
   return advance(await deps.store.fund(input.operationId,preview,preview.legs.map(l=>({venue:l.venue,accountId:l.accountId,operationId:randomUUID()}))));
  })();
  active.set(input.operationId,{previewId:input.previewId,work});
  void work.finally(()=>{if(active.get(input.operationId)?.work===work)active.delete(input.operationId);}).catch(()=>{});
  return work;
 }
 return {start,busy:()=>active.size>0,async close(){await Promise.allSettled([...active.values()].map(a=>a.work));}};
}
