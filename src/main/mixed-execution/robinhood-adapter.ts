import {randomUUID} from 'node:crypto';
import type {Transaction} from '@electric-sql/pglite';
import type {Database,InvestmentDependencies,InvestmentVenueAdapter,Allocation} from './contracts';
import type {MixedExecutionLeg,MixedLegState} from '../../shared/mixed-execution';
import {transactionDatabase} from './transaction';
import {decimalToScaledInteger as units,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
const money=(value:bigint)=>decimal(value,36);
const result=(state:MixedLegState,message:string|null=null)=>({state,message});
import {createAllocationCore} from '../allocations/service';
import {holdings as allocationHoldings} from '../allocations/ledger';
import {observation,measuredCash,claimed} from '../allocations/evidence';
import {deriveAllocationValuation} from '../allocations/allocation-valuation';
import type {NormalizedRobinhoodPosition,NormalizedRobinhoodPortfolio} from '../account-sync/snapshot-normalization';
import {preflightSubscription} from '../execution/preflight';
import {robinhoodEquitySession} from '../trading/session-policy';
export function createRobinhoodInvestmentAdapter(database:Database,deps:Pick<InvestmentDependencies,'clock'|'planner'|'executor'|'checkRobinhood'>):InvestmentVenueAdapter{
 const clock=deps.clock??Date.now;
 async function robinhoodState(leg:MixedExecutionLeg){
  const instruction=await database.use(async db=>(await db.query<{id:string;kind:string;outcome:string|null}>("SELECT id,kind,outcome FROM strategy_allocation_transactions WHERE allocation_id=$1 AND details->>'mixedOperationId'=$2",[leg.reference,leg.operationId])).rows[0]);
  if(!instruction)return result('attention','Robinhood investment instruction is missing.');
  const states=await database.use(async db=>(await db.query<{status:string}>('SELECT status FROM strategy_executions WHERE allocation_id=$1 AND transaction_id=$2',[leg.reference,instruction.id])).rows);
  if(states.length&&states.every(r=>r.status==='filled'))return result('completed');
  if(states.length&&states.every(r=>['filled','cancelled','failed'].includes(r.status)))return result(states.some(r=>r.status==='filled')?'partial':'cancelled','Robinhood orders finished. Holdings and unused cash remain in this Take.');
  if(states.some(r=>['placement_unknown','reconciliation_required'].includes(r.status)))return result('attention','Robinhood orders need reconciliation. Funds remain assigned to this Take.');
  if(!states.length&&instruction.outcome)return result(instruction.outcome==='completed'?'completed':'cancelled');
  if(!robinhoodEquitySession.isOpen(clock()))return result('waiting_market','Waiting for the next Robinhood trading session.');
  if(!states.length){
   const planned=await deps.planner.planAllocation(leg.reference,instruction.kind==='contribution'?'deposit':'activation');
   if(planned.disposition==='failed')return result('attention',planned.reasonCode??'Robinhood could not prepare these orders.');
   if(planned.disposition==='up_to_date')return result('completed');
   if(planned.disposition==='skipped')return result('partial','No further buys met the trading rules. Unused cash remains in this Take.');
   if(!planned.executionIds.length)return result('pending','Checking Robinhood prices and account data.');
  }
  await deps.executor.executeAllocation(leg.reference,{confirmed:true});
  return result('pending','Waiting for Robinhood fills.');
 }
 return {
 async assertIdle(db,strategyId){
  if((await db.query(`SELECT 1 FROM strategy_executions e JOIN strategy_allocations a ON a.id=e.allocation_id WHERE a.strategy_id=$1 AND e.status NOT IN ('filled','cancelled','failed')
   UNION ALL SELECT 1 FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id WHERE a.strategy_id=$1 AND t.outcome IS NULL AND t.pending_reason IS NOT NULL
   UNION ALL SELECT 1 FROM strategy_allocation_closures c JOIN strategy_allocations a ON a.id=c.allocation_id WHERE a.strategy_id=$1 AND c.status IN ('awaiting','selling','failed') LIMIT 1`,[strategyId])).rows.length)throw Error('Wait for existing Robinhood orders and withdrawals to resolve before depositing.');
 },
 async readAccount(db,strategyId,accountId,withBalances){
  if(!(await db.query('SELECT 1 FROM linked_accounts WHERE id=$1 AND agentic_allowed AND selected',[accountId])).rows.length)throw Error('Select the Robinhood trading account in Portfolio.');
  const available:Record<string,string>={};
  if(withBalances){const cash=await measuredCash(db as Transaction,accountId,new Date(clock()).toISOString());const snapshot=await observation<NormalizedRobinhoodPortfolio>(db as Transaction,accountId,'portfolio',new Date(clock()).toISOString());const power=snapshot?.data.buyingPower==null?cash.cash:units(snapshot.data.buyingPower);const spendable=power<cash.cash?power:cash.cash;const claims=await claimed(db as Transaction,accountId,null);const free=spendable-claims.reduce((n,c)=>n+units(c.quantity),0n);if(free<0n)throw Error('Resolve Robinhood cash allocations before investing.');available.USD=decimal(free);}
  const allocation=(await db.query<Allocation>("SELECT id,account_id,accepted_version_id AS version_id,status,restore_required FROM strategy_allocations WHERE strategy_id=$1 AND status IN ('active','paused','diverged')",[strategyId])).rows[0];
  return {allocation,available,claims:allocation?await allocationHoldings(db as Transaction,allocation.id):null};
 },
 async reserve(tx,p,leg,c){
  const funding=p.legs.find(l=>l.venue===leg.venue)!;
  const scoped=transactionDatabase(tx),existing=c.allocations[leg.venue],allocationId=existing?.id??randomUUID();
   const core=createAllocationCore(scoped,clock);
   const invested=await (existing?core.addCapital:core.invest)({allocationId,accountId:leg.accountId,strategyId:c.strategyId,versionId:p.versionId,amount:funding.quantity,cause:`mixed:${leg.operationId}`});
   await tx.query('UPDATE strategy_allocations SET allocation_value=coalesce(allocation_value,0)+$2::numeric,activated_at=coalesce(activated_at,now()) WHERE id=$1',[allocationId,funding.quantity]);
   await tx.query("UPDATE strategy_allocation_transactions SET pending_reason='mixed_funded',details=details||$2::jsonb WHERE id=$1",[invested.transactionId,JSON.stringify({requestedAmountUsd:funding.quantity,mixedOperationId:leg.operationId})]);
   return allocationId;
 },
 async preview(leg,c,common){
  const available=common.available;
    await deps.checkRobinhood(leg.accountId,leg.weights.map(w=>w.instrument.symbol));
    const held=await database.use(async db=>{const a=c.allocations.robinhood;if(!a)return {cash:'0',values:undefined};const h=await allocationHoldings(db as unknown as Transaction,a.id);const snapshot=await observation<NormalizedRobinhoodPosition[]>(db as unknown as Transaction,a.account_id,'equity_positions',new Date(clock()).toISOString());const v=deriveAllocationValuation({cashUsd:h.cash,positions:h.positions.map(p=>({symbol:p.instrumentRef,quantity:p.quantity})),snapshot:(snapshot?.data??[]).map(p=>({...p,symbol:p.instrumentRef}))});if(!v.ready)throw Error('Refresh Robinhood prices before previewing this deposit.');const values:Record<string,string>={};for(const p of h.positions){const value=v.positions.get(p.instrumentRef);if(p.symbol&&value)values[p.symbol]=value.valueUsd;}return {cash:h.cash,values};});
    const budget=money(units(leg.quantity,36)+units(held.cash,36));
    const p=preflightSubscription({amountUsd:budget,currentValuesUsd:held.values,weights:leg.sleeve.target.weights.map(w=>({symbol:w.instrument.symbol,weightPercent:w.bps/100})),cashPercent:leg.sleeve.target.cashBps/100,modelValuedOn:null,expectedValuedOn:null,instrumentPolicy:null,blockedSymbols:c.blocked,availableCashUsd:money(units(available,36)+units(held.cash,36))});
    // Orders are sized to cents; retain the full ledger remainder, including
    // sub-cent cash left by fractional fills and order-sizing rounding.
    return {...common,existingCash:held.cash,state:!p.ok?'blocked':robinhoodEquitySession.isOpen(clock())?'ready':'waiting_market',reason:!p.ok?`Robinhood: ${p.reasons.map(r=>r.code.replaceAll('_',' ')).join(', ')}`:null,orders:p.legs.map(l=>({symbol:l.symbol,side:'buy' as const,notional:l.notionalUsd,fee:'0'})),retainedCash:money(units(budget,36)-p.legs.reduce((total,l)=>total+units(l.notionalUsd,36),0n))};
 },
 dispatch:leg=>robinhoodState(leg),reconcile:leg=>robinhoodState(leg),
 };
}
