import type {OrderIntentView} from '../../shared/orders';
import {recoverOrder} from '../trading/recovery';
import {reviewEligibility} from '../trading/eligibility';
import {dispatchOrder} from '../trading/dispatch';
import {classifyRobinhoodSubmission} from './robinhood-adapter';
import {observedOrderState,type OrderStatus} from '../../shared/trading';
export {placedOrderRef} from './robinhood-adapter';
import {randomUUID} from 'node:crypto';
import type {createDatabaseLifecycle} from '../database';
import type {FillContext} from '../allocations/service';
import {equityOrderSchema,type EquityOrder,type PlacementResponse} from './contract';

// The single order writer. A review is a fresh Robinhood review stored as an intent valid for two
// minutes; confirming claims it atomically and places it once with its
// ref_id (Robinhood deduplicates on it). Robinhood refusing the request is
// proof no order exists (rejected); any other failure may have placed one
// and is never resent: it stays placement_unknown until a synced order with
// the same ref_id resolves it. Trading is on unless switched off (OPENTAKE_TRADING=0).

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Orders={equityOrder(stage:'review'|'place',input:unknown,accountId:string,refId?:string):Promise<unknown>};
export class OrderConflictError extends Error {}
export class PlacementUnknownError extends Error {}
const REVIEW_MS=2*60_000;

export interface OrderIntent {
 execution:OrderStatus;
 id:string;accountId:string;allocationId:string|null;transactionId:string|null;status:OrderIntentView['status'];refId:string;
 orderRequest:EquityOrder;providerOrderRef:string|null;errorCode:string|null;reviewedAt:string;expiresAt:string;placedAt:string|null;
}
interface Row {filled_quantity?:string|null;provider_state?:string;id:string;account_id:string;allocation_id:string|null;transaction_id:string|null;status:OrderIntentView['status'];ref_id:string;order_request:EquityOrder;
 provider_order_ref:string|null;error_code:string|null;reviewed_at:Date;expires_at:Date;placed_at:Date|null}
const present=(r:Row):OrderIntent=>({execution:{state:observedOrderState(r.status==='placed'?(r.provider_state??r.status):r.status,r.filled_quantity),cancelState:'none'},id:r.id,accountId:r.account_id,allocationId:r.allocation_id,transactionId:r.transaction_id,status:r.status,refId:r.ref_id,
 orderRequest:r.order_request,providerOrderRef:r.provider_order_ref,errorCode:r.error_code,reviewedAt:new Date(r.reviewed_at).toISOString(),
 expiresAt:new Date(r.expires_at).toISOString(),placedAt:r.placed_at===null?null:new Date(r.placed_at).toISOString()});

