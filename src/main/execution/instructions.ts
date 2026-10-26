import {instrumentKey,type StrategyInstrument} from '../../shared/strategies';
import {basketSessionPolicy,type TradingSessionPolicy} from '../trading/session-policy';
import {cryptoSizingPolicy} from '../planning/crypto-sizing-policy';
import {hasCryptoAccessDenial,cryptoInstrumentFromRef} from '../orders/crypto-take-identity';
import {pendingInvestmentReason} from '../../shared/investment-status';
import {executionBasket} from '../mixed-execution/basket';
import type {InstructionOrder} from '../../shared/instruction-order';
import {normalizeOrderState} from '../../shared/trading';
import { assertBasketExecution, type BasketSpec } from '../../shared/strategies';
import {randomUUID} from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
import type {createConnections} from '../connections';
import type {createAllocationCore} from '../allocations/service';
import type {NormalizedRobinhoodPortfolio,NormalizedRobinhoodPosition} from '../account-sync/snapshot-normalization';
import type {Executor,ExecutionOutcome,Planner,PlanOptions,PlanResult,TradingPreferences} from './contracts';
import {allocation as allocationOf,amount,append,format,holdings as holdingsOf,instruction} from '../allocations/ledger';
import {observation} from '../allocations/evidence';
import {deriveAllocationValuation} from '../allocations/allocation-valuation';
import {deriveAllocationPnl} from '../allocations/allocation-pnl';
import {loadAllocationEntries} from '../allocations/allocation-history';
import {planRedemption} from '../allocations/redemption';
import {instructionCancellable,instructionStatus,type InstructionStatus} from '../allocations/allocation-transactions';
import {refreshStatuses,keepReduced as keepReducedCase} from '../allocations/reconciliation';
import {preflightSubscription,type PreflightResult} from './preflight';
import {MINIMUM_ORDER_NOTIONAL_USD} from './limits';
import {createRobinhoodEligibility} from '../trading/robinhood-eligibility';
import {instrumentEligibility} from '../trading/eligibility';
import {easternClock,easternWallTimeToUtc} from '../market-series/sessions';
import {robinhoodEquitySession} from '../trading/session-policy';

// The member's instructions on an allocation. There is no draft status, so "create"
// runs the activation checks and invests in one step and "update active"
// starts its first plan. Instruction kinds keep the local ledger names
// (investment, contribution, redemption, exit) and are shown as
// subscription, contribution, partial_redemption and full_exit, which is
// what the panel reads. Every write that needs orders plans, then
// executes, through the injected Planner and Executor.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Query=Pick<PGlite,'query'>;
export class InstructionConflict extends Error {constructor(message:string,readonly code:string|null=null){super(message);}}
export class InstructionNotFound extends Error {}

/** The leg states that mean an order is still in flight. */
export const OPEN_EXECUTION_STATES=['queued','reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required'] as const;
const SENT_STATES=OPEN_EXECUTION_STATES.filter(state=>state!=='queued');
const OPEN_SQL=`(${OPEN_EXECUTION_STATES.map(s=>`'${s}'`).join(',')})`;
const SENT_SQL=`(${SENT_STATES.map(s=>`'${s}'`).join(',')})`;
const AWAITING_CONFIRMATION='awaiting_confirmation';
const MARKET_CLOSED='market_closed';
/** Instruction kinds as the panel reads them, from the local ledger kinds. */
const VIEW_KIND:Record<string,string>={investment:'subscription',contribution:'contribution',redemption:'partial_redemption',exit:'full_exit'};
const LOCAL_KINDS=Object.keys(VIEW_KIND);
const CANCELLABLE=['redemption','contribution','investment'];
const MONEY=['contribution','investment'];
/** Planning reasons the panel explains as a wait. */
const WAITING_REASONS=new Set(['lots_unsettled','retry_backoff','correction_not_improving','model_stale','fresh_position_snapshot_required',
 'incomplete_basket','insufficient_buying_power','symbol_not_tradable','daily_notional_limit',MARKET_CLOSED,AWAITING_CONFIRMATION,'symbol_blocked']);
const SELF_CLEARING=new Set(['requested','lots_unsettled','market_closed','open_execution','fresh_position_snapshot_required','missing_mark_price','attributed_lots_unavailable','model_stale','crypto_sizing_evidence_required','daily_notional_limit','enqueued','deferred']);
const DOLLARS=/^\d+(\.\d{1,2})?$/u;

export type SellChoice='none'|'all'|string[];
/** A write's answer, in the shape the strategy panel reads. */
export type AuthorResult={ok:true;status:number;body:unknown}|{ok:false;status:number;message:string;code:string|null};

/** Turns a thrown instruction error into the panel's result envelope. */
export async function authorResult(work:()=>Promise<unknown>):Promise<AuthorResult>{
 try{return {ok:true,status:200,body:await work()};}
 catch(error){
  if(error instanceof InstructionConflict)return {ok:false,status:409,message:error.message,code:error.code};
  if(error instanceof InstructionNotFound)return {ok:false,status:404,message:error.message,code:null};
  return {ok:false,status:500,message:error instanceof Error?error.message.slice(0,500):'Strategy action failed.',code:null};
 }
}

export interface InstructionView {
 orders?:InstructionOrder[];
 id:string;kind:string;requestedAmount:string|null;status:InstructionStatus;pendingReason:string|null;waitingFor:string|null;
 symbols:string[];expectedAt:string|null;cancellable:boolean;previewLegs:{symbol:string;notional:string}[];outcomeCode:string|null;createdAt:string;
}

/** When a waiting instruction should run by itself. */
export function expectedRunAt(pendingReason:string|null,nowMs:number,session:TradingSessionPolicy=robinhoodEquitySession):string|null{
 if(pendingReason===MARKET_CLOSED)return session.isOpen(nowMs)?null:new Date(session.nextOpen(nowMs)).toISOString();
 if(pendingReason==='lots_unsettled'){
  const endOfToday=easternWallTimeToUtc(easternClock(nowMs).date,24*60);
  return new Date(robinhoodEquitySession.nextOpen(endOfToday+1_000)).toISOString();
 }
 return null;
}

/** Whether an allocation holds what its strategy holds. */
export function replicationState(input:{targetSymbols:readonly string[];heldSymbols:readonly string[];inFlightSymbols:readonly string[];skippedSymbols:readonly string[];everSynchronized:boolean}):{state:'initializing'|'synchronized'|'constrained'|'replication_limited';missingSymbols:string[]}{
 const held=new Set(input.heldSymbols),inFlight=new Set(input.inFlightSymbols),skipped=new Set(input.skippedSymbols);
 const missing=input.targetSymbols.filter(symbol=>!held.has(symbol)).sort();
 if(missing.length===0)return {state:'synchronized',missingSymbols:[]};
 if(missing.some(s=>inFlight.has(s))||!input.everSynchronized){
  if(missing.every(s=>inFlight.has(s)||skipped.has(s))||missing.some(s=>inFlight.has(s)))return {state:'initializing',missingSymbols:missing};
 }
 if(missing.every(s=>skipped.has(s)))return {state:'constrained',missingSymbols:missing};
 return {state:'replication_limited',missingSymbols:missing};
}

interface AllocationRow {id:string;account_id:string;strategy_id:string;applied_version_id:string;status:string;restore_required:boolean;allocation_value:string|null;
 planning_reason_code:string|null;planning_deferred_until:Date|null;orders_confirmed_at:Date|null;activated_at:Date|null;created_at:Date;applied_version_sequence:number}
interface Targets {instruments:StrategyInstrument[];versionId:string;sequence:number;weights:{symbol:string;instrumentRef:string;weightPercent:number}[];cashPercent:number;title:string;description:string|null;committed:boolean;archived:boolean}

