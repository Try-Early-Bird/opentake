import type {createDatabaseLifecycle} from '../database';
import {rekeyEquityClaims} from './rekey';
import type {createAllocationCore,FillContext} from './service';

// After each account sync, settle every new fill against the
// allocation ledger, oldest first, through the core's attribute(). Until the
// execution layer links fills to strategy order intents, no fill carries an
// instruction: history before any allocation completes as-is, the member's
// own buys stay personal, sells are reconciled against strategy claims, and
// an agentic fill with no local cause is deferred with an open case (it was
// placed by another app, e.g. hosted Earlybird). Dividend reinvestments are
// entitled as of the reinvestment order's creation, as hosted, with the last
// positions observation at or before it as evidence.
// Deferred fills are left to reconciliation; they are not retried here.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Core=Pick<ReturnType<typeof createAllocationCore>,'attribute'>;
export interface SweepResult {completed:number;deferred:number;failed:number}

export function createAttributionSweep(database:Database,core:Core,linkFor:(fill:{accountId:string;provider:string;executionRef:string;orderRef:string})=>Promise<Pick<FillContext,'instruction'|'memberDirected'>|undefined>=async()=>undefined){
 let running:Promise<SweepResult>|undefined;
 async function sweep(accountId:string):Promise<SweepResult>{
  // Claims recorded under an instrument id are re-keyed by ticker first, and a reinvestment
  // that credited nobody is retried (rekey.ts); a repaired ledger finds nothing to do.
  await rekeyEquityClaims(database).catch(()=>undefined);
  const pending=await database.use(async db=>(await db.query<{provider:string;providerRef:string;orderRef:string;origin:string;side:string|null;occurredAt:Date}>(
   `SELECT provider,provider_ref AS "providerRef",order_ref AS "orderRef",data->>'origin' AS origin,data->>'side' AS side,occurred_at AS "occurredAt"
    FROM account_executions e WHERE account_id=$1 AND (attribution_state='pending'
     -- A fill deferred before its order was known to be Opentake's (the member's own order) is retried.
     OR (attribution_state='deferred' AND EXISTS(SELECT 1 FROM order_intents i WHERE i.account_id=e.account_id AND i.provider_order_ref=e.order_ref)))
    ORDER BY occurred_at,provider_ref`,[accountId])).rows);
  const result:SweepResult={completed:0,deferred:0,failed:0};
  for(const fill of pending){
   const input={accountId,provider:fill.provider,executionRef:fill.providerRef};
   const context:FillContext={};
   const linked=await linkFor({...input,orderRef:fill.orderRef});
   if(linked?.instruction)context.instruction=linked.instruction;
   else if(linked?.memberDirected)context.memberDirected=true;
   else if(fill.origin==='drip'&&fill.side==='buy'){
    // Hosted's entitlement time: the night the dividend paid, when Robinhood created the
    // reinvestment order, not the fill (a weekend later for a Friday payer). Holdings then are
    // the last positions observation at or before it plus fills between (the core adds those).
    // Without a creation time strictly before the fill, the last observation before the fill stands in, as before.
    const created=await database.use(async db=>(await db.query<{at:string}>(`SELECT (data->>'sourceCreatedAt')::timestamptz::text AS at FROM account_orders
     WHERE account_id=$1 AND provider=$2 AND provider_ref=$3 AND (data->>'sourceCreatedAt')::timestamptz<$4`,[accountId,fill.provider,fill.orderRef,fill.occurredAt])).rows[0]?.at);
    const evidence=await database.use(async db=>(await db.query<{id:string;observedAt:string}>(`SELECT id,observed_at::text AS "observedAt" FROM account_observations
     WHERE account_id=$1 AND resource='equity_positions' AND observed_at<=$2 ORDER BY observed_at DESC,id LIMIT 1`,[accountId,created??fill.occurredAt])).rows[0]);
    if(evidence)context.entitlement={at:new Date(created??evidence.observedAt).toISOString(),observationId:evidence.id};
   }
   try{
    const state=await core.attribute(input,context);
    if(state==='completed')result.completed++;else result.deferred++;
   }catch{
    // Claims are applied in time order: a fill that cannot be settled stops
    // the sweep so later fills are not attributed against the wrong balance.
    result.failed++;break;
   }
  }
  return result;
 }
 return {
  /** Settles pending fills for the account; concurrent calls share one run. */
  run(accountId:string):Promise<SweepResult>{
   if(!running)running=sweep(accountId).finally(()=>{running=undefined;});
   return running;
  },
 };
}