export function createOrderWriter(database:Database,connections:Orders,options:{
 /** The off switch: nothing is reviewed or placed while this is false. */
 enabled:()=>boolean;
 /** Refuses a member's own order that would spend a strategy's cash or sell its shares; may name the member's own lots. */
 guardSelfDirected?:(input:{accountId:string;order:EquityOrder})=>Promise<EquityOrder|void>;
 /** A placement changed the account: sync it so the order and its fills arrive. */
 afterPlacement?:()=>void;
},clock=()=>Date.now()){
 const iso=()=>new Date(clock()).toISOString();
 const viewSql="SELECT i.*,o.state AS provider_state,o.data->>'cumulativeQuantity' AS filled_quantity FROM order_intents i LEFT JOIN account_orders o ON o.account_id=i.account_id AND o.provider='robinhood' AND o.provider_ref=i.provider_order_ref";
 const read=async(id:string)=>(await database.use(db=>db.query<Row>(viewSql+" WHERE i.asset_class='equity' AND i.id=$1",[id]))).rows[0];
 const set=(id:string,fields:Record<string,unknown>)=>database.use(async db=>{
  const keys=Object.keys(fields);
  const changed=await db.query(`UPDATE order_intents SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')},updated_at=$${keys.length+2} WHERE id=$1 AND status=ANY($${keys.length+3}::text[]) RETURNING id`,[id,...keys.map(k=>fields[k]),iso(),fields.status==='placed'?['placing','placement_unknown','abandoned']:['placing','placement_unknown']]);
  if(!changed.rows.length){
   const current=(await db.query<Row>('SELECT * FROM order_intents WHERE id=$1',[id])).rows[0];
   if(current?.status==='placed'&&fields.status==='placed'&&current.provider_order_ref===fields.provider_order_ref)return;
   throw new OrderConflictError('Submission evidence conflicts with the reconciled order');
  }
 });
 return {
  async get(id:string){const row=await read(id);if(!row)throw new Error('Order intent not found');return present(row);},
  async review(input:{accountId:string;order:unknown;allocationId?:string;transactionId?:string}):Promise<{intent:OrderIntent;review:unknown}>{
   if(!options.enabled())throw new Error('Trading is not enabled in this build');
   let order=equityOrderSchema.parse(input.order);
   if((input.allocationId===undefined)!==(input.transactionId===undefined))throw new Error('An allocation order names its instruction');
   if(input.allocationId!==undefined){
    const ok=(await database.use(db=>db.query(`SELECT 1 FROM strategy_allocations a JOIN strategy_allocation_transactions t ON t.allocation_id=a.id
     WHERE a.id=$1 AND t.id=$2 AND a.account_id=$3 AND a.status='active' AND NOT a.restore_required`,[input.allocationId,input.transactionId,input.accountId]))).rows.length;
    if(!ok)throw new Error('The allocation cannot trade: it must be active, reviewed and on this account');
   }else order=equityOrderSchema.parse((await options.guardSelfDirected?.({accountId:input.accountId,order}))??order);
   const review=await connections.equityOrder('review',order,input.accountId);
   const now=clock(),id=randomUUID();
   await database.use(db=>db.query(`INSERT INTO order_intents(id,account_id,allocation_id,transaction_id,asset_class,status,ref_id,order_request,review_result,reviewed_at,expires_at,updated_at)
    VALUES($1,$2,$3,$4,'equity','reviewed',$5,$6,$7,$8,$9,$8)`,[id,input.accountId,input.allocationId??null,input.transactionId??null,randomUUID(),JSON.stringify(order),JSON.stringify(review),new Date(now).toISOString(),new Date(now+REVIEW_MS).toISOString()]));
   return {intent:present((await read(id))!),review};
  },

  async confirm(intentId:string):Promise<OrderIntent>{
   if(!options.enabled())throw new Error('Trading is not enabled in this build');
   const existing=await read(intentId);
   if(!existing)throw new Error('Order intent not found');
   if(existing.status==='placed')return present(existing);
   // Once claimed, only reconciliation may resolve an intent; never resend.
   if(existing.status!=='reviewed')throw new OrderConflictError('This order cannot be placed; it is '+existing.status.replace('_',' '));
   const now=iso();
   if(!reviewEligibility(options.enabled(),new Date(existing.expires_at).getTime(),clock()).ok){
    await database.use(db=>db.query(`UPDATE order_intents SET status='expired',updated_at=$2 WHERE id=$1 AND status='reviewed'`,[intentId,now]));
    throw new OrderConflictError('The order review expired; review it again');
   }
   // Revalidate personal ownership immediately before claiming, without changing the reviewed order.
   if(existing.allocation_id===null){
    const guarded=await options.guardSelfDirected?.({accountId:existing.account_id,order:existing.order_request});
    if(guarded&&JSON.stringify(equityOrderSchema.parse(guarded))!==JSON.stringify(equityOrderSchema.parse(existing.order_request)))throw new OrderConflictError('Ownership changed; review this order again');
   }
   if(!options.enabled())throw new OrderConflictError('Trading was disabled before placement');
   let claimed:Row|undefined;
   const result=await dispatchOrder({send:async beforeSend=>{
    await beforeSend();
    return classifyRobinhoodSubmission(await connections.equityOrder('place',claimed!.order_request,claimed!.account_id,claimed!.ref_id) as PlacementResponse);
   }},{claim:async()=>{
     claimed=(await database.use(db=>db.query<Row>(`UPDATE order_intents SET status='placing',confirmed_at=$2,updated_at=$2,error_code=NULL
    WHERE id=$1 AND asset_class='equity' AND status='reviewed' AND expires_at>$2
     AND NOT EXISTS(SELECT 1 FROM order_cash_holds h JOIN order_intents held ON held.id=h.intent_id WHERE held.account_id=order_intents.account_id AND h.state='held')
     AND (allocation_id IS NULL OR EXISTS(SELECT 1 FROM strategy_allocations a JOIN strategy_allocation_transactions t ON t.allocation_id=a.id
      WHERE a.id=order_intents.allocation_id AND t.id=order_intents.transaction_id AND a.account_id=order_intents.account_id
       AND a.status='active' AND NOT a.restore_required AND t.outcome IS NULL))
     RETURNING *`,[intentId,iso()]))).rows[0];
     if(!claimed)throw new OrderConflictError('This order is already being placed or its investment is no longer eligible');
   },record:async result=>{
    const evidence=result.evidence===undefined?{}:{placement_result:JSON.stringify(result.evidence)};
    if(result.state==='accepted')await set(intentId,{status:'placed',provider_order_ref:result.providerRef,placed_at:iso(),...evidence});
    else await set(intentId,{status:result.state==='rejected'?'rejected':'placement_unknown',error_code:result.code??'provider_invalid_request',...evidence});
   },unknown:async code=>{await database.use(db=>db.query("UPDATE order_intents SET status='placement_unknown',error_code=$2,updated_at=$3 WHERE id=$1 AND status='placing'",[intentId,code,iso()]));}});
   if(result.state==='rejected')throw new Error('Robinhood refused the order; nothing was placed');
   if(result.state==='unknown')throw new PlacementUnknownError('The order may have reached Robinhood; it will be matched on the next sync and never sent again');
   options.afterPlacement?.();
   return present((await read(intentId))!);
  },

  /**
   * After a sync: an intent interrupted mid-placement becomes unknown, and an
   * unknown one whose ref_id now appears on a synced order is placed, as is
   * one the member abandoned after not finding it. Nothing is ever resent.
   */
  async reconcile(accountId:string,interruptedBefore=clock()):Promise<number>{
   return database.use(async db=>{
    await db.query(`UPDATE order_intents SET status='expired',error_code='review_expired',updated_at=$2
     WHERE asset_class='equity' AND account_id=$1 AND status='reviewed' AND expires_at<=$2`,[accountId,iso()]);
    await db.query(`UPDATE order_intents SET status='placement_unknown',error_code='interrupted',updated_at=$2 WHERE asset_class='equity' AND account_id=$1 AND status='placing' AND updated_at<$3`,
     [accountId,iso(),new Date(interruptedBefore).toISOString()]);
    const unresolved=(await db.query<Row>("SELECT * FROM order_intents WHERE asset_class='equity' AND account_id=$1 AND status IN ('placement_unknown','abandoned')",[accountId])).rows;
    let recovered=0;
    for(const intent of unresolved){
     const rows=(await db.query<{provider_ref:string;first_seen:Date;data:{clientRef?:string}}>("SELECT provider_ref,first_seen,data FROM account_orders WHERE account_id=$1 AND provider='robinhood' AND data->>'clientRef'=$2",[accountId,intent.ref_id])).rows;
     let matched:ReturnType<typeof recoverOrder<(typeof rows)[number]&{venue:'robinhood';accountId:string;clientRef:string;providerRef:string}>>;
     try{matched=recoverOrder({venue:'robinhood',accountId,clientRef:intent.ref_id},rows.map(r=>({...r,venue:'robinhood' as const,accountId,clientRef:r.data.clientRef??'',providerRef:r.provider_ref})));}
     catch{continue;} // Keep uncertainty; never choose arbitrarily between provider IDs.
     if(!matched)continue;
     const result=await db.query("UPDATE order_intents SET status='placed',provider_order_ref=$2,placed_at=coalesce(placed_at,$3),updated_at=$4 WHERE id=$1 AND status IN ('placement_unknown','abandoned')",[intent.id,matched.provider_ref,matched.first_seen,iso()]);
     recovered+=result.affectedRows??0;
    }
    return recovered;
   });
  },

  /**
   * The member checked Robinhood and one of their own orders of unknown
   * outcome is not there (an operator cancel, for self-directed
   * orders). It becomes `abandoned`: no longer blocking cash release, yet
   * still matched by ref_id if it appears on a later sync. Strategy orders
   * are cleared from the strategy page, which also cancels their leg.
   */
  async abandon(intentId:string):Promise<OrderIntent>{
   const row=await read(intentId);
   if(!row)throw new Error('Order intent not found');
   if(row.allocation_id!==null)throw new OrderConflictError('Clear a take order from its take page');
   if(row.status!=='placement_unknown')throw new OrderConflictError('Only an order of unknown outcome can be cleared');
   if(row.provider_order_ref!==null)throw new OrderConflictError('Robinhood has this order; it will be matched on the next sync');
   await database.use(db=>db.query(`UPDATE order_intents SET status='abandoned',error_code='member_checked_absent',updated_at=$2 WHERE id=$1 AND status='placement_unknown' AND provider_order_ref IS NULL`,[intentId,iso()]));
   return present((await read(intentId))!);
  },

  /**
   * What caused a fill, when Opentake placed its order: the allocation's
   * instruction, or the member's own order (Settings > Trading), which is an
   * agentic order with a known cause rather than an unexplained one.
   */
  async link(fill:{accountId:string;provider:string;orderRef:string}):Promise<Pick<FillContext,'instruction'|'memberDirected'>|undefined>{
   if(fill.provider!=='robinhood')return undefined;
   const row=(await database.use(db=>db.query<{allocation_id:string|null;transaction_id:string|null}>(`SELECT allocation_id,transaction_id FROM order_intents
    WHERE account_id=$1 AND provider_order_ref=$2`,[fill.accountId,fill.orderRef]))).rows[0];
   if(!row)return undefined;
   if(row.allocation_id===null||row.transaction_id===null)return {memberDirected:true};
   return {instruction:{allocationId:row.allocation_id,transactionId:row.transaction_id,accountId:fill.accountId,provider:'robinhood',orderRef:fill.orderRef}};
  },

  async list(accountId:string):Promise<OrderIntent[]>{
   return (await database.use(db=>db.query<Row>(viewSql+" WHERE i.asset_class='equity' AND i.account_id=$1 ORDER BY i.reviewed_at DESC LIMIT 100",[accountId]))).rows.map(present);
  },
 };
}
