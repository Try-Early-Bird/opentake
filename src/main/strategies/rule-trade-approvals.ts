// One approval flow for rule and agent
// trades on every venue. Lists what waits on a Take with its orders, and approves or declines
// one; each venue's own engine places the orders. Venues join through their `approvals` slot.
import type {createDatabaseLifecycle} from '../database';
import type {RuleTradeApproval} from '../../shared/rule-proposals';
import type {PendingTrade,VenueApprovals} from '../venues/types';
import type {VenueRegistry} from '../venues/registry';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export interface RuleTradeApprovalDeps {
 /** Cancel the trade's action job before anything is placed. */
 cancel(requestId:string):Promise<unknown>;
 /** Make the Take's waiting jobs due now. */
 nudge():Promise<void>;
}

/** Coinbase rule reviews confirmed and waiting for the member; approving submits the review
 *  (re-quoted if it aged). */
export function coinbaseRuleApprovals(database:Database,submit:(reviewId:string)=>Promise<unknown>):VenueApprovals{
 async function waiting(takeId:string|null,requestId:string|null){
  return (await database.use(db=>db.query<{request_id:string;review_id:string;kind:string;amount:string|null;rule_name:string|null;created_at:Date;orders:{side:'buy'|'sell';product:string;notional:string}[]}>(`SELECT j.request_id,j.review_id,r.action->>'kind' AS kind,r.action->'amount'->>'value' AS amount,
   r.evidence->'rule'->>'name' AS rule_name,r.created_at,v.payload->'orders' AS orders
   FROM strategy_rule_trades j JOIN strategy_rule_action_requests r ON r.id=j.request_id JOIN coinbase_order_reviews v ON v.id=j.review_id
   -- Once its orders went out it is no longer waiting, though the review stays confirmed until it settles.
   WHERE ($1::uuid IS NULL OR j.take_id=$1) AND ($2::uuid IS NULL OR j.request_id=$2) AND j.state='working' AND j.approval_pending AND v.state='confirmed' AND NOT EXISTS(SELECT 1 FROM coinbase_order_dispatches d WHERE d.review_id=v.id) ORDER BY r.created_at`,[takeId,requestId]))).rows;
 }
 return {
  pending:async takeId=>(await waiting(takeId,null)).map(r=>({requestId:r.request_id,ruleName:r.rule_name,kind:r.kind,amount:r.amount,createdAt:r.created_at.toISOString(),
   orders:r.orders.map(o=>({side:o.side,symbol:o.product.split('-')[0],amountUsd:o.notional}))})),
  async approve(requestId){
   const review=(await waiting(null,requestId))[0]?.review_id;
   if(!review)throw new Error('This trade is no longer waiting for approval.');
   await submit(review);
  },
 };
}

/** Robinhood trades previewed and waiting for the member; the engine re-sizes them when placed. */
export function robinhoodRuleApprovals(trades:{
 pending(takeId:string):Promise<{request_id:string;kind:string;amount:string|null;preview:{orders:PendingTrade['orders']};rule_name:string|null;created_at:Date}[]>;
 decide(requestId:string,approve:boolean):Promise<void>;
}):VenueApprovals{
 return {
  pending:async takeId=>(await trades.pending(takeId)).map(r=>({requestId:r.request_id,ruleName:r.rule_name,kind:r.kind,amount:r.amount,createdAt:r.created_at.toISOString(),orders:r.preview.orders,estimated:true})),
  approve:requestId=>trades.decide(requestId,true),
 };
}

export function createRuleTradeApprovals(venues:Pick<VenueRegistry,'modules'>,deps:RuleTradeApprovalDeps){
 return {
  async list(takeId:string):Promise<RuleTradeApproval[]>{
   const lists=await Promise.all(venues.modules().map(async module=>(await module.approvals?.pending(takeId)??[]).map(p=>({...p,venue:module.profile.id}))));
   return lists.flat().sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  },
  async decide(takeId:string,requestId:string,approve:boolean){
   const waiting=(await this.list(takeId)).find(a=>a.requestId===requestId);
   if(!waiting)throw new Error('This trade is no longer waiting for approval.');
   if(!approve){await deps.cancel(requestId);return;}
   const approvals=venues.modules().find(m=>m.profile.id===waiting.venue)?.approvals;
   // Listed a moment ago; a venue that is gone now must not fall through to another's approve.
   if(!approvals)throw new Error('This trade is no longer waiting for approval.');
   await approvals.approve(requestId);await deps.nudge();
  },
 };
}