export function createAllocationInstructions(database:Database,deps:{
 core:Pick<ReturnType<typeof createAllocationCore>,'invest'>;
 planner:Planner;
 executor:Executor;
 /** Live tradability at activation; fails closed when absent. */
 connections?:Pick<ReturnType<typeof createConnections>,'status'|'readTool'>;
 readEligibility?:ReturnType<typeof createRobinhoodEligibility>;
 clock?:()=>number;
}){
 const clock=deps.clock??(()=>Date.now());
 const readEligibility=deps.readEligibility??(deps.connections?createRobinhoodEligibility(deps.connections):undefined);
 const iso=()=>new Date(clock()).toISOString();
 const atomic=<T>(work:(tx:Transaction,now:string)=>Promise<T>)=>database.use(db=>db.transaction(tx=>work(tx,iso())));

 async function row(db:Query,allocationId:string):Promise<AllocationRow>{
  const found=(await db.query<AllocationRow>(`SELECT id,account_id,strategy_id,applied_version_id,status,restore_required,allocation_value::text,planning_reason_code,planning_deferred_until,
   orders_confirmed_at,activated_at,created_at,applied_version_sequence FROM strategy_allocations WHERE id=$1`,[allocationId])).rows[0];
  if(!found)throw new InstructionNotFound('Take allocation not found');
  return found;
 }
 /** The strategy's committed version (its published allocation), as weights in percent. */
 async function targets(db:Query,strategyId:string,allocationId?:string):Promise<Targets|null>{
  const r=(await db.query<{status:string;archived_at:Date|null;version_id:string|null;sequence:number|null;spec:BasketSpec|null;metadata:{title?:string;description?:string}|null}>(
   `SELECT s.status,s.archived_at,v.id AS version_id,v.sequence,v.spec,v.metadata FROM strategies s LEFT JOIN strategy_versions v ON v.id=coalesce((SELECT accepted_version_id FROM strategy_allocations WHERE id=$2),s.current_version_id) WHERE s.id=$1`,[strategyId,allocationId??null])).rows[0];
  if(!r||r.version_id===null||r.spec===null)return null;
  if(allocationId){const a=await row(db,allocationId);r.spec=await executionBasket(db,r.spec,{strategyId,versionId:r.version_id,accountId:a.account_id},'robinhood');}
  assertBasketExecution(r.spec);
  return {instruments:r.spec.target.weights.map(w=>w.instrument),versionId:r.version_id,sequence:r.sequence??0,weights:r.spec.target.weights.map(w=>({symbol:w.instrument.symbol.toUpperCase(),instrumentRef:instrumentKey(w.instrument),weightPercent:w.bps/100})),
   cashPercent:r.spec.target.cashBps/100,title:r.metadata?.title??'Take',description:r.metadata?.description||null,committed:r.status==='committed',archived:r.archived_at!==null};
 }
 async function preferences(db:Query):Promise<TradingPreferences>{
  const r=(await db.query<{confirm_trades:boolean;blocked_symbols:string[]}>(`SELECT p.confirm_trades,p.blocked_symbols FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1`)).rows[0];
  return {confirmTrades:r?.confirm_trades??false,blockedSymbols:r?.blocked_symbols??[]};
 }
 /** The allocation's holdings marked from the latest positions snapshot. */
 async function valued(db:Query,a:AllocationRow){
  const h=await holdingsOf(db as Transaction,a.id);
  const snap=await observation<NormalizedRobinhoodPosition[]>(db as Transaction,a.account_id,'equity_positions');
  const crypto=h.positions.some(p=>cryptoInstrumentFromRef(p.instrumentRef,p.symbol??'')!==null);
  const cryptoSnap=crypto?await observation<NormalizedRobinhoodPosition[]>(db as Transaction,a.account_id,'crypto_positions'):null;
  const cryptoPositions=(cryptoSnap?.data??[]).map(p=>{const time=Date.parse(p.priceObservedAt??'');return {...p,marketValue:null,markPrice:Number.isFinite(time)&&time<=clock()&&clock()-time<=60000?p.markPrice:null};});
  const valuation=deriveAllocationValuation({cashUsd:h.cash,positions:h.positions.map(p=>({symbol:p.symbol??p.instrumentRef,instrumentRef:p.instrumentRef,quantity:p.quantity})),
   snapshot:[...(snap?.data??[]),...cryptoPositions]});
  let cryptoMinimum: string|null='1';
  for(const held of h.positions){
   if(amount(held.quantity)<=0n||!cryptoInstrumentFromRef(held.instrumentRef,held.symbol??''))continue;
   const matches=cryptoPositions.filter(p=>p.instrumentRef===held.instrumentRef);
   const p=matches.length===1?matches[0]:null;
   const policy=p?.markPrice?cryptoSizingPolicy(p.providerPayload?.cryptoSizing,p.markPrice):null;
   if(!policy){cryptoMinimum=null;break;}
   if(amount(policy.minimumOrderNotionalUsd)>amount(cryptoMinimum))cryptoMinimum=policy.minimumOrderNotionalUsd;
  }
  return {holdings:h,valuation,cryptoMinimum,observedAt:(crypto?cryptoSnap:snap)?.observedAt??null};
 }
 /** Free account cash after what every strategy holds, and the account's room. */
 async function accountRoom(db:Query,accountId:string,excluding?:string){
  const portfolio=await observation<NormalizedRobinhoodPortfolio>(db as Transaction,accountId,'portfolio');
  const allocated=(await db.query<{v:string}>(`SELECT coalesce(sum(allocation_value),0)::text AS v FROM strategy_allocations WHERE account_id=$1 AND status IN ('active','paused','diverged') AND ($2::uuid IS NULL OR id<>$2)`,[accountId,excluding??null])).rows[0]!.v;
  const reserved=(await db.query<{v:string}>(`SELECT coalesce(sum(e.cash_delta),0)::text AS v FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
   WHERE a.account_id=$1 AND a.status IN ('active','paused','diverged')`,[accountId])).rows[0]!.v;
  const uninvested=portfolio?.data.buyingPower??portfolio?.data.cash??null;
  const reservedClaim=amount(reserved)>0n?amount(reserved):0n;
  return {
   portfolio,
   allocated:amount(allocated),
   freeCash:uninvested===null?null:amount(uninvested)-reservedClaim,
   room:portfolio?.data.totalValue==null?null:amount(portfolio.data.totalValue)-amount(allocated),
  };
 }
 const usd=(value:bigint)=>format(value>0n?value:0n);
 const cents=(value:bigint)=>(Math.floor(Number(usd(value))*100)/100).toFixed(2);

 async function preflightFor(db:Query,input:{strategyId:string;amount:string;kind:'subscription'|'contribution';allocationId?:string;accountId:string|null}){
  const t=await targets(db,input.strategyId,input.allocationId);
  if(!t)throw new InstructionNotFound('Take not found');
  if(deps.planner.preflight&&input.accountId)return {t,result:await deps.planner.preflight({accountId:input.accountId,amount:input.amount,strategyId:input.strategyId,allocationId:input.allocationId},db)};
  const prefs=await preferences(db);
  let currentValuesUsd:Record<string,string>|undefined;
  if(input.allocationId!==undefined){
   const a=await row(db,input.allocationId);const v=await valued(db,a);
   currentValuesUsd={};
   if(!v.valuation.ready)throw new InstructionConflict('Refresh holdings before previewing a deposit.','fresh_position_snapshot_required');
   for(const p of v.holdings.positions){
    const value=v.valuation.positions.get(p.instrumentRef);if(!value||!p.symbol)continue;
    const key=cryptoInstrumentFromRef(p.instrumentRef,p.symbol)?p.instrumentRef:instrumentKey({venue:'robinhood',symbol:p.symbol.toUpperCase()});
    currentValuesUsd[key]=format(amount(currentValuesUsd[key]??'0')+amount(value.valueUsd));
   }
  }
  const room=input.accountId===null?null:await accountRoom(db,input.accountId,input.allocationId);
  const result=preflightSubscription({amountUsd:input.amount,weights:t.weights,cashPercent:t.cashPercent,modelValuedOn:null,expectedValuedOn:null,instrumentPolicy:null,
   blockedSymbols:prefs.blockedSymbols,...(currentValuesUsd?{currentValuesUsd}:{}),
   ...(room===null?{}:{availableCashUsd:room.freeCash===null?null:usd(room.freeCash),accountRoomUsd:room.room===null?null:usd(room.room)})});
  return {t,result};
 }
 const requestedInstruments=(t:Targets,result:PreflightResult)=>t.instruments.filter(i=>result.legs.some(l=>l.instrumentRef?l.instrumentRef===instrumentKey(i):l.symbol===i.symbol));
 const preflightView=(kind:'subscription'|'contribution',amountUsd:string,result:PreflightResult,t:Targets)=>({
  ok:result.ok,kind,amount:amountUsd,legs:result.legs.map(l=>{const i=t.instruments.find(i=>instrumentKey(i)===l.instrumentRef);return {symbol:l.symbol,instrumentRef:l.instrumentRef,venue:i?.venue,assetClass:i?.market?.kind??'equity',weightPercent:l.weightPercent,notional:l.notionalUsd};}),
  retainedCash:result.retainedCashUsd,orderReserveUsd:result.orderReserveUsd,existingCashUsed:result.existingCashUsed,minimumAmount:result.minimumAllocationUsd,reasons:result.reasons,modelValuedOn:null,expectedValuedOn:null});

 /** Live tradability, failing closed: an unanswered symbol is unverified, not allowed. */
 async function checkTradability(accountId:string,symbols:string[],instruments:readonly StrategyInstrument[]=[]){
  const unavailable=()=>new InstructionConflict('This investment could not be checked with Robinhood just now. Try again in a moment.','tradability_check_unavailable');
  if(!readEligibility||symbols.length===0){if(symbols.length===0)return;throw unavailable();}
  if(instruments.some(i=>i.market&&symbols.includes(i.symbol))&&await database.use(db=>hasCryptoAccessDenial(db,accountId)))throw new InstructionConflict('Robinhood previously denied crypto access for this account. Resolve its trading restriction before investing.','crypto_account_restricted');
  if(instruments.length&&symbols.some(symbol=>!instruments.some(i=>i.symbol===symbol)))throw unavailable();
  const facts:{symbol:string;tradable:boolean|null;fractional:boolean|null}[]=[];
  try{
   facts.push(...await readEligibility(accountId,symbols,AbortSignal.timeout(60_000),instruments));
  }catch{throw unavailable();}
  const requested=instruments.length?instruments.filter(i=>symbols.includes(i.symbol)).map(i=>({key:i.market?instrumentKey(i):i.symbol,symbol:i.symbol,crypto:!!i.market})):symbols.map(symbol=>({key:symbol,symbol,crypto:false}));
  const decisions=requested.map(i=>instrumentEligibility({...facts.find(f=>f.symbol===i.key)??{tradable:null,fractional:null},symbol:i.symbol},!i.crypto));
  const affected=(code:'eligibility_unknown'|'symbol_not_tradable'|'symbol_not_fractional')=>[...new Set(decisions.flatMap(d=>d.reasons.filter(r=>r.code===code).flatMap(r=>r.symbols)))].sort();
  const unanswered=affected('eligibility_unknown');
  if(unanswered.length)throw new InstructionConflict(`Robinhood did not answer for ${unanswered.join(', ')}, so this investment could not be checked. Try again in a moment.`,'tradability_check_unavailable');
  const notTradable=affected('symbol_not_tradable');
  if(notTradable.length)throw new InstructionConflict(`${notTradable.join(', ')} cannot be traded in this account right now, so this take cannot be bought complete. Try again later.`,'symbol_not_tradable');
  const whole=affected('symbol_not_fractional');
  if(whole.length)throw new InstructionConflict(`${whole.join(', ')} can only be bought in whole shares in this account, so a share of it cannot be bought for you.`,'symbol_not_fractional');
 }
 const blockedError=(symbols:string[])=>new InstructionConflict(`This take holds ${symbols.join(', ')}, which you blocked. Unblock it in your trading preferences to invest.`,'symbol_blocked');

 async function returnPreparationCash(allocationId:string,instructionId:string){
  try{await cancelInstruction(allocationId,instructionId,true);}
  catch(error){throw new InstructionConflict('The investment stopped, but its order outcome needs checking. Cash remains set aside until it is resolved.','investment_recovery_required');}
 }

 /** Plans, then sends what is due: every write that needs orders ends here. */
 /** `confirmed`: the member already approved these orders (a rule trade's review). */
 async function planAndExecute(allocationId:string,trigger:Parameters<Planner['planAllocation']>[1],confirmed=false,options?:PlanOptions):Promise<{plan:PlanResult;delegated:ExecutionOutcome|null}>{
  const plan=await deps.planner.planAllocation(allocationId,trigger,options);
  const delegated=plan.disposition==='planned'?await deps.executor.executeAllocation(allocationId,confirmed?{confirmed:true}:undefined):null;
  return {plan,delegated};
 }

 /** A close names no amount: its sells, valued at stored quotes, are what it is selling. */
 async function closingValue(db:Query,instructionId:string):Promise<string|null>{
  const v=(await db.query<{v:string|null}>(`SELECT sum((l.order_request->>'quantity')::numeric*q.price)::text AS v FROM strategy_executions l
   JOIN market_quotes q ON q.symbol=upper(l.symbol) WHERE l.transaction_id=$1 AND l.side='sell' AND l.status NOT IN ('cancelled','failed') AND l.order_request ? 'quantity'`,[instructionId])).rows[0]?.v;
  return v===null||v===undefined?null:Number(v).toFixed(2);
 }

 // ---- Instructions as the member sees them ----
 async function readInstruction(db:Query,allocationId:string,instructionId:string):Promise<InstructionView>{
  const r=(await db.query<{id:string;kind:string;requested_amount:string|null;pending_reason:string|null;outcome:'cancelled'|'superseded'|'failed'|null;outcome_code:string|null;details:Record<string,unknown>;created_at:Date}>(
   `SELECT id,kind,requested_amount::text,pending_reason,outcome,outcome_code,details,created_at FROM strategy_allocation_transactions WHERE id=$1 AND allocation_id=$2`,[instructionId,allocationId])).rows[0];
  if(!r)throw new InstructionNotFound('Instruction not found');
  const a=await row(db,allocationId);
  const legs=(await db.query<{status:string;symbol:string;side:'buy'|'sell';created_at:Date}>(`SELECT status,symbol,side,created_at FROM strategy_executions WHERE transaction_id=$1 ORDER BY created_at,id`,[instructionId])).rows;
  const status=instructionStatus({outcome:r.outcome,pendingReason:r.pending_reason,legs});
  const queuedOnly=legs.length>0&&legs.every(l=>['queued','cancelled','failed'].includes(l.status));
  const specs=(await db.query<{spec:BasketSpec|null}>(`SELECT v.spec FROM strategy_versions v WHERE v.id IN (
   SELECT coalesce(l.version_id,a.accepted_version_id) FROM strategy_executions l JOIN strategy_allocations a ON a.id=l.allocation_id WHERE l.transaction_id=$1
   UNION ALL SELECT accepted_version_id FROM strategy_allocations WHERE id=$2 AND NOT EXISTS(SELECT 1 FROM strategy_executions WHERE transaction_id=$1))`,[instructionId,allocationId])).rows;
  const session=specs.length&&specs.every(r=>basketSessionPolicy(r.spec).calendar==='continuous')?basketSessionPolicy(specs[0].spec):robinhoodEquitySession;
  const marketShut=!session.isOpen(clock());
  const heldForMember=status==='open'&&queuedOnly&&legs.some(l=>l.status==='queued'&&(a.orders_confirmed_at===null||new Date(l.created_at).getTime()>new Date(a.orders_confirmed_at).getTime()))
   &&(await preferences(db)).confirmTrades;
  const pendingReason=r.pending_reason===MARKET_CLOSED&&!marketShut?'requested':r.pending_reason;
  const waitingFor=status==='pending'?pendingInvestmentReason(pendingReason,marketShut):heldForMember?AWAITING_CONFIRMATION:status==='open'&&queuedOnly&&marketShut?MARKET_CLOSED:null;
  const sending=MONEY.includes(r.kind)&&status!=='cancelled'&&status!=='superseded'
   ?(await db.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ${SENT_SQL} LIMIT 1`,[allocationId])).rows.length>0:false;
  const preview=Array.isArray((r.details.preview as {legs?:unknown}|undefined)?.legs)?((r.details.preview as {legs:{symbol?:unknown;notional?:unknown}[]}).legs).flatMap(l=>typeof l.symbol==='string'&&typeof l.notional==='string'?[{symbol:l.symbol,notional:l.notional}]:[]):[];
  const queued=legs.filter(l=>l.status==='queued');
  return {
   id:r.id,kind:VIEW_KIND[r.kind]??r.kind,requestedAmount:r.requested_amount!==null?format(amount(r.requested_amount)):r.kind==='exit'?await closingValue(db,instructionId):null,status,
   pendingReason:status==='pending'?pendingReason:null,waitingFor,
   symbols:queued.length?[...new Set(queued.map(l=>l.symbol))].sort():Array.isArray(r.details.sellSymbols)?(r.details.sellSymbols as unknown[]).filter((s):s is string=>typeof s==='string').sort():[],
   expectedAt:expectedRunAt(waitingFor,clock(),session),
   cancellable:CANCELLABLE.includes(r.kind)&&instructionCancellable(status,legs)&&!sending,
   orders:legs.map(leg=>({symbol:leg.symbol,side:leg.side,execution:{state:normalizeOrderState(leg.status==='submitted'?'accepted':leg.status==='queued'?'reviewed':leg.status),cancelState:'none'}})),
   previewLegs:preview,outcomeCode:r.outcome_code,createdAt:new Date(r.created_at).toISOString(),
  };
 }
 async function liveInstructions(db:Query,allocationId:string):Promise<InstructionView[]>{
  const rows=(await db.query<{id:string}>(`SELECT t.id FROM strategy_allocation_transactions t WHERE t.allocation_id=$1 AND t.kind=ANY($2) AND t.outcome IS NULL
   AND (t.pending_reason IS NOT NULL OR EXISTS(SELECT 1 FROM strategy_executions l WHERE l.transaction_id=t.id AND l.status IN ${OPEN_SQL}))
   ORDER BY t.created_at DESC LIMIT 10`,[allocationId,LOCAL_KINDS])).rows;
  const views:InstructionView[]=[];for(const r of rows)views.push(await readInstruction(db,allocationId,r.id));
  return views;
 }
 async function setDetails(tx:Transaction,instructionId:string,details:Record<string,unknown>,now:string){
  await tx.query(`UPDATE strategy_allocation_transactions SET details=details||$2::jsonb,updated_at=$3 WHERE id=$1`,[instructionId,JSON.stringify(details),now]);
 }

 /** Release: every claim becomes the member's own; nothing is sold. */
 async function release(tx:Transaction,allocationId:string,reason:'stop_following'|'close_hold'|'close_sold',now:string){
  const a=await allocationOf(tx,allocationId);
  if(!['active','paused','diverged'].includes(a.status))throw new InstructionConflict('This investment is not following a take','bucket_not_following');
  if((await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ${SENT_SQL} LIMIT 1`,[allocationId])).rows.length)
   throw new InstructionConflict('Wait for the in-flight order to settle before stopping','bucket_has_open_execution');
  if(reason==='close_sold'){
   const wanted=(await tx.query<{sell_symbols:string[]}>(`SELECT sell_symbols FROM strategy_allocation_closures WHERE allocation_id=$1`,[allocationId])).rows[0]?.sell_symbols??[];
   const remaining=(await holdingsOf(tx,allocationId)).positions.some(p=>amount(p.quantity)>0n&&cryptoInstrumentFromRef(p.instrumentRef,p.symbol??'')!==null&&wanted.some(key=>key===p.instrumentRef||key.toUpperCase()===p.symbol?.toUpperCase()));
   if(remaining)throw new InstructionConflict('Crypto units remain in this Take. Review the remaining holdings before closing.','crypto_units_remaining');
  }
  await tx.query(`UPDATE strategy_executions SET status='cancelled',failure_code='detached',terminal_at=$2,updated_at=$2 WHERE allocation_id=$1 AND status='queued'`,[allocationId,now]);
  const transactionId=await instruction(tx,{allocationId,kind:'detachment',cause:`release:${reason}:${now}`},now);
  const h=await holdingsOf(tx,allocationId);
  for(const p of h.positions){if(amount(p.quantity)===0n)continue;
   await append(tx,{allocationId,transactionId,entryType:'detachment',instrumentRef:p.instrumentRef,assetClass:cryptoInstrumentFromRef(p.instrumentRef,p.symbol??'')?'crypto':'equity',symbol:p.symbol,quantityDelta:format(-amount(p.quantity)),cause:`release:${reason}:${now}:${p.instrumentRef}`,sourceKind:'member_instruction',sourceRef:transactionId,occurredAt:now,metadata:{reason}},now);}
  if(amount(h.cash)!==0n)await append(tx,{allocationId,transactionId,entryType:'capital_released',cashDelta:format(-amount(h.cash)),cause:`release:${reason}:${now}:cash`,sourceKind:'member_instruction',sourceRef:transactionId,occurredAt:now,metadata:{reason}},now);
  await tx.query(`UPDATE strategy_allocations SET status='detached',restore_required=false,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
  await refreshStatuses(tx,a.account_id,now);
 }

 /** Open cases waiting on this allocation that a "keep" can settle: the shortfall comes off its claim. */
 async function keepOutsideCases(tx:Transaction,allocationId:string,now:string):Promise<string[]>{
  const cases=(await tx.query<{id:string;cause:string;observed:string|null}>(`SELECT id,cause,observed::text FROM strategy_reconciliation_cases WHERE resolved_at IS NULL
   AND impacts @> jsonb_build_array(jsonb_build_object('allocationId',$1::text)) ORDER BY created_at`,[allocationId])).rows;
  const settled:string[]=[];
  for(const c of cases){
   if(!['cash_shortfall','position_shortfall'].includes(c.cause))continue;
   try{await keepReducedCase(tx,c.id,now);settled.push(c.id);}
   catch{throw new InstructionConflict("The account can't be counted right now. Try again after it syncs.",'shortfall_unmeasured');}
  }
  return settled;
 }

 // ---- Holdings, in the shape the panel reads ----
 async function holdingView(db:Query,a:AllocationRow){
  const t=await targets(db,a.strategy_id,a.id);
  const v=await valued(db,a);
  const loaded=await loadAllocationEntries(db,a.id);
  const pnl=deriveAllocationPnl((loaded?.entries??[]).map((e,i)=>({sequence:i+1,entryType:e.entryType,symbol:e.symbol,quantityDelta:e.quantityDelta,cashDelta:e.cashDelta})));
  const total=v.valuation.ready?v.valuation.allocationValueUsd:null;
  const open=(await db.query<{status:string;symbol:string}>(`SELECT status,symbol FROM strategy_executions WHERE allocation_id=$1 AND status IN ${OPEN_SQL}`,[a.id])).rows;
  const failure=(await db.query<{symbol:string;failure_code:string|null;terminal_at:Date|null}>(`SELECT symbol,failure_code,terminal_at FROM strategy_executions f WHERE allocation_id=$1 AND status='failed'
   AND NOT EXISTS(SELECT 1 FROM strategy_executions later WHERE later.allocation_id=f.allocation_id AND later.status NOT IN ('failed','cancelled') AND later.created_at>f.created_at)
   ORDER BY terminal_at DESC NULLS LAST,created_at DESC LIMIT 1`,[a.id])).rows[0];
  const closure=(await db.query<{reason:'archive'|'close';status:'awaiting'|'selling'|'held'|'sold'|'failed';sell_symbols:string[]|null;opened_at:Date;failure_code:string|null}>(`SELECT reason,status,sell_symbols,opened_at,failure_code FROM strategy_allocation_closures WHERE allocation_id=$1`,[a.id])).rows[0];
  const rebalances=(await db.query<{on:string;trigger:string;legs:number}>(`SELECT to_char(created_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS on,
   coalesce(trigger,CASE WHEN kind='subscribe' THEN 'activation' ELSE 'republish' END) AS trigger,count(*)::int AS legs FROM strategy_executions
   WHERE allocation_id=$1 AND status NOT IN ('cancelled','failed') GROUP BY 1,2 ORDER BY 1 DESC LIMIT 5`,[a.id])).rows;
  const positions=v.holdings.positions.filter(p=>amount(p.quantity)!==0n).map(p=>{
   const symbol=(p.symbol??p.instrumentRef).toUpperCase();
   const value=v.valuation.ready?v.valuation.positions.get(p.instrumentRef)??null:null;
   // Hosted: a position with no cost record counts at zero cost.
   const cost=pnl.bySymbol.get(p.symbol??'')??pnl.bySymbol.get(symbol)??{quantity:p.quantity,costBasis:'0',realized:'0'};
   return {symbol,quantity:p.quantity,markPrice:value?.markPriceUsd??null,value:value?.valueUsd??null,costBasis:cost.costBasis,
    unrealized:value?format(amount(value.valueUsd)-amount(cost.costBasis)):null,realized:cost.realized};
  }).sort((l,r)=>l.symbol.localeCompare(r.symbol));
  // Hosted's bucket total: the sum over positions, known only when every position is valued.
  const unrealized=v.valuation.ready&&positions.every(p=>p.unrealized!==null)?format(positions.reduce((n,p)=>n+amount(p.unrealized!),0n)):null;
  const weights=t?.weights??[];
  const skipped=total===null?[]:weights.filter(w=>Number(total)*w.weightPercent/100<Number(MINIMUM_ORDER_NOTIONAL_USD)).map(w=>w.symbol);
  const replication=replicationState({targetSymbols:weights.filter(w=>w.weightPercent>0).map(w=>w.symbol),heldSymbols:positions.filter(p=>Number(p.quantity)>0).map(p=>p.symbol),
   inFlightSymbols:open.map(o=>o.symbol),skippedSymbols:skipped,everSynchronized:a.applied_version_sequence>0});
  const deferred=a.planning_deferred_until===null?null:new Date(a.planning_deferred_until).toISOString();
  const cases=(await db.query<{id:string;cause:string;observed:string|null;claimed:string|null;difference:string|null;impacts:{allocationId:string;quantity:string}[];evidence:Record<string,unknown>;created_at:Date;instrument_ref:string|null}>(
   `SELECT id,cause,observed::text,claimed::text,difference::text,impacts,evidence,created_at,instrument_ref FROM strategy_reconciliation_cases WHERE resolved_at IS NULL
   AND impacts @> jsonb_build_array(jsonb_build_object('allocationId',$1::text)) ORDER BY created_at DESC`,[a.id])).rows;
  const names=async(impacts:{allocationId:string;quantity:string}[])=>Promise.all(impacts.filter(i=>i.allocationId!==a.id).map(async i=>{
   const other=(await db.query<{title:string|null}>(`SELECT v.metadata->>'title' AS title FROM strategy_allocations x JOIN strategies s ON s.id=x.strategy_id LEFT JOIN strategy_versions v ON v.id=s.current_version_id WHERE x.id=$1`,[i.allocationId])).rows[0];
   return {bucketId:i.allocationId,strategyName:other?.title??'Take',shares:i.quantity,amount:i.quantity};
  }));
  const method=(c:{evidence:Record<string,unknown>})=>c.evidence.assignment==='observed_lot_loss'?'lots' as const:'proportional' as const;
  const sale=cases.find(c=>c.cause==='position_shortfall'&&c.observed!==null);
  const cashCase=cases.find(c=>c.cause==='cash_shortfall');
  let outsideSale:unknown=null;
  if(sale){
   const share=sale.impacts.find(i=>i.allocationId===a.id)?.quantity??null;
   const symbol=positions.find(p=>true&&v.holdings.positions.some(h=>h.instrumentRef===sale.instrument_ref&&(h.symbol??'').toUpperCase()===p.symbol))?.symbol
    ??(sale.instrument_ref??'').toUpperCase();
   const mark=positions.find(p=>p.symbol===symbol)?.markPrice??null;
   outsideSale={caseId:sale.id,symbol,soldQuantity:sale.difference===null?null:format(-amount(sale.difference)),soldAt:new Date(sale.created_at).toISOString(),proceeds:null,
    ownShares:null,strategyShares:share,method:method(sale),others:(await names(sale.impacts)).map(({bucketId,strategyName,shares})=>({bucketId,strategyName,shares})),editable:false,
    restoreAmount:share!==null&&mark!==null?(Number(share)*Number(mark)).toFixed(2):null};
  }
  const outsideCash=cashCase?{caseId:cashCase.id,detectedAt:new Date(cashCase.created_at).toISOString(),accountCash:cashCase.observed,strategiesCash:cashCase.claimed??'0',
   strategyAmount:cashCase.impacts.find(i=>i.allocationId===a.id)?.quantity??null,method:method(cashCase),
   others:(await names(cashCase.impacts)).map(({bucketId,strategyName,amount})=>({bucketId,strategyName,amount})),editable:false}:null;
  return {
   bucket:{id:a.id,status:a.status,allocationValue:a.allocation_value??'0',activatedAt:a.activated_at===null?null:new Date(a.activated_at).toISOString(),createdAt:new Date(a.created_at).toISOString()},
   strategy:{id:a.strategy_id,slug:t?.title??'strategy',displayName:t?.title??'Take',description:t?.description??null,iconUrl:null},
   allocation:t===null?null:{sequence:t.sequence,weights:t.weights,cashPercent:t.cashPercent},
   valuation:{complete:v.valuation.ready,currency:'USD',cash:v.holdings.cash,totalValue:total},
   pnl:{capitalAllocated:pnl.capitalAllocated,unrealized,realized:pnl.realizedNet,allTimeReturn:total===null||amount(pnl.capitalAllocated)<=0n?null:
    ((Number(total)-Number(pnl.capitalAllocated))/Number(pnl.capitalAllocated)*100).toFixed(2)},
   positions,
   rebalances,
   openExecutions:open.length,
   replication:{...replication,untradableSymbols:[] as string[]},
   lastFailure:failure?{symbol:failure.symbol,code:failure.failure_code??'unknown',at:failure.terminal_at===null?null:new Date(failure.terminal_at).toISOString(),
    retryAt:deferred!==null&&a.planning_reason_code!==null&&Date.parse(deferred)>clock()?deferred:null}:null,
   ordersOpenAt:a.planning_reason_code===MARKET_CLOSED&&deferred!==null&&open.length>0?deferred:null,
   waiting:a.planning_reason_code!==null&&WAITING_REASONS.has(a.planning_reason_code)?{reason:a.planning_reason_code,until:deferred}:null,
   outsideSale,outsideCash,
   closure:closure?{reason:closure.reason,status:closure.status,sellSymbols:closure.sell_symbols,openedAt:new Date(closure.opened_at).toISOString(),failureCode:closure.failure_code}:null,
   requiresReconciliation:a.restore_required,
   unknownOrders:(await db.query<{id:string;symbol:string;side:string;order_request:{dollar_amount?:string;quantity?:string};sent_at:Date|null}>(
    `SELECT e.id,e.symbol,e.side,e.order_request,coalesce(i.confirmed_at,i.updated_at) AS sent_at FROM strategy_executions e LEFT JOIN order_intents i ON i.id=e.order_intent_id
     WHERE e.allocation_id=$1 AND e.status IN ('placement_unknown','reconciliation_required') ORDER BY e.created_at`,[a.id])).rows
    .map(o=>({legId:o.id,symbol:o.symbol,side:o.side,amount:o.order_request.dollar_amount??null,quantity:o.order_request.quantity??null,sentAt:o.sent_at===null?null:new Date(o.sent_at).toISOString()})),
  };
 }

 async function selectedAccount(db:Query):Promise<string|null>{
  return (await db.query<{id:string}>(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE a.selected AND a.available AND a.agentic_allowed LIMIT 1`)).rows[0]?.id??null;
 }

 // ---- Closing ----
 async function closeAllocation(allocationId:string,choice:SellChoice,operationId?:string){
  const prep=await atomic(async(tx,now)=>{
   const a=await row(tx,allocationId);
   if(!['active','paused','diverged'].includes(a.status))throw new InstructionConflict('This investment is not following a take','bucket_not_following');
   const existing=(await tx.query<{status:string}>(`SELECT status FROM strategy_allocation_closures WHERE allocation_id=$1`,[allocationId])).rows[0];
   if(existing&&existing.status!=='awaiting'&&existing.status!=='failed')throw new InstructionConflict('This investment is already being closed','closure_settled');
   // An outside sale waiting on the member comes off the claim first, so the close deals only in shares the account holds.
   await keepOutsideCases(tx,allocationId,now);
   if(!existing)await tx.query(`INSERT INTO strategy_allocation_closures(id,allocation_id,reason,status,opened_at,updated_at) VALUES($1,$2,'close','awaiting',$3,$3)`,[randomUUID(),allocationId,now]);
   const h=await holdingsOf(tx,allocationId);
   const held=h.positions.filter(p=>amount(p.quantity)>0n).map(p=>(p.symbol??p.instrumentRef).toUpperCase());
   const wanted=choice==='none'?[]:choice==='all'?held:held.filter(s=>new Set(choice.map(c=>c.toUpperCase())).has(s));
   const settle=async(status:'held'|'sold'|'failed',failureCode:string|null,completed:boolean)=>tx.query(`UPDATE strategy_allocation_closures SET status=$2,sell_symbols=$3,decided_at=$4,failure_code=$5,updated_at=$4${completed?',completed_at=$4':''} WHERE allocation_id=$1`,
    [allocationId,status,JSON.stringify(wanted),now,failureCode]);
   if(wanted.length===0){await release(tx,allocationId,'close_hold',now);await settle('held',null,true);return {wanted,instructionId:null};}
   // Selling counts as the member's approval of every leg; a paused or diverged allocation comes back to active so placement accepts it.
   await tx.query(`UPDATE strategy_allocations SET status='active',restore_required=false,paused_at=NULL,planning_reason_code='liquidating',planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
   const instructionId=await instruction(tx,{allocationId,kind:'exit',cause:`close:${operationId??randomUUID()}`,pendingReason:'requested'},now);
   await setDetails(tx,instructionId,{sellSymbols:wanted},now);
   return {wanted,instructionId};
  });
  if(prep.instructionId===null)return {placementNeeded:false};
  const plan=await deps.planner.planLiquidation(allocationId,{kind:'liquidate',transactionId:prep.instructionId,symbols:prep.wanted});
  const status=plan.disposition==='planned'||plan.disposition==='deferred'?'selling':plan.disposition==='skipped'?'sold':'failed';
  await atomic(async(tx,now)=>{
   if(status==='sold')await release(tx,allocationId,'close_sold',now);
   await tx.query(`UPDATE strategy_allocation_closures SET status=$2,sell_symbols=$3,decided_at=$4,failure_code=$5,updated_at=$4${status==='sold'?',completed_at=$4':''} WHERE allocation_id=$1`,
    [allocationId,status,JSON.stringify(prep.wanted),now,status==='failed'?plan.reasonCode:null]);
  });
  if(plan.disposition==='planned')await deps.executor.executeAllocation(allocationId,{confirmed:true});
  return {placementNeeded:plan.disposition==='planned'};
 }

 // ---- Withdrawals ----
 async function redemptionPreview(db:Query,allocationId:string,amountUsd:string){
  const a=await row(db,allocationId);const v=await valued(db,a);const t=await targets(db,a.strategy_id,a.id);
  const holdings=v.valuation.ready?v.holdings.positions.flatMap(p=>{const value=v.valuation.ready?v.valuation.positions.get(p.instrumentRef):undefined;
   return value&&amount(p.quantity)>0n?[{symbol:(p.symbol??p.instrumentRef).toUpperCase(),valueUsd:value.valueUsd}]:[];}):[];
  if(v.cryptoMinimum===null)throw new InstructionConflict('Refresh crypto prices and order limits before withdrawing.','crypto_sizing_evidence_required');
  const plan=planRedemption(amountUsd,holdings,{minimumOrderNotionalUsd:v.cryptoMinimum,...(t?{targets:t.weights}:{})});
  return {ok:plan.ok,amount:amountUsd,band:{minimumAmount:plan.band.minimumUsd,maximumAmount:plan.band.maximumUsd,possible:plan.band.possible,holdingsValue:plan.band.holdingsValueUsd},
   legs:plan.legs.map(l=>({symbol:l.symbol,notional:l.notionalUsd})),reasons:plan.reasons,remainingValue:plan.remainingValueUsd};
 }
 async function runInstruction(allocationId:string,instructionId:string):Promise<PlanResult>{
  const r=await database.use(async db=>(await db.query<{kind:string;requested_amount:string|null;details:Record<string,unknown>}>(`SELECT kind,requested_amount::text,details FROM strategy_allocation_transactions WHERE id=$1 AND allocation_id=$2`,[instructionId,allocationId])).rows[0]);
  if(r&&MONEY.includes(r.kind))return deps.planner.planAllocation(allocationId,r.kind==='investment'?'activation':'deposit');
  if(r?.kind==='exit'){
   const symbols=Array.isArray(r.details.sellSymbols)?(r.details.sellSymbols as unknown[]).filter((s):s is string=>typeof s==='string'):[];
   return deps.planner.planLiquidation(allocationId,{kind:'liquidate',transactionId:instructionId,symbols});
  }
  if(!r||r.kind!=='redemption'||r.requested_amount===null)return {allocationId,planId:null,disposition:'failed',reasonCode:'instruction_not_found',executionIds:[],sleeves:[]};
  return deps.planner.planLiquidation(allocationId,{kind:'redeem',transactionId:instructionId,amount:format(amount(r.requested_amount))});
 }
 async function runAndPlace(allocationId:string,instructionId:string,confirmed=false){
  const result=await runInstruction(allocationId,instructionId);
  const delegated=result.disposition==='planned'?await deps.executor.executeAllocation(allocationId,confirmed?{confirmed:true}:undefined):null;
  return {disposition:result.disposition,reasonCode:result.reasonCode,executions:result.executionIds,
   delegated:delegated===null?null:{placed:delegated.placed,failed:delegated.failed,skippedReason:delegated.parkedReason},
   instruction:await database.use(db=>readInstruction(db,allocationId,instructionId))};
 }

 /** Confirm: everything planned so far may go out; the hold is lifted. */
 async function confirmOrders(allocationId:string){
  await atomic(async(tx,now)=>{
   await row(tx,allocationId);
   await tx.query(`UPDATE strategy_allocations SET orders_confirmed_at=$2,
    planning_reason_code=CASE WHEN planning_reason_code=$3 THEN NULL ELSE planning_reason_code END,
    planning_deferred_until=CASE WHEN planning_reason_code=$3 THEN NULL ELSE planning_deferred_until END,updated_at=$2 WHERE id=$1`,[allocationId,now,AWAITING_CONFIRMATION]);
  });
  return deps.executor.executeAllocation(allocationId,{confirmed:true});
 }
 async function confirmAndRun(allocationId:string,instructionId:string){
  await atomic(async(tx,now)=>{
   const r=(await tx.query<{pending_reason:string|null;outcome:string|null}>(`SELECT pending_reason,outcome FROM strategy_allocation_transactions WHERE id=$1 AND allocation_id=$2`,[instructionId,allocationId])).rows[0];
   if(!r)throw new InstructionNotFound('Instruction not found');
   if(r.outcome!==null||r.pending_reason!=='reconfirm_required')throw new InstructionConflict('This instruction is not waiting for a confirmation','instruction_not_awaiting_confirmation');
   await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason='requested',updated_at=$2 WHERE id=$1`,[instructionId,now]);
   await setDetails(tx,instructionId,{reconfirmedAt:now},now);
  });
  return runAndPlace(allocationId,instructionId);
 }

 // ---- Cancel ----
 async function cancelInstruction(allocationId:string,instructionId:string,preparationFailure=false):Promise<{replan:boolean}>{
  return atomic(async(tx,now)=>{
   const r=(await tx.query<{kind:string;requested_amount:string|null;pending_reason:string|null;outcome:'cancelled'|'superseded'|'failed'|null}>(
    `SELECT kind,requested_amount::text,pending_reason,outcome FROM strategy_allocation_transactions WHERE id=$1 AND allocation_id=$2`,[instructionId,allocationId])).rows[0];
   if(!r)throw new InstructionNotFound('Instruction not found');
   if(!CANCELLABLE.includes(r.kind))throw new InstructionConflict('This instruction cannot be cancelled','instruction_not_cancellable');
   const legs=(await tx.query<{status:string;order_intent_id:string|null;submitted_at:Date|null}>(`SELECT status,order_intent_id,submitted_at FROM strategy_executions WHERE transaction_id=$1`,[instructionId])).rows;
   const status=instructionStatus({outcome:r.outcome,pendingReason:r.pending_reason,legs});
   if(status==='cancelled'||status==='superseded')return {replan:false};
   if(preparationFailure&&legs.some(l=>l.order_intent_id!==null||l.submitted_at!==null||!['queued','failed','cancelled'].includes(l.status)))throw new InstructionConflict('Order outcome must be resolved before cash can be released','instruction_submitted');
   if(!preparationFailure&&!instructionCancellable(status,legs))throw new InstructionConflict(status==='open'?'Its orders have already been sent':'This instruction has already finished',status==='open'?'instruction_submitted':'instruction_finished');
   if(MONEY.includes(r.kind)&&!preparationFailure&&(await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ${SENT_SQL} LIMIT 1`,[allocationId])).rows.length)throw new InstructionConflict('Orders are still resolving','instruction_submitted');
   if(MONEY.includes(r.kind)&&preparationFailure){
    if((await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status IN ${SENT_SQL} LIMIT 1`,[allocationId])).rows.length)
     throw new InstructionConflict('Orders on this investment are being sent; try again once they finish','instruction_submitted');
    if(r.requested_amount===null)throw new InstructionConflict('This instruction has no amount to hand back','instruction_not_cancellable');
    const held=(await holdingsOf(tx,allocationId)).cash;
    if(amount(held)<amount(r.requested_amount))throw new InstructionConflict('This money has already been invested; take it out with a withdrawal instead','instruction_spent');
    if(r.kind==='investment'&&(await holdingsOf(tx,allocationId)).positions.some(p=>amount(p.quantity)!==0n))
     throw new InstructionConflict('This investment has already bought shares; close it instead','instruction_spent');
    await tx.query(`UPDATE strategy_executions SET status='cancelled',failure_code='instruction_cancelled',terminal_at=$2,updated_at=$2 WHERE allocation_id=$1 AND status='queued'`,[allocationId,now]);
    await append(tx,{allocationId,transactionId:instructionId,entryType:'capital_released',cashDelta:format(-amount(r.requested_amount)),cause:`instruction_cancelled:${instructionId}`,
     sourceKind:'member_instruction',sourceRef:instructionId,occurredAt:now,metadata:{cancelled:VIEW_KIND[r.kind]}},now);
    const a=await row(tx,allocationId);
    const remaining=amount(a.allocation_value??'0')-amount(r.requested_amount);
    if(r.kind==='investment'){
     // No draft locally: a cancelled first investment holds nothing and stops following.
     await tx.query(`UPDATE strategy_allocations SET status='closed',closed_at=$2,allocation_value=0,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
    }else await tx.query(`UPDATE strategy_allocations SET allocation_value=$2,planning_reason_code='instruction_cancelled',planning_deferred_until=NULL,updated_at=$3 WHERE id=$1`,[allocationId,usd(remaining),now]);
   }else{
    await tx.query(`UPDATE strategy_executions SET status='cancelled',failure_code='instruction_cancelled',terminal_at=$2,updated_at=$2 WHERE transaction_id=$1 AND status='queued'`,[instructionId,now]);
   }
   await tx.query(`UPDATE strategy_allocation_transactions SET outcome='cancelled',outcome_code='member',outcome_at=$2,pending_reason=NULL,updated_at=$2 WHERE id=$1`,[instructionId,now]);
   return {replan:preparationFailure&&r.kind==='contribution'};
  });
 }

 // ---- The queue ----
 async function queueList(){
  return database.use(async db=>{
   const now=clock();const {confirmTrades}=await preferences(db);
   const rows=(await db.query<{id:string;kind:string;allocation_id:string;strategy_id:string;title:string|null;requested_amount:string|null}>(`SELECT t.id,t.kind,t.allocation_id,a.strategy_id,v.metadata->>'title' AS title,t.requested_amount::text
    FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id JOIN strategies s ON s.id=a.strategy_id LEFT JOIN strategy_versions v ON v.id=s.current_version_id
    WHERE t.kind=ANY($1) AND t.outcome IS NULL AND (t.pending_reason IS NOT NULL OR EXISTS(SELECT 1 FROM strategy_executions l WHERE l.transaction_id=t.id AND l.status IN ${OPEN_SQL})) LIMIT 50`,[LOCAL_KINDS])).rows;
   const legs=(await db.query<{allocation_id:string;transaction_id:string|null;transaction_kind:string|null;symbol:string;side:string;status:string;created_at:Date;strategy_id:string;title:string|null;planning_reason_code:string|null;orders_confirmed_at:Date|null;spec:BasketSpec|null}>(
    `SELECT l.allocation_id,l.transaction_id,t.kind AS transaction_kind,l.symbol,l.side,l.status,l.created_at,a.strategy_id,v.metadata->>'title' AS title,a.planning_reason_code,a.orders_confirmed_at,v.spec
    FROM strategy_executions l JOIN strategy_allocations a ON a.id=l.allocation_id JOIN strategies s ON s.id=a.strategy_id LEFT JOIN strategy_versions v ON v.id=coalesce(l.version_id,a.accepted_version_id)
    LEFT JOIN strategy_allocation_transactions t ON t.id=l.transaction_id WHERE l.status IN ${OPEN_SQL} LIMIT 500`)).rows;
   const unconfirmed=(l:(typeof legs)[number])=>confirmTrades&&l.status==='queued'&&(l.orders_confirmed_at===null||new Date(l.created_at).getTime()>new Date(l.orders_confirmed_at).getTime());
   const list=(symbols:readonly string[])=>symbols.length<=1?symbols.join(''):`${symbols.slice(0,-1).join(', ')} and ${symbols[symbols.length-1]}`;
   const dollars=(v:string|null)=>v===null?'':`$${Number(v).toFixed(2)}`;
   const WAITING:Record<string,string>={lots_unsettled:'Waiting to settle',market_closed:'Waiting for the open',open_execution:'Waiting on other orders',fresh_position_snapshot_required:'Checking your account',requested:'Starting'};
   const items:Record<string,unknown>[]=[];
   for(const r of rows){
    const view=await readInstruction(db,r.allocation_id,r.id);
    const name=r.title??'Take',amt=dollars(r.requested_amount),kind=VIEW_KIND[r.kind];
    const title=kind==='partial_redemption'?`Withdraw ${amt} · ${name}`:kind==='contribution'?`Deposit${amt?` ${amt}`:''} · ${name}`:kind==='subscription'?`Invest${amt?` ${amt}`:''} · ${name}`:`Close · ${name}`;
    const changed=view.pendingReason==='reconfirm_required';
    const awaiting=!changed&&legs.some(l=>l.transaction_id===r.id&&unconfirmed(l));
    const selling=kind==='partial_redemption'||kind==='full_exit';
    const buying=view.symbols.length>0&&!selling;
    items.push({...(awaiting?{approval:{summary:`${selling?'Sell':'Buy'} ${list(view.symbols)}`,strategyName:name}}:{}),
     id:`strategy:instruction:${r.allocation_id}:${r.id}`,source:'strategy',
     state:changed||awaiting?'needs_you':view.status==='pending'||view.cancellable||view.waitingFor!==null?'waiting':'in_progress',
     title,detail:changed?'Holdings changed; confirm':awaiting?`Confirm to ${selling?'sell':'buy'} ${list(view.symbols)}`:view.status==='pending'?WAITING[view.pendingReason??'']??'Waiting'
      :view.waitingFor===MARKET_CLOSED?buying?`Buy ${list(view.symbols)} at the open`:'Waiting for the open':view.cancellable?'Orders queued':selling?'Selling now':'Buying now',
     reason:view.waitingFor,expectedAt:view.expectedAt,createdAt:view.createdAt,link:{kind:'strategy',id:r.strategy_id},
     actions:changed||awaiting?view.cancellable?['confirm','cancel']:['confirm']:view.cancellable?['cancel']:[]});
   }
   const planned=new Map<string,typeof legs>();
   for(const l of legs){if(l.transaction_kind!==null&&LOCAL_KINDS.includes(l.transaction_kind))continue;const key=l.transaction_id??`bucket:${l.allocation_id}`;planned.set(key,[...(planned.get(key)??[]),l]);}
   for(const [key,group] of planned){
    const first=group[0]!;const queuedOnly=group.every(l=>l.status==='queued');const awaiting=group.some(unconfirmed);
    const session=group.every(l=>basketSessionPolicy(l.spec).calendar==='continuous')?basketSessionPolicy(first.spec):robinhoodEquitySession;
    const closed=!session.isOpen(now);
    const buys=[...new Set(group.filter(l=>l.side==='buy').map(l=>l.symbol))].sort(),sells=[...new Set(group.filter(l=>l.side==='sell').map(l=>l.symbol))].sort();
    const what=[buys.length?`Buy ${list(buys)}`:null,sells.length?`Sell ${list(sells)}`:null].filter(Boolean).join(', ');
    items.push({...(awaiting?{approval:{summary:what,strategyName:first.title??'Take'}}:{}),id:`strategy:orders:${first.allocation_id}:${key}`,source:'strategy',
     state:awaiting?'needs_you':queuedOnly?'waiting':'in_progress',title:`Orders · ${first.title??'Take'}`,detail:awaiting?`Confirm: ${what}`:queuedOnly?what:`${what}, placing now`,
     reason:queuedOnly?(closed?MARKET_CLOSED:first.planning_reason_code===MARKET_CLOSED?null:first.planning_reason_code):null,expectedAt:queuedOnly&&closed?new Date(session.nextOpen(now)).toISOString():null,
     createdAt:new Date(first.created_at).toISOString(),link:{kind:'strategy',id:first.strategy_id},actions:awaiting?['confirm']:[]});
   }
   return items;
  });
 }

 const api={
  checkTradability,
  OPEN_EXECUTION_STATES,

  /** Every allocation on the selected account, as the panel reads them. */
  async holdings(){
   return database.use(async db=>{
    const accountId=await selectedAccount(db);
    if(accountId===null)return {status:200,holdings:[],selfDirected:[]};
    const rows=(await db.query<{id:string}>(`SELECT id FROM strategy_allocations WHERE account_id=$1 AND status IN ('active','paused','diverged') ORDER BY created_at`,[accountId])).rows;
    const holdings=[];for(const r of rows)holdings.push(await holdingView(db,await row(db,r.id)));
    const reserved=(await db.query<{v:string}>(`SELECT coalesce(sum(e.cash_delta),0)::text AS v FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
     WHERE a.account_id=$1 AND a.status IN ('active','paused','diverged')`,[accountId])).rows[0]!.v;
    return {status:200,holdings,selfDirected:[{accountId,asOf:null,reservedCash:usd(amount(reserved)),positions:[]}]};
   });
  },

  /** What an amount would buy, and anything stopping it. */
  async preflight(target:{strategyId:string}|{bucketId:string},amountUsd:string){
   return database.use(async db=>{
    if('bucketId' in target){
     const a=await row(db,target.bucketId);
     const {result,t}=await preflightFor(db,{strategyId:a.strategy_id,amount:amountUsd,kind:'contribution',allocationId:a.id,accountId:a.account_id});
     return preflightView('contribution',amountUsd,result,t);
    }
    const {result,t}=await preflightFor(db,{strategyId:target.strategyId,amount:amountUsd,kind:'subscription',accountId:await selectedAccount(db)});
    return preflightView('subscription',amountUsd,result,t);
   });
  },

  /**
   * Create and activate in one step: the checks
   * run, then the money is set aside (capital_allocated) on an active
   * allocation whose first plan is the subscription. Returns { id }.
   */
  async create(input:{strategyId:string;financialAccountId:string;allocationValue:string}){
   if(!DOLLARS.test(input.allocationValue)||Number(input.allocationValue)<=0)throw new InstructionConflict('Enter a positive dollar amount','invalid_amount');
   const checked=await database.use(async db=>{
    const t=await targets(db,input.strategyId);
    if(!t||!t.committed||t.archived)throw new InstructionConflict('Commit this take before investing in it','strategy_not_published');
    const account=(await db.query<{id:string}>(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE a.id=$1 AND a.selected AND a.available AND a.agentic_allowed AND c.status='connected'`,[input.financialAccountId])).rows[0];
    if(!account)throw new InstructionConflict('Select a connected Robinhood Agentic account','account_unavailable');
    if((await db.query(`SELECT 1 FROM strategy_allocations WHERE account_id=$1 AND strategy_id=$2 AND status IN ('active','paused','diverged') LIMIT 1`,[input.financialAccountId,input.strategyId])).rows.length)
     throw new InstructionConflict('You already invest in this take; deposit to add money','already_following');
    const room=await accountRoom(db,input.financialAccountId);
    if(!room.portfolio||room.portfolio.data.currency!=='USD')throw new InstructionConflict('A complete matching-currency Robinhood portfolio sync is required','snapshot_required');
    if(room.room!==null&&amount(input.allocationValue)>room.room)throw new InstructionConflict('Take allocations would exceed the latest Robinhood account value','allocation_exceeds_account');
    if(room.freeCash!==null&&amount(input.allocationValue)>room.freeCash)
     throw new InstructionConflict(`This needs $${input.allocationValue} but only $${usd(room.freeCash)} is uninvested after other takes. Deposit or lower the amount.`,'insufficient_cash');
    const prefs=await preferences(db);
    const {result:preflight}=await preflightFor(db,{strategyId:input.strategyId,amount:input.allocationValue,kind:'subscription',accountId:input.financialAccountId});
    const blocked=preflight.reasons.find(r=>r.code==='symbol_blocked');
    if(blocked)throw blockedError(blocked.symbols);
    if(!preflight.ok&&preflight.reasons.some(r=>r.code!=='leg_below_minimum'))throw new InstructionConflict('This investment could not be sized. Refresh account data and check the amount.',preflight.reasons[0]?.code??'sizing_unavailable');
    return {t,preflight};
   });
   await checkTradability(input.financialAccountId,checked.preflight.legs.map(l=>l.symbol),requestedInstruments(checked.t,checked.preflight));
   const floor=checked.preflight.reasons.find(r=>r.code==='leg_below_minimum');
   if(floor)throw new InstructionConflict(`This take needs at least $${floor.needed??checked.preflight.minimumAllocationUsd} so every position can be bought`,'allocation_below_minimum');
   const allocationId=randomUUID();
   const invested=await deps.core.invest({allocationId,accountId:input.financialAccountId,strategyId:input.strategyId,versionId:checked.t.versionId,amount:input.allocationValue,cause:`invest:${allocationId}`})
    .catch((error:unknown)=>{throw new InstructionConflict(error instanceof Error?error.message:'Could not invest','insufficient_cash');});
   await atomic(async(tx,now)=>{
    await tx.query(`UPDATE strategy_allocations SET allocation_value=$2,activated_at=$3,applied_version_sequence=0,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$3 WHERE id=$1`,[allocationId,input.allocationValue,now]);
    // The first plan adopts this instruction (a subscription pending `requested`).
    await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason='requested',details=details||$2::jsonb,updated_at=$3 WHERE id=$1`,[invested.transactionId,JSON.stringify({requestedAmountUsd:input.allocationValue}),now]);
   });
   return {id:allocationId};
  },

  /** Status: active (start or resume), paused, detached (stop following, keep shares). */
  async update(allocationId:string,input:{status?:'active'|'paused'|'detached'}){
   if(input.status==='paused'){
    await atomic(async(tx,now)=>{
     const a=await row(tx,allocationId);
     if(a.status!=='active')throw new InstructionConflict('Only an active investment can be paused');
     await tx.query(`UPDATE strategy_allocations SET status='paused',paused_at=$2,updated_at=$2 WHERE id=$1 AND status='active'`,[allocationId,now]);
    });
    return {id:allocationId,status:'paused'};
   }
   if(input.status==='detached'){await atomic((tx,now)=>release(tx,allocationId,'stop_following',now));return {id:allocationId,status:'detached'};}
   const current=await database.use(db=>row(db,allocationId));
   if(current.status==='paused'){
    await atomic(async(tx,now)=>{
     const a=await row(tx,allocationId);
     if(a.restore_required)throw new InstructionConflict('Review this investment against your account before resuming','restore_required');
     if((await tx.query(`SELECT 1 FROM strategy_reconciliation_cases WHERE resolved_at IS NULL AND impacts @> jsonb_build_array(jsonb_build_object('allocationId',$1::text)) LIMIT 1`,[allocationId])).rows.length)
      throw new InstructionConflict('Resolve the reconciliation case before resuming');
     const t=await targets(tx,a.strategy_id,a.id);
     if(!t||!t.committed||t.archived)throw new InstructionConflict('The take or Robinhood Agentic account is unavailable');
     await tx.query(`UPDATE strategy_allocations SET status='active',paused_at=NULL,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1 AND status='paused'`,[allocationId,now]);
    });
   }else if(current.status!=='active')throw new InstructionConflict('This investment cannot be activated');
   const first=current.activated_at!==null&&current.applied_version_sequence===0;
   const pending=first?await database.use(async db=>(await db.query<{id:string}>("SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='investment' AND outcome IS NULL ORDER BY created_at DESC LIMIT 1",[allocationId])).rows[0]):null;
   let prepared:Awaited<ReturnType<typeof planAndExecute>>;
   try{prepared=await planAndExecute(allocationId,first?'activation':'manual');}
   catch(error){if(pending){await returnPreparationCash(allocationId,pending.id);throw new InstructionConflict('Robinhood could not prepare this investment. No orders were placed; cash is available in your account.','preparation_failed');}throw error;}
   if(prepared.plan.disposition==='failed'&&pending){await returnPreparationCash(allocationId,pending.id);throw new InstructionConflict('Robinhood could not prepare this investment. No orders were placed; cash is available in your account.','preparation_failed');}
   const {plan,delegated}=prepared;
   return {id:allocationId,status:'active',disposition:plan.disposition,reasonCode:plan.reasonCode,delegated};
  },

  /** A deposit, then its plan and placement. */
  async deposit(allocationId:string,amountUsd:string){
   if(!DOLLARS.test(amountUsd)||Number(amountUsd)<=0)throw new InstructionConflict('Enter a positive dollar amount','invalid_amount');
   const checked=await database.use(async db=>{const a=await row(db,allocationId);const {result,t}=await preflightFor(db,{strategyId:a.strategy_id,amount:amountUsd,kind:'contribution',allocationId,accountId:a.account_id});return {accountId:a.account_id,result,t};});
   if(!checked.result.ok){const reason=checked.result.reasons[0];if(reason?.code==='symbol_blocked')throw blockedError(reason.symbols);throw new InstructionConflict('This deposit could not be prepared. Check the amount and available cash.',reason?.code??'preflight_failed');}
   await checkTradability(checked.accountId,checked.result.legs.map(l=>l.symbol),requestedInstruments(checked.t,checked.result));
   const instructionId=await atomic(async(tx,now)=>{
    const a=await row(tx,allocationId);const prefs=await preferences(tx);
    const t=await targets(tx,a.strategy_id,a.id);
    if(prefs.blockedSymbols.length&&t){
     const blocked=t.weights.filter(w=>w.weightPercent>0&&prefs.blockedSymbols.includes(w.symbol)).map(w=>w.symbol);
     if(blocked.length)throw blockedError(blocked);
    }
    if(a.status!=='active'||a.restore_required)throw new InstructionConflict('Only an active investment can take a deposit','bucket_not_active');
    if(!t||!t.committed||t.archived)throw new InstructionConflict('This take is not taking new money','strategy_not_published');
    const room=await accountRoom(tx,a.account_id);
    if(room.freeCash!==null&&amount(amountUsd)>room.freeCash)
     throw new InstructionConflict(`Only $${cents(room.freeCash)} of your Robinhood cash isn't already held by a take.`,'insufficient_cash');
    const key=randomUUID();
    const instructionId=await instruction(tx,{allocationId,kind:'contribution',cause:`deposit:${key}`,requestedAmount:amountUsd,pendingReason:'requested'},now);
    await setDetails(tx,instructionId,{requestedAmountUsd:amountUsd},now);
    await append(tx,{allocationId,transactionId:instructionId,entryType:'capital_allocated',cashDelta:amountUsd,cause:`deposit:${key}`,sourceKind:'member_instruction',sourceRef:instructionId,occurredAt:now,metadata:{deposit:true}},now);
    await tx.query(`UPDATE strategy_allocations SET allocation_value=coalesce(allocation_value,0)+$2::numeric,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$3 WHERE id=$1`,[allocationId,amountUsd,now]);
    return instructionId;
   });
   let planned:Awaited<ReturnType<typeof planAndExecute>>;
   try{planned=await planAndExecute(allocationId,'deposit');}
   catch(error){await returnPreparationCash(allocationId,instructionId);throw new InstructionConflict('Robinhood could not prepare this deposit. No orders were placed; cash is available in your account.','preparation_failed');}
   if(planned.plan.disposition==='failed'){await returnPreparationCash(allocationId,instructionId);throw new InstructionConflict('Robinhood could not prepare this deposit. No orders were placed; cash is available in your account.','preparation_failed');}
   const {plan,delegated}=planned;
   return {id:allocationId,disposition:plan.disposition,reasonCode:plan.reasonCode,delegated};
  },

  redemptionPreview:(allocationId:string,amountUsd:string)=>{
   if(!DOLLARS.test(amountUsd))throw new InstructionConflict('Enter a dollar amount','invalid_amount');
   return database.use(db=>redemptionPreview(db,allocationId,amountUsd));
  },

  /** A withdrawal: refused with the band, recorded with what was shown, then run. */
  async redeem(allocationId:string,amountUsd:string,operationId?:string,confirmed=false){
   const a=await database.use(db=>row(db,allocationId));
   if(a.status!=='active'||a.restore_required)throw new InstructionConflict('Only an active investment can pay out','bucket_not_active');
   const preview=await database.use(db=>redemptionPreview(db,allocationId,amountUsd));
   if(!preview.ok){
    const reason=preview.reasons[0];
    throw new InstructionConflict(reason?.code==='no_partial_redemption'?'This investment is too small to take part of it out; close it instead.'
     :reason?.code==='above_band'?`Take out at most $${preview.band.maximumAmount}, so every holding keeps enough to stay tradable.`
     :reason?.code==='below_band'?`Take out at least $${preview.band.minimumAmount}, so every holding can be sold.`:'This investment has nothing to sell.',reason?.code??'redemption_unavailable');
   }
   const instructionId=await atomic(async(tx,now)=>{
    if((await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND kind='redeem' AND status IN ${OPEN_SQL} LIMIT 1`,[allocationId])).rows.length)
     throw new InstructionConflict('A withdrawal from this investment is already selling; wait for it to finish','redemption_in_progress');
    const id=await instruction(tx,{allocationId,kind:'redemption',cause:`redeem:${operationId??randomUUID()}`,requestedAmount:amountUsd,pendingReason:'requested'},now);
    await setDetails(tx,id,{requestedAmountUsd:amountUsd,preview:{legs:preview.legs,at:now}},now);
    // A second request replaces a pending first one instead of stacking.
    await tx.query(`UPDATE strategy_allocation_transactions SET outcome='superseded',outcome_code=$2,outcome_at=$3,pending_reason=NULL,updated_at=$3
     WHERE allocation_id=$1 AND kind='redemption' AND outcome IS NULL AND pending_reason IS NOT NULL AND id<>$2`,[allocationId,id,now]);
    return id;
   });
   return runAndPlace(allocationId,instructionId,confirmed);
  },

  instructions:(allocationId:string)=>database.use(async db=>{await row(db,allocationId);return {status:200,instructions:await liveInstructions(db,allocationId)};}),

  async cancelInstruction(allocationId:string,instructionId:string){
   const {replan}=await cancelInstruction(allocationId,instructionId);
   if(replan)await planAndExecute(allocationId,'deposit');
   return database.use(db=>readInstruction(db,allocationId,instructionId));
  },

  /**
   * An operator cancel, with the member as the operator: they checked
   * Robinhood and an order of unknown outcome is not there. The leg is
   * cancelled so the strategy can plan again; its order intent becomes
   * `abandoned`, which no longer blocks, yet a synced order carrying its
   * ref_id is still matched to it (and its fills to this strategy). Refused
   * once Robinhood has an id for the order.
   */
  async abandonUnknownOrder(allocationId:string,legId:string){
   await atomic(async(tx,now)=>{
    const leg=(await tx.query<{status:string;order_intent_id:string|null;provider_order_ref:string|null}>(`SELECT e.status,e.order_intent_id,i.provider_order_ref FROM strategy_executions e
     LEFT JOIN order_intents i ON i.id=e.order_intent_id WHERE e.id=$1 AND e.allocation_id=$2 FOR UPDATE OF e`,[legId,allocationId])).rows[0];
    if(!leg)throw new InstructionConflict('Order not found','not_found');
    if(!['placement_unknown','reconciliation_required'].includes(leg.status))throw new InstructionConflict('This order is no longer of unknown outcome','not_unknown');
    if(leg.provider_order_ref!==null)throw new InstructionConflict('Robinhood has this order; it will be matched on the next sync','order_exists');
    await tx.query(`UPDATE strategy_executions SET status='cancelled',failure_code='member_abandoned',terminal_at=$2,updated_at=$2 WHERE id=$1`,[legId,now]);
    if(leg.order_intent_id!==null)await tx.query(`UPDATE order_intents SET status='abandoned',error_code='member_checked_absent',updated_at=$2 WHERE id=$1 AND status IN ('placement_unknown','placing')`,[leg.order_intent_id,now]);
    await tx.query(`UPDATE strategy_allocations SET planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
   });
   return {ok:true as const};
  },

  /** The strategy page's Confirm: held orders go out; a withdrawal whose holdings changed runs again. */
  async confirmInstruction(allocationId:string,instructionId:string){
   const view=await database.use(db=>readInstruction(db,allocationId,instructionId));
   if(view.waitingFor!==AWAITING_CONFIRMATION)return confirmAndRun(allocationId,instructionId);
   const delegated=await confirmOrders(allocationId);
   return {disposition:'planned',reasonCode:null,executions:[],delegated:{placed:delegated.placed,failed:delegated.failed,skippedReason:delegated.parkedReason},
    instruction:await database.use(db=>readInstruction(db,allocationId,instructionId))};
  },

  /** Every open case waiting on the allocation is answered at once. */
  async resolveOutsideSale(allocationId:string,resolution:'keep'|'detach'){
   const caseIds=await atomic(async(tx,now)=>{
    const a=await row(tx,allocationId);
    const open=(await tx.query<{id:string}>(`SELECT id FROM strategy_reconciliation_cases WHERE resolved_at IS NULL AND impacts @> jsonb_build_array(jsonb_build_object('allocationId',$1::text))`,[allocationId])).rows;
    if(open.length===0)throw new InstructionConflict('No open reconciliation case for this investment','no_open_case');
    const settled=await keepOutsideCases(tx,allocationId,now);
    if(resolution==='detach')await release(tx,allocationId,'stop_following',now);
    else if(a.status==='diverged'){
     await refreshStatuses(tx,a.account_id,now);
     const after=await row(tx,allocationId);
     if(after.status!=='diverged'&&!after.restore_required)await tx.query(`UPDATE strategy_allocations SET status='active',paused_at=NULL,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$2 WHERE id=$1`,[allocationId,now]);
    }
    return settled.length?settled:open.map(c=>c.id);
   });
   const remaining=await database.use(db=>db.query(`SELECT 1 FROM strategy_reconciliation_cases WHERE id=ANY($1) AND resolved_at IS NULL`,[caseIds]));
   return {caseId:caseIds[0]!,caseStatus:remaining.rows.length===0?'resolved':'awaiting_user'};
  },

  close:(allocationId:string,sell:SellChoice,operationId?:string)=>closeAllocation(allocationId,sell,operationId),

  /** Plans now and places what is due (trigger manual); `options` for deploy cash. */
  async plan(allocationId:string,confirmed=false,options?:PlanOptions){
   const a=await database.use(db=>row(db,allocationId));
   if(a.status!=='active'||a.restore_required)throw new InstructionConflict('Only an active investment can be planned','bucket_not_active');
   const {plan,delegated}=await planAndExecute(allocationId,'manual',confirmed,options);
   return {planId:plan.planId,disposition:plan.disposition,reasonCode:plan.reasonCode,delegated:delegated===null?null:{placed:delegated.placed,failed:delegated.failed,parkedReason:delegated.parkedReason}};
  },

  queueList,
  /** Cancels or confirms one queue item; answers with the queue as it now stands. */
  async queueAct(itemId:string,action:'cancel'|'confirm'){
   const [source,kind,allocationId,instructionId]=itemId.split(':');
   if(source!=='strategy'||allocationId===undefined||!((kind==='instruction'&&instructionId!==undefined)||(kind==='orders'&&action==='confirm')))throw new InstructionNotFound('Queue item not found');
   if(kind==='orders')await confirmOrders(allocationId);
   else if(action==='cancel')await api.cancelInstruction(allocationId,instructionId!);
   else await api.confirmInstruction(allocationId,instructionId!);
   return queueList();
  },

  tradingPreferences:()=>database.use(preferences),
  /** No longer confirming: allocations held for a confirmation go back to placement now. */
  async setTradingPreferences(input:Partial<TradingPreferences>){
   return atomic(async(tx,now)=>{
    const current=await preferences(tx);
    const next={confirmTrades:input.confirmTrades??current.confirmTrades,blockedSymbols:(input.blockedSymbols??current.blockedSymbols).map(s=>s.trim().toUpperCase()).filter(s=>/^[A-Z][A-Z0-9.-]{0,11}$/u.test(s))};
    await tx.query(`INSERT INTO trading_preferences(owner_id,confirm_trades,blocked_symbols,updated_at) SELECT id,$1,$2,$3 FROM local_owners LIMIT 1
     ON CONFLICT(owner_id) DO UPDATE SET confirm_trades=excluded.confirm_trades,blocked_symbols=excluded.blocked_symbols,updated_at=excluded.updated_at`,[next.confirmTrades,[...new Set(next.blockedSymbols)],now]);
    if(!next.confirmTrades)await tx.query(`UPDATE strategy_allocations SET planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=$1 WHERE planning_reason_code=$2`,[now,AWAITING_CONFIRMATION]);
    return next;
   });
  },

  /** The strategy's own activity: your money in and out and its rebalances (viewer only). */
  async activity(strategyId:string,limit=30,cursor:string|null=null){
   return database.use(async db=>{
    const before=cursor??'9999-12-31T00:00:00Z';
    const money=(await db.query<{id:string;kind:string;amount:string|null;occurred_at:Date;first:boolean}>(`SELECT t.id,t.kind,t.requested_amount::text AS amount,t.created_at AS occurred_at,
     -- An imported allocation was invested before its first local deposit: that deposit is not its first investment.
     t.sequence=(SELECT min(sequence) FROM strategy_allocation_transactions x WHERE x.allocation_id=t.allocation_id AND x.kind IN ('investment','contribution'))
      AND NOT EXISTS(SELECT 1 FROM strategy_allocation_transactions x WHERE x.allocation_id=t.allocation_id AND x.kind='reconciliation' AND x.trigger LIKE 'import:%') AS first
     FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id WHERE a.strategy_id=$1 AND (t.kind IN ('investment','contribution','exit','detachment') OR (t.kind='reconciliation' AND t.trigger LIKE 'cover:%'))
     AND (t.outcome IS DISTINCT FROM 'cancelled' OR (t.kind IN ('investment','contribution') AND EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.transaction_id=t.id AND e.entry_type='capital_allocated') AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.transaction_id=t.id AND e.entry_type='capital_released'))) AND t.created_at<$2 ORDER BY t.created_at DESC LIMIT $3`,[strategyId,before,limit])).rows;
    // A settled withdrawal (a member's or a rule's reduce) shows the proceeds it released, when it released them.
    const withdrawals=(await db.query<{id:string;amount:string;occurred_at:Date}>(`SELECT t.id,abs(e.cash_delta)::text AS amount,e.occurred_at FROM strategy_allocation_transactions t
     JOIN strategy_allocations a ON a.id=t.allocation_id JOIN strategy_attribution_entries e ON e.transaction_id=t.id AND e.entry_type='capital_released'
     WHERE a.strategy_id=$1 AND t.kind='redemption' AND e.cash_delta<>0 AND e.occurred_at<$2 ORDER BY e.occurred_at DESC LIMIT $3`,[strategyId,before,limit])).rows;
    const rebalances=(await db.query<{on:Date;trigger:string;legs:number}>(`SELECT max(created_at) AS on,coalesce(trigger,'republish') AS trigger,count(*)::int AS legs FROM strategy_executions
     WHERE strategy_id=$1 AND kind='rebalance' AND status NOT IN ('cancelled','failed') AND created_at<$2 GROUP BY date_trunc('day',created_at),2 ORDER BY 1 DESC LIMIT $3`,[strategyId,before,limit])).rows;
    const cryptoMoney=(await db.query<{id:string;kind:string;amount:string;currency:string;occurred_at:Date;first:boolean;returned:boolean}>(`SELECT e.id,e.kind,abs(e.quantity)::text AS amount,e.asset AS currency,e.occurred_at,
     NOT EXISTS(SELECT 1 FROM coinbase_allocation_entries earlier WHERE earlier.allocation_id=e.allocation_id AND earlier.kind='capital' AND (earlier.occurred_at,earlier.id)<(e.occurred_at,e.id)) AS first,
     e.cause LIKE 'investment-return:%' AS returned
     FROM coinbase_allocation_entries e JOIN coinbase_allocations a ON a.id=e.allocation_id
     WHERE a.strategy_id=$1 AND e.kind IN ('capital','release') AND e.quantity<>0 AND e.occurred_at<$2
     ORDER BY e.occurred_at DESC,e.id DESC LIMIT $3`,[strategyId,before,limit])).rows;
    const cryptoRebalances=(await db.query<{id:string;updated_at:Date;trigger:string}>(`SELECT r.id,r.updated_at,r.trigger FROM coinbase_rebalance_runs r JOIN coinbase_allocations a ON a.id=r.allocation_id WHERE a.strategy_id=$1 AND r.state='completed' AND r.review_id IS NOT NULL AND r.updated_at<$2 ORDER BY r.updated_at DESC LIMIT $3`,[strategyId,before,limit])).rows;
    const me={handle:null,name:'You',isViewer:true};
    const events=[...cryptoRebalances.map(r=>({id:`coinbase-rebalance:${r.id}`,kind:'rebalance',occurredAt:r.updated_at.toISOString(),member:null,amount:null,detail:r.trigger,members:null,legs:null})),...cryptoMoney.map(m=>({id:`coinbase:${m.id}`,kind:m.kind==='release'?(m.returned?'returned':'withdrawn'):m.first?'invested':'deposit',occurredAt:m.occurred_at.toISOString(),member:me,amount:m.amount,currency:m.currency,detail:null,members:null,legs:null})),...money.map(m=>({id:m.id,kind:m.kind==='reconciliation'?'covered':m.kind==='exit'||m.kind==='detachment'?'closed':m.kind==='investment'||m.first?'invested':'deposit',occurredAt:new Date(m.occurred_at).toISOString(),
     member:me,amount:m.amount,detail:null,members:null,legs:null})),
     ...withdrawals.map(w=>({id:`withdrawal:${w.id}`,kind:'withdrawn',occurredAt:new Date(w.occurred_at).toISOString(),member:me,amount:w.amount,detail:null,members:null,legs:null})),
     ...rebalances.map(r=>({id:`rebalance:${new Date(r.on).toISOString()}:${r.trigger}`,kind:'rebalance',occurredAt:new Date(r.on).toISOString(),member:null,amount:null,detail:r.trigger,members:1,legs:r.legs}))]
     .sort((l,r)=>r.occurredAt.localeCompare(l.occurredAt)).slice(0,limit);
    return {status:200,events,nextCursor:events.length===limit?events.at(-1)!.occurredAt:null};
   });
  },

  // ---- For the scheduler ----
  /** Pending instructions that clear by themselves, one per active allocation with nothing in flight. */
  async dueInstructions(limit=50):Promise<{instructionId:string;allocationId:string}[]>{
   return database.use(async db=>{
    const rows=(await db.query<{id:string;allocation_id:string;pending_reason:string;spec:BasketSpec|null}>(`SELECT t.id,t.allocation_id,t.pending_reason,v.spec FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id LEFT JOIN strategy_versions v ON v.id=a.accepted_version_id
     WHERE t.kind=ANY($1) AND t.pending_reason=ANY($4) AND t.outcome IS NULL AND a.status='active' AND NOT a.restore_required
     AND NOT (t.kind IN ('investment','contribution') AND EXISTS(SELECT 1 FROM mixed_take_executions m JOIN takes mt ON mt.id=m.take_id WHERE mt.strategy_id=a.strategy_id AND m.state<>'completed'))
     AND (a.planning_deferred_until IS NULL OR a.planning_deferred_until<$2)
     AND ($5::boolean OR (jsonb_array_length(v.spec->'target'->'weights')>0 AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v.spec->'target'->'weights') w
      WHERE coalesce(w->'instrument'->'market'->>'kind',CASE WHEN w->'instrument'->>'venue'='coinbase' THEN 'crypto' ELSE 'equity' END)<>'crypto')))
     AND NOT EXISTS(SELECT 1 FROM strategy_executions l WHERE l.allocation_id=a.id AND l.status IN ${OPEN_SQL}) ORDER BY t.created_at LIMIT $3`,[LOCAL_KINDS,iso(),limit,[...SELF_CLEARING],robinhoodEquitySession.isOpen(clock())])).rows;
    const seen=new Set<string>();
    return rows.filter(r=>SELF_CLEARING.has(r.pending_reason)&&basketSessionPolicy(r.spec).isOpen(clock())).flatMap(r=>{if(seen.has(r.allocation_id))return [];seen.add(r.allocation_id);return [{instructionId:r.id,allocationId:r.allocation_id}];});
   });
  },
  runInstruction:(allocationId:string,instructionId:string)=>runAndPlace(allocationId,instructionId),
  /** A withdrawal whose sells all finished hands its net proceeds back; the allocation shrinks by the same. */
  async settleRedemptions():Promise<{settled:number}>{
   const candidates=await database.use(async db=>(await db.query<{id:string;allocation_id:string}>(`SELECT t.id,t.allocation_id FROM strategy_allocation_transactions t WHERE t.kind='redemption' AND t.outcome IS NULL AND t.pending_reason IS NULL
    AND EXISTS(SELECT 1 FROM strategy_executions l WHERE l.transaction_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.transaction_id=t.id AND e.entry_type='capital_released') ORDER BY t.created_at LIMIT 200`)).rows);
   let settled=0;
   for(const c of candidates){
    const released=await atomic(async(tx,now)=>{
     if((await tx.query(`SELECT 1 FROM strategy_executions WHERE transaction_id=$1 AND status IN ${OPEN_SQL} LIMIT 1`,[c.id])).rows.length)return false;
     const proceeds=amount((await tx.query<{v:string}>(`SELECT coalesce(sum(cash_delta),0)::text AS v FROM strategy_attribution_entries WHERE transaction_id=$1 AND entry_type IN ('fill','fee')`,[c.id])).rows[0]!.v);
     const a=await row(tx,c.allocation_id);
     const stop=a.planning_reason_code==='liquidating'?',planning_reason_code=NULL,planning_deferred_until=NULL':'';
     if(proceeds<=0n){
      await tx.query(`UPDATE strategy_allocations SET updated_at=$2${stop} WHERE id=$1`,[c.allocation_id,now]);
      // Every sell ended and none filled (Robinhood refused it): the withdrawal failed, so the
      // member can take money out again rather than wait on an instruction nothing will run.
      const failed=(await tx.query<{failure_code:string|null}>(`SELECT failure_code FROM strategy_executions WHERE transaction_id=$1 AND status='failed' ORDER BY terminal_at DESC NULLS LAST LIMIT 1`,[c.id])).rows[0];
      if(failed)await tx.query(`UPDATE strategy_allocation_transactions SET outcome='failed',outcome_code=$2,outcome_at=$3,updated_at=$3 WHERE id=$1 AND outcome IS NULL`,[c.id,failed.failure_code??'sell_failed',now]);
      return false;
     }
     const remaining=amount(a.allocation_value??'0')-proceeds;
     if(remaining<=0n)return false; // A ledger that disagrees with itself waits for a person.
     await append(tx,{allocationId:c.allocation_id,transactionId:c.id,entryType:'capital_released',cashDelta:format(-proceeds),cause:`redemption_settled:${c.id}`,sourceKind:'member_instruction',sourceRef:c.id,occurredAt:now,metadata:{redemption:true,proceedsUsd:format(proceeds)}},now);
     await tx.query(`UPDATE strategy_allocations SET allocation_value=$2,updated_at=$3${stop} WHERE id=$1`,[c.allocation_id,format(remaining),now]);
     return true;
    });
    if(released)settled++;
   }
   return {settled};
  },
  /** Every selling closure whose legs all settled is released (sold), or failed with the first leg's code. */
  async settleClosures():Promise<{sold:number;failed:number}>{
   const selling=await database.use(async db=>(await db.query<{allocation_id:string;decided_at:Date|null}>(`SELECT allocation_id,decided_at FROM strategy_allocation_closures WHERE status='selling' LIMIT 200`)).rows);
   let sold=0,failed=0;
   for(const s of selling){
    const outcome=await atomic(async(tx,now)=>{
     if((await tx.query(`SELECT 1 FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='exit' AND outcome IS NULL AND pending_reason IS NOT NULL LIMIT 1`,[s.allocation_id])).rows.length)return null;
     const legs=(await tx.query<{status:string;failure_code:string|null}>(`SELECT status,failure_code FROM strategy_executions WHERE allocation_id=$1 AND kind='liquidate' AND ($2::timestamptz IS NULL OR created_at>=$2)`,[s.allocation_id,s.decided_at])).rows;
     if(legs.some(l=>(OPEN_EXECUTION_STATES as readonly string[]).includes(l.status)))return null;
     const failure=legs.find(l=>l.status==='failed'||l.status==='cancelled');
     if(failure){await tx.query(`UPDATE strategy_allocation_closures SET status='failed',failure_code=$2,updated_at=$3 WHERE allocation_id=$1`,[s.allocation_id,failure.failure_code??failure.status,now]);return 'failed' as const;}
     try{await release(tx,s.allocation_id,'close_sold',now);}catch(error){if(error instanceof InstructionConflict&&error.code==='bucket_has_open_execution')return null;if(error instanceof InstructionConflict&&error.code==='crypto_units_remaining'){await tx.query(`UPDATE strategy_allocation_closures SET status='failed',failure_code=$2,updated_at=$3 WHERE allocation_id=$1`,[s.allocation_id,error.code,now]);return 'failed' as const;}throw error;}
     await tx.query(`UPDATE strategy_allocation_closures SET status='sold',completed_at=$2,updated_at=$2 WHERE allocation_id=$1`,[s.allocation_id,now]);
     return 'sold' as const;
    });
    if(outcome==='sold')sold++;else if(outcome==='failed')failed++;
   }
   return {sold,failed};
  },
 };
 return api;
}
