import {randomUUID} from 'node:crypto';
import type {Database,InvestmentDependencies,InvestmentVenueAdapter,Allocation} from './contracts';
import type {MixedExecutionLeg,MixedLegState} from '../../shared/mixed-execution';
import {transactionDatabase} from './transaction';
import {decimalToScaledInteger as units,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
const money=(value:bigint)=>decimal(value,36);
const result=(state:MixedLegState,message:string|null=null)=>({state,message});
import {createCoinbaseAllocations,readCoinbaseFundingRoom} from '../coinbase/allocations';
export function createCoinbaseInvestmentAdapter(database:Database,deps:Pick<InvestmentDependencies,'clock'|'coinbaseOrders'|'coinbaseInvestments'>):InvestmentVenueAdapter{
 const clock=deps.clock??Date.now;
 async function coinbaseState(leg:MixedExecutionLeg,dispatch=false){
  const stage=await database.use(async db=>(await db.query<{state:string}>('SELECT state FROM coinbase_investments WHERE id=$1',[leg.reference])).rows[0]?.state);
  const view=dispatch||stage==='funded'||stage==='ready'?await deps.coinbaseInvestments.continue(leg.reference,true):await deps.coinbaseInvestments.refresh(leg.reference);
  if(view.review?.state==='settled')return view.review.orders.every(o=>o.execution?.state==='filled')?result('completed'):result('partial','Some Coinbase orders did not fill. Holdings and unused cash remain in this Take.');
  if(view.state==='cancelled')return result('cancelled','Coinbase investment cancelled. Unused cash remains in this Take.');
  if(view.error)return result('attention',view.error);
  if(view.state==='funded'||view.state==='ready')return result('attention','Coinbase has not submitted all orders. Review this account before continuing.');
  return result('pending','Waiting for Coinbase fills.');
 }
 return {
 async assertIdle(db,strategyId){
  if((await db.query(`SELECT 1 FROM coinbase_allocation_orders o JOIN coinbase_allocations a ON a.id=o.allocation_id WHERE a.strategy_id=$1 AND o.state<>'closed'
   UNION ALL SELECT 1 FROM coinbase_investments i JOIN takes t ON t.id=i.take_id WHERE t.strategy_id=$1 AND i.state IN ('started','funded','ready') LIMIT 1`,[strategyId])).rows.length)throw Error('Wait for existing Coinbase orders and withdrawals to resolve before depositing.');
 },
 async readAccount(db,strategyId,accountId,withBalances){
  if(!(await db.query('SELECT 1 FROM linked_accounts a JOIN coinbase_connection_details d ON d.connection_id=a.connection_id WHERE a.id=$1 AND d.can_trade',[accountId])).rows.length)throw Error('Choose a Coinbase account with trading permission.');
  const available:Record<string,string>={};
  if(withBalances){const room=await readCoinbaseFundingRoom(db,accountId,clock);if(room.some(r=>r.state!=='reconciled'))throw Error('Resolve Coinbase balance differences before investing.');for(const r of room)if(r.unclaimed!==null&&['USD','USDC'].includes(r.asset))available[r.asset]=r.unclaimed;}
  const allocation=(await db.query<Allocation>('SELECT id,account_id,version_id,status,restore_required FROM coinbase_allocations WHERE strategy_id=$1',[strategyId])).rows[0];
  const claims=allocation?(await db.query('SELECT asset,sum(quantity)::text AS quantity FROM coinbase_allocation_entries WHERE allocation_id=$1 GROUP BY asset ORDER BY asset',[allocation.id])).rows:[];
  return {allocation,available,claims};
 },
 async reserve(tx,p,leg,c){
  const funding=p.legs.find(l=>l.venue===leg.venue)!;
  const scoped=transactionDatabase(tx),existing=c.allocations[leg.venue],allocationId=existing?.id??randomUUID();
    const capitalId=randomUUID(),fundingInput={accountId:leg.accountId,allocationId,strategyId:c.strategyId,versionId:p.versionId,asset:funding.currency,quantity:funding.quantity,cause:`member:${capitalId}`};
    const labels=(await tx.query<{account_label:string;take_title:string}>(`SELECT coalesce(d.label,a.nickname,a.masked_number) AS account_label,t.title AS take_title FROM linked_accounts a JOIN coinbase_connection_details d ON d.connection_id=a.connection_id CROSS JOIN takes t WHERE a.id=$1 AND t.id=$2`,[leg.accountId,p.takeId])).rows[0];
    await tx.query("INSERT INTO coinbase_capital_reviews(id,take_id,account_id,kind,input,account_label,take_title,state,created_at,expires_at) VALUES($1,$2,$3,'assign',$4,$5,$6,'confirmed',$7,$8)",[capitalId,p.takeId,leg.accountId,JSON.stringify(fundingInput),labels.account_label,labels.take_title,new Date(clock()).toISOString(),p.expiresAt]);
    await createCoinbaseAllocations(scoped,clock).fund(fundingInput);
    const request={operationId:leg.operationId,takeId:p.takeId,accountId:leg.accountId,asset:funding.currency,quantity:funding.quantity};
    await tx.query("INSERT INTO coinbase_investments(id,take_id,account_id,request,capital_review_id,state,created_at) VALUES($1,$2,$3,$4,$5,'funded',$6)",[leg.operationId,p.takeId,leg.accountId,JSON.stringify(request),capitalId,new Date(clock()).toISOString()]);
    return leg.operationId;
 },
 async preview(leg,c,common){
  const available=common.available;
     const review=await deps.coinbaseOrders.preview({takeId:c.takeId,quote:leg.currency},{accountId:leg.accountId,allocationId:c.allocations.coinbase?.id??randomUUID(),quantity:leg.quantity});
     const cost=review.orders.reduce((n,o)=>n+units(o.notional,36)+units(o.fee,36),0n);
     const existingCash=await database.use(async db=>{const a=c.allocations.coinbase;if(!a)return '0';return (await db.query<{value:string}>('SELECT coalesce(sum(quantity),0)::text AS value FROM coinbase_allocation_entries WHERE allocation_id=$1 AND asset=$2',[a.id,leg.currency])).rows[0].value;});
     const hasPositions=c.allocations.coinbase&&await database.use(async db=>(await db.query("SELECT 1 FROM coinbase_allocation_entries WHERE allocation_id=$1 AND asset NOT IN ('USD','USDC') GROUP BY asset HAVING sum(quantity)>0 LIMIT 1",[c.allocations.coinbase!.id])).rows.length>0);
     const missing=hasPositions?[]:leg.weights.filter(w=>!review.orders.some(o=>o.product===`${w.instrument.symbol}-${leg.currency}`));
     if(missing.length)throw Error('Increase the amount so every Coinbase holding meets its minimum trade size.');
     return {...common,expiresAt:review.expiresAt,state:'ready',reason:null,orders:review.orders.map(o=>({symbol:o.product.split('-')[0],side:'buy' as const,notional:o.notional,fee:o.fee})),existingCash,retainedCash:money(units(leg.quantity,36)+units(existingCash,36)-cost)};
 },
 dispatch:leg=>coinbaseState(leg,true),reconcile:leg=>coinbaseState(leg),
 };
}
