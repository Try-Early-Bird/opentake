import {CoinbaseRebalanceCashError} from './rebalance-warning';
import {quoteNeedsReconfirmation} from './quote-tolerance';
import {CoinbaseError} from './errors';
import {positionBasis,type BasisEntry} from './position-basis';
import {planCoinbaseWithdrawal,planCoinbaseClose,coinbaseWithdrawalBand} from './withdrawal-planner';
import {assertCoinbaseRisk} from './risk';
import {assertEligible,blockedAssetEligibility,reviewEligibility} from '../trading/eligibility';
import { previewCurrencyReservation } from './currency-accounting';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@electric-sql/pglite';
import type { createDatabaseLifecycle } from '../database';
import type { CoinbaseChatScope } from '../../shared/platform-connections';
import { basketSchema, type BasketSpec } from '../../shared/strategies';
import { orderReviewRequest, type CoinbaseOrderReview, type CoinbaseProposedOrder } from '../../shared/coinbase-orders';
import { createCoinbaseAllocations } from './allocations';
import { amount, format, planCoinbaseOrders, productSchema, previewResultSchema, type Candidate, type Product } from './order-planner';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
interface Dependencies {
 enabled():boolean;
 refresh(id:string):Promise<unknown>;scope(id:string):Promise<CoinbaseChatScope>;
 product(scope:CoinbaseChatScope,id:string):Promise<unknown>;
 preview(scope:CoinbaseChatScope,orders:Candidate[]):Promise<unknown[]>;
}
interface Target {account_id:string;allocation_id:string;version_id:string;account_label:string;take_title:string;spec:BasketSpec}
export interface CoinbaseReviewRow {id:string;take_id:string;account_id:string;allocation_id:string;version_id:string;authority:string;claims_hash:string;payload:CoinbaseOrderReview;state:CoinbaseOrderReview['state'];expires_at:Date}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const claimsHash=(claims:{asset:string;quantity:string;reserved:string}[])=>hash(claims.map(c=>({asset:c.asset,quantity:format(amount(c.quantity)),reserved:format(amount(c.reserved))})).sort((a,b)=>a.asset.localeCompare(b.asset)));
export class NoCoinbaseOrdersError extends Error {}
export const ruleRebalanceBusy='A rule rebalance is running for this Take. Review or wait for it to finish before starting another operation.';
/** A rule trade job that still owns its Take: working, or attention over an uncertain order. A partial rebalance holds no orders or reservations, so it blocks nothing. */
export const ruleTradeHoldsTake=(alias:string)=>`(${alias}.state='working' OR ${alias}.state='attention' AND ${alias}.reason IS DISTINCT FROM 'partial_rebalance')`;
/** Manual previews, withdrawals, closes and investments share one gate: wait for a running rule rebalance. */
export async function assertNoRuleRebalance(db:Pick<Transaction,'query'>,takeId:string){if((await db.query("SELECT 1 FROM strategy_rule_trades WHERE take_id=$1 AND state='working' LIMIT 1",[takeId])).rows.length)throw new Error(ruleRebalanceBusy);}
export function createCoinbaseOrderReviews(database:Database,deps:Dependencies,clock=()=>Date.now()) {
 const core=createCoinbaseAllocations(database,clock);
 const targetSql=`SELECT a.id AS account_id,ca.id AS allocation_id,v.id AS version_id,coalesce(d.label,a.nickname,a.masked_number) AS account_label,coalesce(nullif(v.metadata->>'title',''),t.title) AS take_title,v.spec
  FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN local_owners owner ON owner.id=s.owner_id
  JOIN strategy_versions v ON v.id=s.current_version_id AND v.source_proposal_id=s.draft_revision_id
  JOIN strategy_account_routes route ON route.strategy_id=s.id AND route.venue='coinbase'
  JOIN linked_accounts a ON a.id=route.account_id JOIN platform_connections c ON c.id=a.connection_id AND c.owner_id=s.owner_id AND c.venue='coinbase'
  JOIN coinbase_connection_details d ON d.connection_id=c.id
  JOIN coinbase_allocations ca ON ca.account_id=a.id AND ca.strategy_id=s.id AND ca.version_id=v.id
  WHERE t.id=$1 AND s.archived_at IS NULL AND s.status='committed' AND ca.status='active' AND NOT ca.restore_required AND a.available AND c.status='connected' AND d.can_trade`;
 async function target(query:Pick<Transaction,'query'>,takeId:string,unfunded=false,closing=false){
  const sql=closing?targetSql.replace("v.id=s.current_version_id AND v.source_proposal_id=s.draft_revision_id","v.id=(SELECT ca2.version_id FROM coinbase_allocations ca2 JOIN strategy_account_routes r2 ON r2.strategy_id=s.id AND r2.venue='coinbase' AND r2.account_id=ca2.account_id WHERE ca2.strategy_id=s.id)").replace('s.archived_at IS NULL AND ',''):targetSql;
  const row=(await query.query<Target>(unfunded?sql.replace('JOIN coinbase_allocations ca','LEFT JOIN coinbase_allocations ca').replace("AND ca.status='active' AND NOT ca.restore_required","AND (ca.id IS NULL OR (ca.status='active' AND NOT ca.restore_required))"):sql,[takeId])).rows[0];
  if(!row)throw new Error('A clean committed Take, funded Coinbase allocation and trading key are required.');
  row.spec=basketSchema.parse(row.spec);return row;
 }
 async function checkBlocked(query:Pick<Transaction,'query'>,symbols:string[]){
  const blocked=(await query.query<{blocked_symbols:string[]}>('SELECT p.blocked_symbols FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1')).rows[0]?.blocked_symbols??[];
  assertEligible(blockedAssetEligibility(symbols,blocked),'This review includes an asset blocked in your trading preferences.');
 }
 const get=async(id:string)=>{z.uuid().parse(id);const row=await database.use(async db=>(await db.query<CoinbaseReviewRow>('SELECT * FROM coinbase_order_reviews WHERE id=$1',[id])).rows[0]);if(!row)throw new Error('Order review unavailable.');return row;};
 const present=(row:CoinbaseReviewRow):CoinbaseOrderReview=>({...row.payload,state:row.state==='preview'&&row.expires_at.getTime()<=clock()?'expired':row.state});
 async function confirmationView(row:CoinbaseReviewRow){
  const result=present(row);
  if(result.withdrawal||result.rebalance)result.needsConfirmation=await database.use(async db=>(await db.query<{confirm_trades:boolean}>(`SELECT coalesce((SELECT p.confirm_trades FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1),false) OR EXISTS(SELECT 1 FROM strategy_rule_action_requests WHERE id=$1 AND evidence->'rule'->'policy'->>'approval'='ask') AS confirm_trades`,[row.payload.rebalance?.ruleRequestId??null])).rows[0]?.confirm_trades??false);
  return result;
 }
 async function authorize(tx:Transaction,row:CoinbaseReviewRow,ignoreOwnReservations=false,valuation=row.payload.valuation){
  assertEligible(reviewEligibility(deps.enabled(),row.expires_at.getTime(),clock()),'Trading is disabled or the review expired. Preview again.');
  const current=await target(tx,row.take_id,false,!!row.payload.withdrawal?.close);
  if((await tx.query("SELECT 1 FROM coinbase_order_reviews WHERE allocation_id=$1 AND id<>$2 AND state='confirmed' LIMIT 1",[row.allocation_id,row.id])).rows.length)throw Error('Wait for this Take’s current orders before starting another operation.');
  await checkBlocked(tx,[...current.spec.target.weights.filter(w=>w.instrument.venue==='coinbase').map(w=>w.instrument.symbol),...row.payload.orders.map(o=>o.product.split('-')[0])]);
  if(current.account_id!==row.account_id||current.allocation_id!==row.allocation_id||current.version_id!==row.version_id)throw new Error('Take or account changed. Preview again.');
  const connection=(await tx.query<{id:string;credential_ref:string;external_account_ref:string;can_trade:boolean}>(`SELECT c.id,c.credential_ref,c.external_account_ref,d.can_trade FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id JOIN coinbase_connection_details d ON d.connection_id=c.id WHERE a.id=$1`,[row.account_id])).rows[0];
  if(!connection||hash([connection.id,row.account_id,connection.credential_ref,connection.external_account_ref,connection.can_trade])!==row.authority)throw new Error('Connection changed. Preview again.');
  const claims=(await tx.query<{asset:string;quantity:string;reserved:string}>(`SELECT e.asset,sum(e.quantity)::text AS quantity,coalesce((SELECT sum(r.remaining) FROM coinbase_allocation_reservations r WHERE r.allocation_id=$1 AND r.asset=e.asset),0)::text AS reserved FROM coinbase_allocation_entries e WHERE e.allocation_id=$1 GROUP BY e.asset`,[row.allocation_id])).rows;
  if(ignoreOwnReservations){
   const own=(await tx.query<{asset:string;quantity:string}>(`SELECT r.asset,sum(r.remaining)::text AS quantity FROM coinbase_allocation_reservations r JOIN coinbase_allocation_orders o ON o.id=r.order_id WHERE o.account_id=$1 AND o.cause LIKE $2 GROUP BY r.asset`,[row.account_id,`review:${row.id}:%`])).rows;
   for(const claim of claims){const reserved=own.find(r=>r.asset===claim.asset);if(reserved)claim.reserved=format(amount(claim.reserved)-amount(reserved.quantity));}
  }
  if(claimsHash(claims)!==row.claims_hash)throw new Error('Allocation changed. Preview again.');
  await assertCoinbaseRisk(tx,{allocationId:row.allocation_id,quote:row.payload.quote,orders:row.payload.orders,value:valuation,reviewId:row.id,now:clock()});
 }
 const service={
  load:get,
  validateSubmission:(tx:Transaction,row:CoinbaseReviewRow,valuation?:string)=>authorize(tx,row,true,valuation),
  async current(takeId:string){z.uuid().parse(takeId);const row=await database.use(async db=>(await db.query<CoinbaseReviewRow>(`SELECT v.* FROM coinbase_order_reviews v WHERE v.take_id=$1 AND (v.state IN ('confirmed','settled') OR (v.state='preview' AND v.expires_at>$2) OR EXISTS(SELECT 1 FROM strategy_rule_trades j WHERE j.review_id=v.id AND ${ruleTradeHoldsTake('j')})) ORDER BY EXISTS(SELECT 1 FROM strategy_rule_trades j WHERE j.review_id=v.id AND ${ruleTradeHoldsTake('j')}) DESC,v.created_at DESC LIMIT 1`,[takeId,new Date(clock()).toISOString()])).rows[0]);return row?present(row):null;},
  async withdrawalBand(raw:unknown){
   const request=z.object({takeId:z.uuid(),quote:z.enum(['USD','USDC'])}).strict().parse(raw);
   const selected=await database.use(db=>target(db,request.takeId));
   const snapshot=await core.snapshot(selected.account_id),claims=snapshot.claims.filter(c=>c.allocationId===selected.allocation_id);
   const read=async<T>(work:()=>Promise<T>):Promise<T>=>{for(let attempt=0;;attempt++){try{return await work();}catch(error){if(!(error instanceof CoinbaseError)||error.code!=='busy'||attempt>=7)throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(250*2**attempt,2000)));}}};
   const scope=await read(()=>deps.scope(selected.account_id)),products:Product[]=[];
   for(const c of claims.filter(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n))products.push(productSchema.parse(await read(()=>deps.product(scope,`${c.asset}-${request.quote}`))));
   return coinbaseWithdrawalBand(request.quote,claims,products);
  },
  async preview(raw:unknown,funding?:{accountId:string;allocationId:string;quantity:string},rebalance?:CoinbaseOrderReview['rebalance'],purchaseOnly=false,replacement?:CoinbaseReviewRow):Promise<CoinbaseOrderReview>{
   if(!deps.enabled())throw new Error('Trading is disabled.');
   const request=orderReviewRequest.parse(raw);
   // Manual previews, withdrawals, closes and investments wait for a running rule rebalance.
   if(!rebalance?.ruleRequestId)await database.use(db=>assertNoRuleRebalance(db,request.takeId));
   if(rebalance?.ruleRequestId&&!replacement){z.uuid().parse(rebalance.ruleRequestId);const existing=(await database.use(db=>db.query<CoinbaseReviewRow>("SELECT * FROM coinbase_order_reviews WHERE payload->'rebalance'->>'ruleRequestId'=$1 AND coalesce(payload->'rebalance'->>'phase','initial')=$2 AND coalesce(payload->'rebalance'->>'quoteRevision','0')=$3",[rebalance.ruleRequestId,rebalance.phase??'initial',String(rebalance.quoteRevision??0)]))).rows[0];if(existing){if(existing.take_id!==request.takeId)throw Error('Rule review mismatch');return confirmationView(existing);}}
   const selected=await database.use(db=>target(db,request.takeId,!!funding,!!request.close));
   if(replacement&&(replacement.take_id!==request.takeId||replacement.account_id!==selected.account_id||replacement.allocation_id!==selected.allocation_id||replacement.version_id!==selected.version_id))throw Error('Take or account changed. Review the Take configuration before confirming.');
   const existingAllocation=!!selected.allocation_id;
   if(funding){if(selected.account_id!==funding.accountId||(selected.allocation_id&&selected.allocation_id!==funding.allocationId))throw new Error('The Take account changed.');selected.allocation_id=funding.allocationId;}
   await deps.refresh(selected.account_id);
   const room=await core.fundingRoom(selected.account_id);
   if(room.some(r=>r.state!=='reconciled'))throw new Error('Resolve account balance differences before previewing orders.');
   const started=clock(),scope=await deps.scope(selected.account_id);
   await deps.preview(scope,[]); // Fresh trade permission check before planning.
   const snapshot=await core.snapshot(selected.account_id),claims=snapshot.claims.filter(c=>c.allocationId===selected.allocation_id);
   if(replacement){
    const own=await database.use(async db=>(await db.query<{asset:string;quantity:string}>(`SELECT r.asset,sum(r.remaining)::text AS quantity FROM coinbase_allocation_reservations r JOIN coinbase_allocation_orders o ON o.id=r.order_id WHERE o.account_id=$1 AND o.cause LIKE $2 GROUP BY r.asset`,[replacement.account_id,`review:${replacement.id}:%`])).rows);
    for(const claim of claims){const held=own.find(r=>r.asset===claim.asset);if(held)claim.reserved=format(amount(claim.reserved)-amount(held.quantity));}
   }
   if(funding){
    const available=room.find(r=>r.asset===request.quote)?.unclaimed;
    if(available==null||amount(funding.quantity)>amount(available))throw new Error('Insufficient unassigned cash for this investment.');
    const cash=claims.find(c=>c.asset===request.quote);
    if(cash)cash.quantity=format(amount(cash.quantity)+amount(funding.quantity));
    else claims.push({accountId:selected.account_id,allocationId:selected.allocation_id,asset:request.quote,quantity:funding.quantity,reserved:'0'});
   }
   // Deploy cash: plan buys toward the target with at most this much of the Take's
   // cash. Only the planning copy is capped; the review still fingerprints the real claims.
   const planClaims=request.deployAmount===undefined?claims:claims.map(c=>c.asset===request.quote&&amount(c.quantity)>amount(request.deployAmount!)?{...c,quantity:request.deployAmount!}:c);
   const assets=[...new Set([...(request.close?[]:selected.spec.target.weights.filter(w=>w.instrument.venue==='coinbase').map(w=>w.instrument.symbol)),...claims.filter(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n).map(c=>c.asset)])];
   await database.use(db=>checkBlocked(db,assets));
   if(assets.length>20)throw new Error('At most 20 Coinbase assets per review.');
   const products:Product[]=[];for(const asset of assets)products.push(productSchema.parse(await deps.product(scope,`${asset}-${request.quote}`)));
   const makePlan=(feeBudget='0')=>request.close?planCoinbaseClose(request.quote,claims,products,request.sellSymbols):request.withdrawAmount!==undefined?planCoinbaseWithdrawal(request.withdrawAmount,request.quote,claims,products):planCoinbaseOrders(selected.spec,request.quote,planClaims,products,feeBudget,purchaseOnly||request.purchaseOnly===true||!!funding||rebalance?.phase==='buy');
   let feeBudget='0',orders:CoinbaseProposedOrder[]=[],plan=makePlan();
   for(let pass=0;pass<3;pass++){
    plan=makePlan(feeBudget);
    if(!plan.orders.length&&request.close)break;
    if(!plan.orders.length)throw new NoCoinbaseOrdersError(plan.skipped.length?plan.skipped.join('; '):'No orders needed at the current target weights.');
    const previews=await deps.preview(scope,plan.orders);if(previews.length!==plan.orders.length)throw new Error('Incomplete Coinbase preview.');
    orders=plan.orders.map((order,index)=>{
     const result=previewResultSchema.parse(previews[index]);
     if(order.side==='sell'&&amount(result.commission_total)>=amount(order.notional))throw new Error('Sale proceeds do not cover fees.');
     return {...order,fee:result.commission_total,previewId:result.preview_id,debits:order.side==='buy'?[{asset:request.quote,quantity:format(amount(order.notional)+amount(result.commission_total))}]:[{asset:order.product.split('-')[0],quantity:order.baseSize}]};
    });
    const fees=orders.reduce((sum,o)=>sum+amount(o.fee),0n);
    const cost=orders.filter(o=>o.side==='buy').reduce((sum,o)=>sum+amount(o.notional)+amount(o.fee),0n);
    if(plan.phase==='sell'||(pass>0&&cost<=amount(plan.cash)&&fees<=amount(feeBudget)))break;
    if(pass===2){if(cost>amount(plan.cash))throw new CoinbaseRebalanceCashError({currency:request.quote,required:format(cost),available:plan.cash,shortfall:format(cost-amount(plan.cash))});throw new Error('Coinbase fee estimates are still changing. Retry the investment preview.');}
    let nextBudget=fees>amount(feeBudget)?fees:amount(feeBudget);
    // Each buy's quote amount rounds up independently. Reserving fees alone can
    // leave the same fractional-quote shortfall on every sizing pass.
    if(pass>0&&cost>amount(plan.cash)){
     const rounding=plan.orders.filter(o=>o.side==='buy').reduce((sum,o)=>sum+amount(products.find(p=>p.product_id===o.product)!.quote_increment),0n);
     nextBudget+=cost-amount(plan.cash)+rounding;
    }
    feeBudget=format(nextBudget);
   }
   if(existingAllocation)await database.use(db=>assertCoinbaseRisk(db,{allocationId:selected.allocation_id,quote:request.quote,orders,value:plan.value,reviewId:replacement?.id,now:clock()}));
   let plannedClaims=[...snapshot.claims.filter(c=>c.allocationId!==selected.allocation_id),...claims];
   const balances=room.map(r=>({asset:r.asset,total:r.total!,available:r.available}));
   for(const order of orders)for(const debit of order.debits){
    const reserved=previewCurrencyReservation(selected.account_id,selected.allocation_id,debit.asset,debit.quantity,balances,plannedClaims);
    plannedClaims=plannedClaims.map(c=>c.allocationId===reserved.allocationId&&c.asset===reserved.asset?reserved:c);
   }
   if(clock()-started>=60000)throw new Error('Preview timed out. Try again.');
   const id=randomUUID(),expiresAt=new Date(started+60000).toISOString();
   const payload:CoinbaseOrderReview={...(replacement?{previousQuoteOrders:replacement.payload.orders.map(({product,side,baseSize,limitPrice,notional,fee})=>({product,side,baseSize,limitPrice,notional,fee}))}:{}),...(rebalance?{rebalance}:{}),...(request.withdrawAmount!==undefined||request.close?{withdrawal:{...(request.close?{close:true,residue:planCoinbaseClose(request.quote,claims,products,request.sellSymbols).residue}:{}),requestedAmount:request.withdrawAmount??plan.value,estimatedProceeds:format(orders.reduce((sum,o)=>sum+amount(o.notional)-amount(o.fee),0n))}}:{}),valuation:plan.value,id,takeId:request.takeId,accountLabel:selected.account_label,takeTitle:selected.take_title,quote:request.quote,phase:plan.phase,orders,skipped:plan.skipped,expiresAt,state:'preview'};
   if(request.withdrawAmount!==undefined&&!request.close){
    const withdrawal=planCoinbaseWithdrawal(request.withdrawAmount,request.quote,claims,products);
    payload.withdrawal!.band=withdrawal.band;payload.withdrawal!.remainingValue=withdrawal.remainingValue;
   }
   if(request.close){
    const entries=await database.use(async db=>(await db.query<BasisEntry>('SELECT asset,quantity::text,kind,cause FROM coinbase_allocation_entries WHERE allocation_id=$1 ORDER BY occurred_at,id',[selected.allocation_id])).rows);
    const all=planCoinbaseClose(request.quote,claims,products);
    payload.closePositions=claims.filter(c=>!['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n).map(c=>{
     const product=products.find(p=>p.product_id===`${c.asset}-${request.quote}`)!;
     const value=amount(c.quantity)*amount(product.price)/(10n**36n),basis=positionBasis(entries,c.asset,request.quote);
     return {symbol:c.asset,quantity:format(amount(c.quantity)),value:format(value),unrealized:basis.cost!==null&&amount(basis.quantity)===amount(c.quantity)?`${value<amount(basis.cost)?'-':''}${format(value<amount(basis.cost)?amount(basis.cost)-value:value-amount(basis.cost))}`:null,sellable:all.orders.some(o=>o.product===product.product_id)};
    });
    payload.closeCash=claims.filter(c=>['USD','USDC'].includes(c.asset)&&amount(c.quantity)>0n).map(c=>({asset:c.asset,quantity:c.quantity}));
   }
   if(funding)return payload; // Provider-checked dry run; cash and order reservations are unchanged.
   await database.use(db=>db.query(`INSERT INTO coinbase_order_reviews(id,take_id,account_id,allocation_id,version_id,authority,claims_hash,payload,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,request.takeId,selected.account_id,selected.allocation_id,selected.version_id,scope.authority,claimsHash(claims),JSON.stringify(payload),new Date(clock()).toISOString(),expiresAt]));
   return payload;
  },
  async renewRuleApproval(id:string,validate:(tx:Transaction,row:CoinbaseReviewRow)=>Promise<void>):Promise<CoinbaseOrderReview>{
   const old=await get(id),requestId=old.payload.rebalance?.ruleRequestId;
   if(!requestId||old.state!=='confirmed')throw Error('Approval review unavailable.');
   const job=await database.use(async db=>(await db.query<{approval_pending:boolean;review_id:string;state:string}>('SELECT approval_pending,review_id,state FROM strategy_rule_trades WHERE request_id=$1',[requestId])).rows[0]);
   if(!job?.approval_pending||job.review_id!==id||job.state!=='working')throw Error('Approval review changed.');
   const revision=await database.use(async db=>(await db.query<{revision:number}>("SELECT coalesce(max((payload->'rebalance'->>'quoteRevision')::int),0)+1 AS revision FROM coinbase_order_reviews WHERE payload->'rebalance'->>'ruleRequestId'=$1",[requestId])).rows[0].revision);
   const next=await service.preview({takeId:old.take_id,quote:old.payload.quote},undefined,{...old.payload.rebalance!,quoteRevision:revision},false,old);
   const row=await get(next.id);
   await core.replacePreparedOrders(old.account_id,old.payload.orders.map((_,index)=>`review:${id}:${index}`),next.orders.map((o,index)=>({accountId:row.account_id,allocationId:row.allocation_id,product:o.product,side:o.side,maxBase:o.baseSize,...(o.orderType==='market'&&o.side==='buy'?{quoteSized:true}:{}),debits:o.debits,cause:`review:${next.id}:${index}`})),async tx=>{
    await validate(tx,old);
    const current=(await tx.query<{review_id:string;state:string;approval_pending:boolean}>('SELECT review_id,state,approval_pending FROM strategy_rule_trades WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
    if(current?.review_id!==id||current.state!=='working'||!current.approval_pending)throw Error('Approval changed while refreshing.');
    await tx.query("UPDATE coinbase_order_reviews SET state='cancelled' WHERE id=$1 AND state='confirmed'",[id]);
    await authorize(tx,row);
    await tx.query("UPDATE coinbase_order_reviews SET state='confirmed' WHERE id=$1 AND state='preview'",[next.id]);
    await tx.query('UPDATE strategy_rule_trades SET review_id=$2,updated_at=$3 WHERE request_id=$1',[requestId,next.id,new Date(clock())]);
   });
   return {...await confirmationView(await get(next.id)),reconfirmationRequired:quoteNeedsReconfirmation(old.payload,next)};
  },
  async confirm(id:string){
   if(!deps.enabled())throw new Error('Trading is disabled.');
   const row=await get(id);if(row.state==='confirmed')return confirmationView(row);
   if(row.state!=='preview'||row.expires_at.getTime()<=clock())throw new Error('Review expired. Preview orders again.');
   const scope=await deps.scope(row.account_id);if(scope.authority!==row.authority)throw new Error('Connection changed. Preview again.');await deps.preview(scope,[]);
   if(row.payload.withdrawal?.close&&!row.payload.orders.length){
    await database.use(db=>db.transaction(async tx=>{
     await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[row.account_id]);
     await authorize(tx,row);
     await tx.query("UPDATE coinbase_order_reviews SET state='confirmed' WHERE id=$1 AND state='preview'",[id]);
    }));
    return confirmationView(await get(id));
   }
   await core.prepareOrders(row.payload.orders.map((o,index)=>({accountId:row.account_id,allocationId:row.allocation_id,product:o.product,side:o.side,maxBase:o.baseSize,...(o.orderType==='market'&&o.side==='buy'?{quoteSized:true}:{}),debits:o.debits,cause:`review:${id}:${index}`})),async tx=>{
    const state=(await tx.query<{state:string}>('SELECT state FROM coinbase_order_reviews WHERE id=$1',[id])).rows[0]?.state;
    if(state==='confirmed')return;
    await authorize(tx,row);
    if(!(await tx.query("UPDATE coinbase_order_reviews SET state='confirmed' WHERE id=$1 AND state='preview' AND expires_at>$2 RETURNING id",[id,new Date(clock()).toISOString()])).rows.length)throw new Error('Review expired. Preview again.');
   });
   return confirmationView(await get(id));
  },
  async cancel(id:string){
   const row=await get(id);if(row.state==='cancelled')return present(row);
   // An unconfirmed preview reserved nothing and nothing was sent: discard it.
   if(row.state==='preview'){
    await database.use(db=>db.transaction(async tx=>{
     await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[row.account_id]);
     if((await tx.query('SELECT 1 FROM coinbase_allocation_orders WHERE account_id=$1 AND cause LIKE $2 LIMIT 1',[row.account_id,`review:${id}:%`])).rows.length)throw new Error('Only an unsent confirmed reservation can be cancelled.');
     await tx.query("UPDATE coinbase_order_reviews SET state='cancelled' WHERE id=$1 AND state='preview'",[id]);
    }));
    return present(await get(id));
   }
   // Prepared-only gate prevents releasing a dispatched or uncertain order.
   await core.cancelPrepared(row.account_id,row.payload.orders.map((_,index)=>`review:${id}:${index}`),async tx=>{
    if(!(await tx.query("UPDATE coinbase_order_reviews SET state='cancelled' WHERE id=$1 AND state='confirmed' RETURNING id",[id])).rows.length)throw new Error('Only an unsent confirmed reservation can be cancelled.');
   });
   return present(await get(id));
  },
 };
 return service;
}
