// One approval flow for rule and agent
// trades on every venue. Lists what waits on a Take with its orders, and approves or declines
// one; each venue's own engine places the orders.
import type {createDatabaseLifecycle} from '../database';
import type {RuleTradeApproval} from '../../shared/rule-proposals';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export interface RuleTradeApprovalDeps {
 robinhood:{
  pending(takeId:string):Promise<{request_id:string;kind:string;amount:string|null;preview:{orders:{symbol:string;side:'buy'|'sell';amountUsd:string|null}[]};rule_name:string|null;created_at:Date}[]>;
  decide(requestId:string,approve:boolean):Promise<void>;
 };
 /** Submit a Coinbase rule review the member approved (re-quoted if it aged). */
 submitCoinbase(reviewId:string):Promise<unknown>;
 /** Cancel the trade's action job before anything is placed. */
 cancel(requestId:string):Promise<unknown>;
 /** Make the Take's waiting jobs due now. */
 nudge():Promise<void>;
}

export function createRuleTradeApprovals(database:Database,deps:RuleTradeApprovalDeps){
 async function coinbase(takeId:string){
  return (await database.use(db=>db.query<{request_id:string;review_id:string;kind:string;amount:string|null;rule_name:string|null;created_at:Date;orders:{side:'buy'|'sell';product:string;notional:string}[]}>(`SELECT j.request_id,j.review_id,r.action->>'kind' AS kind,r.action->'amount'->>'value' AS amount,
   r.evidence->'rule'->>'name' AS rule_name,r.created_at,v.payload->'orders' AS orders
   FROM strategy_rule_trades j JOIN strategy_rule_action_requests r ON r.id=j.request_id JOIN coinbase_order_reviews v ON v.id=j.review_id
   -- Once its orders went out it is no longer waiting, though the review stays confirmed until it settles.
   WHERE j.take_id=$1 AND j.state='working' AND j.approval_pending AND v.state='confirmed' AND NOT EXISTS(SELECT 1 FROM coinbase_order_dispatches d WHERE d.review_id=v.id) ORDER BY r.created_at`,[takeId]))).rows;
 }
 return {
  async list(takeId:string):Promise<RuleTradeApproval[]>{
   const cb=(await coinbase(takeId)).map(r=>({requestId:r.request_id,venue:'coinbase' as const,ruleName:r.rule_name,kind:r.kind,amount:r.amount,createdAt:r.created_at.toISOString(),
    orders:r.orders.map(o=>({side:o.side,symbol:o.product.split('-')[0],amountUsd:o.notional}))}));
   const rh=(await deps.robinhood.pending(takeId)).map(r=>({requestId:r.request_id,venue:'robinhood' as const,ruleName:r.rule_name,kind:r.kind,amount:r.amount,createdAt:r.created_at.toISOString(),orders:r.preview.orders}));
   return [...cb,...rh].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  },
  async decide(takeId:string,requestId:string,approve:boolean){
   const waiting=(await this.list(takeId)).find(a=>a.requestId===requestId);
   if(!waiting)throw new Error('This trade is no longer waiting for approval.');
   if(!approve){await deps.cancel(requestId);return;}
   if(waiting.venue==='robinhood'){await deps.robinhood.decide(requestId,true);await deps.nudge();return;}
   const review=(await coinbase(takeId)).find(r=>r.request_id===requestId)!.review_id;
   await deps.submitCoinbase(review);await deps.nudge();
  },
 };
}
