import {dispatchOrder,type SubmissionResult} from '../trading/dispatch';
import type {AccountQueues} from '../execution/account-queues';
import {observedOrderState,type CancellationState} from '../../shared/trading';
import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import type {CoinbaseChatScope} from '../../shared/platform-connections';
import type {CoinbaseOrderReview} from '../../shared/coinbase-orders';
import {createCoinbaseAllocations} from './allocations';
import type {createCoinbaseOrderReviews,CoinbaseReviewRow} from './order-reviews';
import {amount,format,productSchema,previewResultSchema,type Candidate} from './order-planner';
import {validateSubmissionProduct,type CoinbaseSubmission} from './dispatch-contract';
import {reconcileDispatches} from './dispatch-state';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Reviews=ReturnType<typeof createCoinbaseOrderReviews>;
interface Dependencies {
 enabled():boolean;
 validateRuleTrade?(tx:Pick<Transaction,'query'>,row:CoinbaseReviewRow,manual:boolean):Promise<void>;
 refresh(id:string):Promise<unknown>;scope(id:string):Promise<CoinbaseChatScope>;
 product(scope:CoinbaseChatScope,id:string):Promise<unknown>;
 preview(scope:CoinbaseChatScope,orders:Candidate[]):Promise<unknown[]>;
 submit(scope:CoinbaseChatScope,order:CoinbaseSubmission,beforeSend:()=>Promise<void>):Promise<SubmissionResult>;
 cancel(scope:CoinbaseChatScope,id:string,beforeSend:()=>Promise<void>):Promise<boolean>;
 /** Queues account operations instead of refusing a second one. */
 accounts?:AccountQueues;
 /** Called after orders were sent, so follow-up checks can start promptly. */
 submitted?(accountId:string):void;
}
interface Order {filled_quantity?:string|null;id:string;cause:string;client_ref:string;provider_order_ref:string|null;state:string;dispatch_state:string|null;cancel_state:CancellationState|null;provider_state:string|null}
export function createCoinbaseExecution(database:Database,reviews:Reviews,deps:Dependencies,clock=()=>Date.now()){
 const core=createCoinbaseAllocations(database,clock),active=new Map<string,number>(),settling=new Set<Promise<unknown>>();let closing=false;
 const now=()=>new Date(clock()).toISOString();
 const orders=(row:CoinbaseReviewRow)=>database.use(async db=>(await db.query<Order>(`SELECT o.*,d.state AS dispatch_state,d.cancel_state,p.state AS provider_state,p.data->>'filledQuantity' AS filled_quantity FROM coinbase_allocation_orders o LEFT JOIN coinbase_order_dispatches d ON d.order_id=o.id LEFT JOIN account_orders p ON p.account_id=o.account_id AND p.provider='coinbase' AND p.provider_ref=o.provider_order_ref WHERE o.account_id=$1 AND o.cause LIKE $2`,[row.account_id,`review:${row.id}:%`])).rows);
 async function view(id:string):Promise<CoinbaseOrderReview>{
  const row=await reviews.load(id),items=await orders(row);
  const returned=row.payload.withdrawal?await database.use(async db=>(await db.query<{quantity:string}>("SELECT (-quantity)::text AS quantity FROM coinbase_allocation_entries WHERE cause=$1 AND asset=$2",[`withdrawal-return:${id}`,row.payload.quote])).rows[0]):null;
  const closed=!!row.payload.withdrawal?.close&&row.state==='settled'&&(await core.snapshot(row.account_id)).claims.filter(c=>c.allocationId===row.allocation_id).every(c=>amount(c.quantity)===0n);
  const needsConfirmation=!!(row.payload.withdrawal||row.payload.rebalance)&&row.state==='confirmed'&&items.every(o=>!o.dispatch_state)&&await database.use(async db=>(await db.query<{confirm_trades:boolean}>(`SELECT coalesce((SELECT p.confirm_trades FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1),false) OR EXISTS(SELECT 1 FROM strategy_rule_action_requests r LEFT JOIN strategy_rule_trades j ON j.request_id=r.id WHERE r.id=$1 AND (r.evidence->'rule'->'policy'->>'approval'='ask' OR j.approval_pending)) AS confirm_trades`,[row.payload.rebalance?.ruleRequestId??null])).rows[0]?.confirm_trades??false);
  return {...row.payload,...(row.payload.withdrawal?.close?{closed}:{}),...((row.payload.withdrawal||row.payload.rebalance)?{needsConfirmation}:{}),...(returned?{returnedAmount:format(amount(returned.quantity))}:{}),state:row.state,orders:row.payload.orders.map((o,index)=>{const item=items.find(i=>i.cause===`review:${id}:${index}`);return {...o,...(item?.filled_quantity!=null?{filledQuantity:item.filled_quantity}:item?.state==='closed'&&!item.dispatch_state&&!item.provider_order_ref?{filledQuantity:'0'}:{}),...(item?{execution:{state:observedOrderState(item.state==='closed'?(item.provider_state??(item.dispatch_state==='rejected'?'rejected':'cancelled')):item.state==='bound'?(item.provider_state??'accepted'):item.state==='prepared'?'reserved':item.state,item.filled_quantity),cancelState:item.cancel_state??'none'}}:{})};})};
 }
 async function exclusive(id:string,work:(row:CoinbaseReviewRow)=>Promise<CoinbaseOrderReview>){
  const row=await reviews.load(id);if(closing)throw new Error('An account operation is already running.');
  const run=async(current:CoinbaseReviewRow)=>{
   active.set(current.account_id,(active.get(current.account_id)??0)+1);const task=work(current);settling.add(task);
   try{return await task;}finally{settling.delete(task);const left=(active.get(current.account_id)??1)-1;if(left)active.set(current.account_id,left);else active.delete(current.account_id);}
  };
  // With account queues a second operation waits its turn; reload the review after waiting.
  if(deps.accounts)return deps.accounts.run([row.account_id],async()=>{if(closing)throw new Error('An account operation is already running.');return run(await reviews.load(id));},{label:'coinbase orders'});
  if(active.has(row.account_id))throw new Error('An account operation is already running.');
  return run(row);
 }
 async function locked(row:CoinbaseReviewRow,work:(tx:Transaction)=>Promise<void>){await database.use(db=>db.transaction(async tx=>{await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[row.account_id]);await work(tx);}));}
 // A rule review is dispatched in one pass and never resumed. Once any order of it
 // was claimed, unsent remainders are released rather than left reserved.
 async function releaseUnsent(row:CoinbaseReviewRow){
  if(!row.payload.rebalance?.ruleRequestId)return;
  const items=await orders(row);if(!items.some(o=>o.dispatch_state))return;
  const unsent=items.filter(o=>o.state==='prepared'&&!o.dispatch_state).map(o=>o.cause);
  if(unsent.length)await core.cancelPrepared(row.account_id,unsent,async()=>{});
 }
 async function refresh(row:CoinbaseReviewRow){await deps.refresh(row.account_id);if(row.state==='confirmed')await releaseUnsent(row);await reconcileDispatches(database,row.account_id,clock);return view(row.id);}
 // Whatever happened, orders may now be out: let follow-up checks start promptly.
 function followUp<T>(id:string,work:Promise<T>):Promise<T>{
  return work.finally(()=>{if(deps.submitted)void reviews.load(id).then(row=>deps.submitted!(row.account_id)).catch(()=>{});});
 }
 return {
  view,
  busy:()=>active.size>0,
  async close(){closing=true;await Promise.allSettled([...settling]);},
  async start(){await database.use(db=>db.transaction(async tx=>{
   await tx.query("UPDATE coinbase_allocation_orders SET state='unknown' WHERE state='submitting'");
   await tx.query("UPDATE coinbase_order_dispatches SET state='unknown',updated_at=$1 WHERE state='sending'",[now()]);
   await tx.query("UPDATE coinbase_order_dispatches SET cancel_state='unknown',updated_at=$1 WHERE cancel_state='sending'",[now()]);
  }));},
  async current(takeId:string){const current=await reviews.current(takeId);return current?view(current.id):null;},
  refresh:(id:string)=>exclusive(id,refresh),
  submit:(id:string,manual=true)=>followUp(id,exclusive(id,async row=>{
   if(!deps.enabled())throw new Error('Trading is disabled.');
   if(row.state==='settled')return view(id);
   if(row.state!=='confirmed')throw new Error('Confirm an order reservation first.');
   let items=await orders(row);
   // A durable attempt is never resent, including after a lost response or restart.
   if(items.some(o=>o.dispatch_state))return view(id);
   if(items.length!==row.payload.orders.length||items.some(o=>o.state!=='prepared'))throw new Error('Reservation unavailable.');
   if(manual&&row.payload.rebalance?.ruleRequestId){
    const approval=await database.use(async db=>(await db.query<{approval_pending:boolean}>("SELECT approval_pending FROM strategy_rule_trades WHERE request_id=$1 AND review_id=$2 AND state='working'",[row.payload.rebalance!.ruleRequestId,id])).rows[0]?.approval_pending);
    // A refreshed quote is what the user is now confirming. Replanning it on
    // every click can make a moving market impossible to approve.
    const freshReplacement=(row.payload.rebalance.quoteRevision??0)>0&&row.expires_at.getTime()>clock();
    if(approval&&!freshReplacement){
     if(!deps.validateRuleTrade)throw Error('Rule execution unavailable');
     const renewed=await reviews.renewRuleApproval(id,(tx,old)=>deps.validateRuleTrade!(tx,old,true));
     if(renewed.reconfirmationRequired)return {...await view(renewed.id),reconfirmationRequired:true};
     id=renewed.id;row=await reviews.load(id);items=await orders(row);
    }
   }
   if(row.expires_at.getTime()<=clock())throw new Error('Review expired. Cancel the reservation and preview again.');
   await deps.refresh(row.account_id);
   const scope=await deps.scope(row.account_id);if(scope.authority!==row.authority)throw new Error('Connection changed. Cancel the reservation and preview again.');
   if(row.payload.withdrawal?.close&&!row.payload.orders.length){await reconcileDispatches(database,row.account_id,clock);return view(id);}
   const claims=(await core.snapshot(row.account_id)).claims.filter(c=>c.allocationId===row.allocation_id);
   let value=0n;
   for(const claim of claims){
    if(amount(claim.quantity)===0n)continue;
    if(['USD','USDC'].includes(claim.asset)&&row.payload.withdrawal?.close&&claim.asset!==row.payload.quote)continue;
    if(claim.asset===row.payload.quote){value+=amount(claim.quantity);continue;}
    const p=productSchema.parse(await deps.product(scope,`${claim.asset}-${row.payload.quote}`));
    if(p.product_id!==`${claim.asset}-${row.payload.quote}`||p.base_currency_id!==claim.asset||p.quote_currency_id!==row.payload.quote)throw new Error('Risk valuation market mismatch');
    value+=amount(claim.quantity)*amount(p.price)/(10n**36n);
   }
   const rule=!!row.payload.rebalance?.ruleRequestId;let dispatched=false;
   try{
   for(let index=0;index<row.payload.orders.length;index++){
    const proposed=row.payload.orders[index],item=items.find(o=>o.cause===`review:${id}:${index}`)!;
    await validateSubmissionProduct(proposed,await deps.product(scope,proposed.product));
    const previews=await deps.preview(scope,[{...(proposed.orderType?{orderType:proposed.orderType}:{}),product:proposed.product,side:proposed.side,baseSize:proposed.baseSize,limitPrice:proposed.limitPrice,notional:proposed.notional}]);if(previews.length!==1)throw new Error('Incomplete Coinbase preview.');
    const preview=previewResultSchema.parse(previews[0]);
    // Buys reserve quote cash including fees. Sells reserve base units and pay
    // fees from their proceeds; a changing estimate does not increase that debit.
    if(proposed.side==='buy'&&amount(preview.commission_total)>amount(proposed.fee))throw new Error('Fees increased. Cancel remaining reservations and preview again.');
    if(proposed.side==='sell'&&amount(preview.commission_total)>=amount(proposed.notional))throw new Error('Sale proceeds do not cover fees.');
    const result=await dispatchOrder({send:beforeSend=>deps.submit(scope,{...(proposed.orderType?{orderType:proposed.orderType}:{}),product:proposed.product,side:proposed.side,baseSize:proposed.baseSize,limitPrice:proposed.limitPrice,notional:proposed.notional,clientRef:item.client_ref,previewId:preview.preview_id},beforeSend)},{claim:async()=>{
      if(closing||!deps.enabled())throw new Error('Trading is disabled.');
      await core.dispatchOrder(row.account_id,item.id,async tx=>{
       // Later orders of a rule review are sent under the first order's rule validation.
       if(rule&&!dispatched){if(!deps.validateRuleTrade)throw Error('Rule execution unavailable');await deps.validateRuleTrade(tx,row,manual);}
       await reviews.validateSubmission(tx,row,format(value));
       const current=(await tx.query<{state:string;expires_at:Date}>('SELECT state,expires_at FROM coinbase_order_reviews WHERE id=$1',[id])).rows[0];
       if(current?.state!=='confirmed'||current.expires_at.getTime()<=clock())throw new Error('Review expired. Cancel the reservation and preview again.');
       await tx.query("INSERT INTO coinbase_order_dispatches(order_id,review_id,state,started_at,updated_at) VALUES($1,$2,'sending',$3,$3)",[item.id,id,now()]);
      });
      dispatched=true;
     },record:async result=>{
     await locked(row,async tx=>{
      const current=(await tx.query<Order>('SELECT * FROM coinbase_allocation_orders WHERE id=$1',[item.id])).rows[0];
      if(result.state==='accepted'){
       if(current.provider_order_ref&&current.provider_order_ref!==result.providerRef)throw new Error('Conflicting order identity');
       await tx.query("UPDATE coinbase_allocation_orders SET provider_order_ref=$2,state=CASE WHEN state IN ('submitting','unknown') THEN 'bound' ELSE state END WHERE id=$1",[item.id,result.providerRef]);
       await tx.query("UPDATE coinbase_order_dispatches SET state='accepted',updated_at=$2 WHERE order_id=$1",[item.id,now()]);
      }else if(result.state==='rejected'){
       if(current.provider_order_ref||current.state!=='submitting'||(await tx.query("SELECT 1 FROM account_orders WHERE account_id=$1 AND provider='coinbase' AND data->>'clientOrderRef'=$2",[row.account_id,item.client_ref])).rows.length)throw new Error('Conflicting rejection evidence');
       await tx.query("UPDATE coinbase_order_dispatches SET state='rejected',updated_at=$2 WHERE order_id=$1",[item.id,now()]);
       await tx.query('UPDATE coinbase_allocation_reservations SET remaining=0 WHERE order_id=$1',[item.id]);
       await tx.query("UPDATE coinbase_allocation_orders SET state='closed',closed_at=$2 WHERE id=$1",[item.id,now()]);
      }else{
       await tx.query("UPDATE coinbase_order_dispatches SET state='unknown',updated_at=$2 WHERE order_id=$1 AND state='sending'",[item.id,now()]);
       await tx.query("UPDATE coinbase_allocation_orders SET state='unknown' WHERE id=$1 AND state='submitting'",[item.id]);
      }
     });
     },unknown:async()=>{
     await locked(row,async tx=>{
      await tx.query("UPDATE coinbase_order_dispatches SET state='unknown',updated_at=$2 WHERE order_id=$1 AND state='sending'",[item.id,now()]);
      await tx.query("UPDATE coinbase_allocation_orders SET state='unknown' WHERE id=$1 AND state='submitting'",[item.id]);
     });
    }});
    if(result.state!=='accepted')break;
   }
   }catch(error){if(!rule||!dispatched)throw error;}
   await releaseUnsent(row);
   await reconcileDispatches(database,row.account_id,clock);return view(id);
  })),
  cancel:(id:string)=>exclusive(id,async row=>{
   if(row.state==='settled'||row.state==='cancelled')return view(id);
   if(row.state!=='confirmed')throw new Error('Only confirmed orders can be cancelled.');
   for(const item of await orders(row)){
    if(item.state==='closed')continue;
    if(item.state==='prepared'&&!item.dispatch_state){await core.cancelPrepared(row.account_id,[item.cause],async()=>{});continue;}
    if(!item.provider_order_ref||!['bound','reconciliation_required'].includes(item.state)||['sending','requested'].includes(item.cancel_state??''))continue;
    const scope=await deps.scope(row.account_id);let started=false;
    try{
     const accepted=await deps.cancel(scope,item.provider_order_ref,async()=>{
      await locked(row,async tx=>{
       const current=(await tx.query<Order>('SELECT * FROM coinbase_allocation_orders WHERE id=$1',[item.id])).rows[0];
       if(current.state==='closed'||current.provider_order_ref!==item.provider_order_ref)throw new Error('Order changed. Refresh its status.');
       await tx.query("UPDATE coinbase_order_dispatches SET cancel_state='sending',updated_at=$2 WHERE order_id=$1",[item.id,now()]);
      });started=true;
     });
     await database.use(db=>db.query('UPDATE coinbase_order_dispatches SET cancel_state=$2,updated_at=$3 WHERE order_id=$1',[item.id,accepted?'requested':'rejected',now()]));
    }catch(error){if(!started)throw error;await database.use(db=>db.query("UPDATE coinbase_order_dispatches SET cancel_state='unknown',updated_at=$2 WHERE order_id=$1",[item.id,now()]));}
   }
   await reconcileDispatches(database,row.account_id,clock);return view(id);
  }),
 };
}
