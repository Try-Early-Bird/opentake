import {z} from 'zod';
import {coinbaseProfile} from './registry';
import type {ActionAdapter,ActionOutcome,VenueModule} from './types';

// Coinbase as a venue module. Its rebalance adapter is the
// existing rule-trade worker step; `strategy_rule_trades` stays the adapter's own
// record (phase, review, approval), and the action job mirrors its lifecycle.

type RuleTradeRow={state:string;reason?:string|null;phase:'initial'|'buy';review_id:string|null;approval_pending:boolean};
export interface RuleTradeStep{
 advance(requestId:string):Promise<RuleTradeRow|null>;
 cancel(requestId:string):Promise<RuleTradeRow|null>;
}
/** Approval and attention are re-checked on these intervals; in-flight orders are
 *  followed up by the post-submit wakes and this backup. */
const APPROVAL_RECHECK_MS=15_000,ATTENTION_RECHECK_MS=60_000,IN_FLIGHT_MS=5_000;

/** How a rule-trade row reads as an action job. */
export function ruleTradeOutcome(row:RuleTradeRow|null):ActionOutcome{
 if(!row)return {state:'failed',reason:'rule_trade_missing'};
 const reason=row.reason&&/^[a-z][a-z0-9_]{1,63}$/.test(row.reason)?row.reason:'unknown';
 switch(row.state){
  case 'completed':return {state:'succeeded',reason};
  case 'blocked':return {state:'blocked',reason};
  // A partial rebalance holds nothing and waits for the member; other attention keeps
  // being re-checked, as the worker always has, until its review closes.
  case 'attention':return row.reason==='partial_rebalance'?{state:'needs_attention',reason}:{state:'waiting',waitingFor:'account',reason,retryInMs:ATTENTION_RECHECK_MS};
  case 'working':
   if(row.approval_pending)return {state:'waiting',waitingFor:'approval',retryInMs:APPROVAL_RECHECK_MS};
   // Sells filled and the buy phase has not been previewed yet: go on at once.
   if(row.phase==='buy'&&!row.review_id)return {state:'running',retryInMs:0};
   return {state:'running',retryInMs:IN_FLIGHT_MS};
  default:return {state:'running',retryInMs:IN_FLIGHT_MS};
 }
}

export function coinbaseRebalanceAdapter(trades:RuleTradeStep,kind:'rebalance_to_target'|'deploy_cash'|'reduce'='rebalance_to_target'):ActionAdapter<Record<string,never>>{
 return {
  kind,
  parse:raw=>z.object({}).strict().parse(raw) as Record<string,never>,
  advance:async job=>ruleTradeOutcome(await trades.advance(job.originId)),
  async cancel(job){
   const row=await trades.cancel(job.originId);
   // Orders already out: the trade keeps running and the member is told by its notice.
   if(row&&['pending','working'].includes(row.state))return ruleTradeOutcome(row);
   return row?.reason==='member_cancelled'?{state:'cancelled',reason:'member_cancelled'}:ruleTradeOutcome(row);
  },
 };
}

export function coinbaseVenue(trades:RuleTradeStep,slots:Pick<VenueModule,'queue'|'approvals'>={}):VenueModule{
 // Deploy cash and reduce run through the same rule-trade worker.
 return {...slots,profile:coinbaseProfile,adapters:{rebalance_to_target:coinbaseRebalanceAdapter(trades),deploy_cash:coinbaseRebalanceAdapter(trades,'deploy_cash'),reduce:coinbaseRebalanceAdapter(trades,'reduce')}};
}
