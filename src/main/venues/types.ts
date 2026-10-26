import type {TradingSessionPolicy} from '../trading/session-policy';

// What a venue module provides. The shared core (loops, account
// queues, action jobs, capabilities) only talks to these interfaces, never to a
// named venue. Optional parts are capability answers, not errors.

export type AssetClass='equity'|'etf'|'crypto'|'option';
export const actionKinds=['rebalance_to_target','buy','trim','exit','deploy_cash','reduce','agent_run','take_change'] as const;
export type ActionKind=typeof actionKinds[number];
export type ActionOrigin='rule'|'agent'|'member';
export type ActionState='queued'|'running'|'waiting'|'succeeded'|'blocked'|'failed'|'needs_attention'|'cancelled';
export type WaitingFor='approval'|'market_open'|'funds'|'inputs'|'account'|'take';

export interface VenueProfile{
 id:string;
 label:string;
 assetClasses:readonly AssetClass[];
 orderTypes:readonly ('market'|'limit')[];
 /** Asset classes that accept fractional quantities. */
 fractional:readonly AssetClass[];
 /** Asset classes that accept a quote-currency amount instead of a quantity. */
 notional:readonly AssetClass[];
 quoteCurrencies:readonly string[];
 /** Trading calendar per asset class; throws for a combination the venue does not trade. */
 session(assetClass:AssetClass):TradingSessionPolicy;
 /** Default loop interval and per-call limits; the venue queue enforces one call at a time. */
 limits:{callTimeoutMs:number;schedulerIntervalMs:number};
}

export interface ActionJob<Input=unknown,State=Record<string,unknown>>{
 id:string;kind:ActionKind;origin:ActionOrigin;originId:string;
 takeId:string|null;accountId:string|null;venue:string|null;
 input:Input;state:ActionState;waitingFor:WaitingFor|null;reason:string|null;
 attempts:number;adapterState:State;createdAt:Date;updatedAt:Date;
}

/** What one step of an adapter decided. `state` and `waiting` write the job;
 *  `adapterState` replaces the adapter's own progress (review ids, phases). */
export type ActionOutcome<State=Record<string,unknown>>=
 |{state:'running';adapterState?:State;retryInMs?:number}
 |{state:'waiting';waitingFor:WaitingFor;reason?:string;adapterState?:State;retryInMs?:number}
 |{state:'succeeded'|'blocked'|'failed'|'needs_attention'|'cancelled';reason:string;adapterState?:State};

export interface ActionContext{signal:AbortSignal;now:()=>number}

/** One action on one venue. `advance` moves the adapter's own phases (prepare,
 *  confirm, submit, follow up) one step from its saved state. It must never resend
 *  an order whose outcome is unknown; report `needs_attention` instead. */
export interface ActionAdapter<Input=unknown,State=Record<string,unknown>>{
 kind:ActionKind;
 parse(input:unknown):Input;
 advance(job:ActionJob<Input,State>,context:ActionContext):Promise<ActionOutcome<State>>;
 /** Member cancellation. Releases what was reserved and keeps what already filled. */
 cancel?(job:ActionJob<Input,State>,context:ActionContext):Promise<ActionOutcome<State>>;
 /** Called once per job after a restart, before its next step. */
 recover?(job:ActionJob<Input,State>,context:ActionContext):Promise<void>;
}

/** The seam over each venue's Take ledger (claims, reservations, attribution). */
export interface TakeLedger{
 holdings(takeId:string,accountId:string):Promise<{asset:string;quantity:string}[]>;
}

export interface VenueModule{
 profile:VenueProfile;
 adapters:Partial<Record<ActionKind,ActionAdapter<any,any>>>;
 ledger?:TakeLedger;
}
