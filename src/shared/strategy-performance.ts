import type {BasketSpec} from './strategies';
import type {MarketSession} from './market-series';

// The strategy page's chart data. Computed locally from the strategy's versions, the allocation
// ledgers and the connection's price history.

export type PerformanceRange='1d'|'1w'|'1m'|'3m'|'1y'|'3y'|'5y'|'all';
export type PerformanceBasis='model'|'actual';
type RebalanceRule=BasketSpec['rebalance'];

export interface PerformanceStat {
 source:'backtested'|'live';asOf:string;startedAt:string|null;
 allTimeReturnPercent:string|null;oneDayReturnPercent:string|null;
}

/** What the chart shows for a hovered point, beside the index. */
export interface PointReadout {
 /** Each holding's price at the point, by symbol. */
 prices?:Record<string,number>;
 /** Actual basis: what your allocations were worth at the point. */
 value?:number;
}

export interface StrategyPerformance {
 unavailableReason?:string;
 strategyId:string;range:PerformanceRange;
 /** `model`: the strategy's versions marked to closes. `actual`: its allocations' real ledgers, value-weighted. */
 basis:PerformanceBasis;
 /** Whether an actual line exists: at least one allocation has traded. */
 actualAvailable:boolean;
 /** Allocations in the actual line; 0 on the model basis. */
 investors:number;
 /** The first fill in any allocation; null when none has traded. */
 actualSince:string|null;
 /** Today's actual line on the 1d range, as a unit index starting at 100 on yesterday's close. */
 intraday:{sessionDate:string|null;dayStart:string|null;dayEnd:string|null;points:({t:string;c:string;s:MarketSession}&PointReadout)[]}|null;
 rebalance:RebalanceRule;
 lastRebalancedAt:string|null;
 dividends:'reinvested_at_current_yield'|'excluded';
 points:({day:string;unitValue:string;source:'backtested'|'live'}&PointReadout)[];
 stats:PerformanceStat[];
}

/** Money in or out at a moment, as the chart draws it. Locally only your own. */
export interface StrategyMarker {
 at:string;direction:'in'|'out';party:'owner'|'viewer'|'others';members:number;amount:string|null;currency?:string;
 kinds:Partial<Record<'invested'|'deposit'|'withdrew'|'closed',number>>;
 breakdown?:{kind:'invested'|'deposit'|'withdrew'|'closed';members:number;amount:string|null}[];
}
