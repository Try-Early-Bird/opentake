// The seams between the planner, the executor/scheduler
// and the member instructions. Each side is built against these types; the
// background host wires the implementations together. Schema: migration 34
// (execution/migration.ts).

/** Why a planning pass ran. */
export type PlanTrigger='activation'|'deposit'|'republish'|'scheduled'|'drift'|'manual'|'instruction'|'liquidation';

/** One symbol in a plan, as the panel's plan view shows it. */
export interface PlanSleeve {
 symbol:string;targetWeightPercent:number;currentWeightPercent:number;currentValueUsd:string;
 disposition:'order'|'skip'|'defer';side:'buy'|'sell'|null;amount:string|null;reason:string|null;
 /** The order's USD notional on both sides (amount is shares for a sell); null when not an order. */
 notionalUsd?:string|null;
}

/** What a planning pass decided. */
export interface PlanResult {
 allocationId:string;planId:string|null;
 disposition:'planned'|'deferred'|'skipped'|'up_to_date'|'failed';
 /** Planning reason codes: market_closed, open_execution, reconciliation_required, retry_backoff,
  *  fresh_position_snapshot_required, model_stale, symbol_not_tradable, symbol_blocked, incomplete_basket,
  *  daily_notional_limit, correction_not_improving, insufficient_bucket_cash, lots_unsettled, ... */
 reasonCode:string|null;
 /** strategy_executions rows created with status 'queued'. */
 executionIds:string[];
 sleeves:PlanSleeve[];
}

/** Deploy cash: buys only, toward the target, spending at most `cashCapUsd`.
 *  `maxNotionalUsd` refuses (reason `notional_cap`) a plan whose orders total more, e.g. an approved rule trade. */
export interface PlanOptions {buysOnly?:boolean;cashCapUsd?:string;maxNotionalUsd?:string}

export interface Planner {
 preflight?(input:{accountId:string;amount:string;strategyId?:string;allocationId?:string},query?:Pick<import('../database-client').DatabaseClient,'query'>):Promise<import('./preflight').PreflightResult>;
 /** Rebalance or invest toward target weights; writes queued legs and a plan row. Never places orders. */
 planAllocation(allocationId:string,trigger:PlanTrigger,options?:PlanOptions):Promise<PlanResult>;
 /** Sell legs for a redemption (amount) or a closure (symbols; null = everything sellable). */
 planLiquidation(allocationId:string,input:{kind:'redeem'|'liquidate';transactionId:string;amount?:string;symbols?:string[]|null}):Promise<PlanResult>;
}

/** Outcome of sending an allocation's queued legs. */
export interface ExecutionOutcome {
 allocationId:string;placed:number;failed:number;
 /** Set when nothing was sent: awaiting_confirmation, market_closed, placement_unresolved, insufficient_buying_power, ... */
 parkedReason:string|null;
}

export interface Executor {
 /** Reviews and places queued legs, sells first; respects confirm_trades, market hours and buying power. */
 executeAllocation(allocationId:string,options?:{confirmed?:boolean}):Promise<ExecutionOutcome>;
 /** After a sync: advances legs from their order intents and fills (submitted -> filled/failed/...). */
 settleLegs(accountId:string):Promise<void>;
}

/** Trading preferences; confirmTrades defaults to false. */
export interface TradingPreferences {confirmTrades:boolean;blockedSymbols:string[]}
