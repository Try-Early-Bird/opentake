import {createHash} from 'node:crypto';
import type {Database} from './contracts';
import type {Executor} from '../execution/contracts';
import type {MixedWithdrawalDependencies} from './withdrawal';
import type {createAllocationInstructions} from '../execution/instructions';
import type {createCoinbaseCapital} from '../coinbase/capital';
import type {createCoinbaseOrderReviews} from '../coinbase/order-reviews';
import type {createCoinbaseExecution} from '../coinbase/execution';
import {robinhoodEquitySession} from '../trading/session-policy';
import {decimalToScaledInteger as units,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function mixedWithdrawalAdapters(database:Database,deps:{executor:Executor;enabled():boolean;instructions:ReturnType<typeof createAllocationInstructions>;capital:ReturnType<typeof createCoinbaseCapital>;orders:ReturnType<typeof createCoinbaseOrderReviews>;execution:ReturnType<typeof createCoinbaseExecution>;rate():Promise<string>}):MixedWithdrawalDependencies{
 const {instructions,capital,orders,execution}=deps;
 const strategy=(takeId:string)=>database.use(async db=>{const r=(await db.query<{strategy_id:string}>('SELECT strategy_id FROM takes WHERE id=$1',[takeId])).rows[0];if(!r)throw Error('Take not found.');return r.strategy_id;});
 async function rh(takeId:string){const id=await strategy(takeId);return (await instructions.holdings()).holdings.find(h=>h.strategy.id===id);}
 const evidence=(h:NonNullable<Awaited<ReturnType<typeof rh>>>)=>hash([h.bucket.id,h.bucket.status,h.positions.map(p=>[p.symbol,p.quantity]),h.valuation.cash,h.requiresReconciliation]);
 async function idle(takeId:string){
  const id=await strategy(takeId);
  await database.use(async db=>{
   if((await db.query("SELECT 1 FROM mixed_take_executions WHERE take_id=$1 AND state<>'completed'",[takeId])).rows.length)throw Error('Wait for the current investment to finish before taking money out.');
   if((await db.query(`SELECT 1 FROM strategy_executions WHERE strategy_id=$1 AND status NOT IN ('filled','cancelled','failed')
     UNION ALL SELECT 1 FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id WHERE a.strategy_id=$1 AND t.outcome IS NULL AND t.pending_reason IS NOT NULL
     UNION ALL SELECT 1 FROM coinbase_allocation_orders o JOIN coinbase_allocations a ON a.id=o.allocation_id WHERE a.strategy_id=$1 AND o.state<>'closed' LIMIT 1`,[id])).rows.length)throw Error('Wait for this Take’s existing orders to finish before taking money out.');
  });
 }
 return {
  enabled:deps.enabled,
  async accounts(takeId,quote){
   await idle(takeId);const id=await strategy(takeId);
   const routes=await database.use(async db=>(await db.query<{venue:'coinbase'|'robinhood';accountId:string;accountLabel:string}>(`SELECT r.venue,r.account_id AS "accountId",coalesce(d.label,a.nickname,a.masked_number) AS "accountLabel"
    FROM strategy_account_routes r JOIN linked_accounts a ON a.id=r.account_id LEFT JOIN coinbase_connection_details d ON d.connection_id=a.connection_id WHERE r.strategy_id=$1 ORDER BY r.venue`,[id])).rows);
   if(routes.length!==2||!routes.some(r=>r.venue==='coinbase')||!routes.some(r=>r.venue==='robinhood'))throw Error('This action requires a mixed Take with both saved accounts.');
   const c=await capital.view(takeId),h=await rh(takeId),result=[];
   for(const route of routes){
    if(route.venue==='coinbase'){
     if(!c.balances.some(b=>Number(b.quantity)>0))continue;
     if(c.accountId!==route.accountId||c.valuation?.value==null||c.valuation.currency!=='USD'||c.balances.some(b=>Number(b.reserved)>0))throw Error('Coinbase holdings are unavailable or reserved. Refresh the account and retry.');
     result.push({...route,currency:quote,rate:quote==='USD'?'1':await deps.rate(),valueUsd:c.valuation.value,holdingsUsd:decimal(c.balances.filter(b=>!['USD','USDC'].includes(b.asset)).reduce((n,b)=>n+units(b.value??'0',36),0n),36)});
    }else if(h){
     const matching=await database.use(async db=>(await db.query('SELECT 1 FROM strategy_allocations WHERE id=$1 AND account_id=$2',[h.bucket.id,route.accountId])).rows.length);
     if(!matching)throw Error('Robinhood’s selected account does not match this Take. Select its original account before withdrawing.');
     if(!h.valuation.complete||h.valuation.totalValue===null||h.requiresReconciliation||h.openExecutions||h.outsideSale||h.outsideCash)throw Error('Resolve Robinhood’s holdings or pending orders before withdrawing.');
     result.push({...route,currency:'USD' as const,rate:'1',valueUsd:h.valuation.totalValue,holdingsUsd:decimal(h.positions.reduce((n,p)=>n+units(p.value??'0',36),0n),36)});
    }else {
     const active=await database.use(async db=>(await db.query("SELECT 1 FROM strategy_allocations WHERE strategy_id=$1 AND account_id=$2 AND status IN ('active','paused','diverged')",[id,route.accountId])).rows.length);
     if(active)throw Error('Select this Take’s Robinhood account before withdrawing from the whole Take.');
    }
   }
   return result;
  },
  async band(takeId,account){
   if(account.venue==='coinbase')return orders.withdrawalBand({takeId,quote:account.currency});
   const h=await rh(takeId);if(!h)throw Error('Robinhood holdings unavailable.');
   return (await instructions.redemptionPreview(h.bucket.id,'1')).band;
  },
  async preview(request,account,amount){
   if(account.venue==='coinbase'){
    const r=await orders.preview({takeId:request.takeId,quote:account.currency,...(request.kind==='close'?{close:true,...(request.sellSymbols?{sellSymbols:request.sellSymbols.filter(s=>s.startsWith('coinbase:')).map(s=>s.slice(9))}:{})}:{withdrawAmount:amount})});
    return {expiresAt:r.expiresAt,leg:{...account,reference:r.id,evidence:'provider-review',amount,cashRows:r.closeCash,cashReturned:r.closeCash?.filter(c=>c.asset===r.quote).reduce((n,c)=>n+Number(c.quantity),0).toString()??'0',estimatedProceeds:decimal(units(r.withdrawal?.estimatedProceeds??'0',36)+(r.closeCash??[]).filter(c=>c.asset===r.quote).reduce((n,c)=>n+units(c.quantity,36),0n),36),orders:request.kind==='close'?(r.closePositions??[]).map(p=>({symbol:p.symbol,quantity:p.quantity,notional:p.value,sellable:p.sellable,selected:r.orders.some(o=>o.product===`${p.symbol}-${r.quote}`)})):r.orders.map(o=>({symbol:o.product.split('-')[0],quantity:o.baseSize,notional:o.notional,sellable:true,selected:true}))}};
   }
   const h=await rh(request.takeId);if(!h)throw Error('Robinhood holdings changed. Preview again.');
   const selected=(s:string)=>request.sellSymbols===undefined||request.sellSymbols.includes(`robinhood:${s}`);
   const preview=request.kind==='reduce'?await instructions.redemptionPreview(h.bucket.id,amount):null;
   if(preview&&!preview.ok)throw Error(`Robinhood’s share (${amount} USD) cannot be withdrawn. Allowed range: ${preview.band.minimumAmount}–${preview.band.maximumAmount} USD. Adjust the whole-Take amount or close it instead.`);
   const sells=request.kind==='close'?h.positions.map(p=>({symbol:p.symbol,quantity:p.quantity,notional:p.value??'0',selected:selected(p.symbol)&&Number(p.value??'0')>=1,sellable:Number(p.value??'0')>=1})):(preview?.legs??[]).map(p=>({symbol:p.symbol,quantity:null,notional:p.notional,selected:true,sellable:true}));
   return {expiresAt:new Date(Date.now()+60000).toISOString(),leg:{...account,reference:h.bucket.id,evidence:evidence(h),amount,cashReturned:request.kind==='close'?h.valuation.cash:'0',estimatedProceeds:request.kind==='close'?decimal(units(h.valuation.cash,36)+sells.filter(s=>s.selected).reduce((n,s)=>n+units(s.notional,36),0n),36):amount,orders:sells}};
  },
  async validate(view){
   await idle(view.takeId);
   for(const leg of view.legs){
    if(leg.venue==='robinhood'){const h=await rh(view.takeId);if(!h||evidence(h)!==leg.evidence)throw Error('Robinhood holdings changed. Preview the whole withdrawal again.');}
    else {const r=await orders.load(leg.reference);if(r.take_id!==view.takeId||r.account_id!==leg.accountId||r.state!=='preview'||r.expires_at.getTime()<=Date.now())throw Error('Coinbase review expired. Preview the whole withdrawal again.');}
   }
  },
  async releaseReview(view,leg){
   if(leg.venue==='coinbase'){
    const r=await execution.view(leg.reference);
    if(r.state==='preview'||r.state==='expired'||r.state==='cancelled')return;
    if(r.state==='confirmed')await orders.cancel(leg.reference); // Prepared-only gate: never cancels a live or uncertain sale.
    else if(r.state!=='settled')throw Error('Wait for Coinbase orders to settle before ending this withdrawal.');
    return;
   }
   await database.use(async db=>{
    const t=(await db.query<{id:string;outcome:string|null;pending_reason:string|null}>("SELECT id,outcome,pending_reason FROM strategy_allocation_transactions WHERE allocation_id=$1 AND idempotency_key=$2",[leg.reference,`${view.kind==='close'?'close':'redeem'}:${leg.operationId}`])).rows[0];
    if(!t)return;
    const open=(await db.query("SELECT 1 FROM strategy_executions WHERE transaction_id=$1 AND status NOT IN ('filled','cancelled','failed')",[t.id])).rows.length;
    if(open||(!t.outcome&&t.pending_reason))throw Error('Robinhood still has an active withdrawal. Resolve its orders before ending this attempt.');
    if(!t.outcome&&view.kind==='reduce'&&!(await db.query("SELECT 1 FROM strategy_attribution_entries WHERE transaction_id=$1 AND entry_type='capital_released'",[t.id])).rows.length)throw Error('Wait for Robinhood proceeds to reconcile before ending this withdrawal.');
   });
  },
  async drive(view,leg){
   if(leg.venue==='coinbase'){
    let r=await execution.view(leg.reference);
    if(r.state==='preview'){await orders.confirm(leg.reference);r=await execution.view(leg.reference);}
    if(r.state==='confirmed')r=r.orders.some(o=>o.execution&&o.execution.state!=='reserved')?await execution.refresh(leg.reference):await execution.submit(leg.reference);
    if(r.state==='settled'&&r.orders.some(o=>o.execution?.state!=='filled'))return {state:'attention',message:'Some Coinbase sells did not fill. End this attempt once orders settle, then review the remaining investment.'};
    if(view.kind==='close'&&r.state==='settled'&&!r.closed)return {state:'pending',message:'Waiting for Coinbase cash and kept holdings to be released.'};
    if(r.state==='settled')return {state:r.orders.every(o=>o.execution?.state==='filled')||!r.orders.length?'completed':'attention',message:r.orders.every(o=>o.execution?.state==='filled')||!r.orders.length?null:'Some Coinbase sells did not fill. Check the account’s order status.'};
    if(r.state==='expired'||r.state==='cancelled')return {state:'attention',message:'Coinbase did not complete this withdrawal. Review its order status.'};
    return {state:'pending',message:'Waiting for Coinbase sales and cash release.'};
   }
   const state=await database.use(async db=>{
    const a=(await db.query<{status:string}>('SELECT status FROM strategy_allocations WHERE id=$1',[leg.reference])).rows[0];
    const t=(await db.query<{id:string;outcome:string|null;pending_reason:string|null}>("SELECT id,outcome,pending_reason FROM strategy_allocation_transactions WHERE allocation_id=$1 AND idempotency_key=$2",[leg.reference,`${view.kind==='close'?'close':'redeem'}:${leg.operationId}`])).rows[0];
    const orders=t?(await db.query<{status:string}>('SELECT status FROM strategy_executions WHERE transaction_id=$1',[t.id])).rows:[];
    const released=t?(await db.query("SELECT 1 FROM strategy_attribution_entries WHERE transaction_id=$1 AND entry_type='capital_released'",[t.id])).rows.length>0:false;
    return {a,t,orders,released};
   });
   if(view.kind==='close'&&state.t)await database.use(db=>db.query("UPDATE strategy_allocation_closures SET status='selling',decided_at=coalesce(decided_at,now()),sell_symbols=$2 WHERE allocation_id=$1 AND status='awaiting'",[leg.reference,JSON.stringify(leg.orders.filter(o=>o.selected).map(o=>o.symbol))]));
   if(view.kind==='close'&&['closed','detached'].includes(state.a?.status??''))return {state:'completed',message:null};
   if(state.released)return {state:state.orders.every(o=>o.status==='filled')?'completed':'attention',message:state.orders.every(o=>o.status==='filled')?null:'Robinhood returned proceeds, but some sells did not fill.'};
   if(!state.t){
    if(view.kind==='close')await instructions.close(leg.reference,leg.orders.filter(o=>o.selected).map(o=>o.symbol),leg.operationId);
    else await instructions.redeem(leg.reference,leg.amount,leg.operationId);
   }else if(state.t.outcome||state.orders.some(o=>['failed','placement_unknown','reconciliation_required','cancelled'].includes(o.status)))return {state:'attention',message:'Robinhood needs attention. Check the orders in this account before continuing.'};
   else if(state.t.pending_reason&&!['requested','market_closed','lots_unsettled','account_stale'].includes(state.t.pending_reason))return {state:'attention',message:`Robinhood is waiting: ${state.t.pending_reason.replaceAll('_',' ')}. Open account management to review.`};
   else if(!state.orders.length&&robinhoodEquitySession.isOpen(Date.now())){
    if(view.kind==='close')await database.use(db=>db.query("UPDATE strategy_allocation_closures SET status='selling',decided_at=coalesce(decided_at,now()),sell_symbols=$2 WHERE allocation_id=$1 AND status='awaiting'",[leg.reference,JSON.stringify(leg.orders.filter(o=>o.selected).map(o=>o.symbol))]));
    await instructions.runInstruction(leg.reference,state.t.id);
   }
   if(robinhoodEquitySession.isOpen(Date.now()))await deps.executor.executeAllocation(leg.reference,{confirmed:true});
   return {state:robinhoodEquitySession.isOpen(Date.now())?'pending':'waiting_market',message:robinhoodEquitySession.isOpen(Date.now())?'Waiting for Robinhood sales and cash release.':'Robinhood will sell at its next trading session.'};
  },
 };
}
