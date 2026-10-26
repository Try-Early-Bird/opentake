// The holdings shape the strategy panel renders; OSS maps its local
// allocations onto it (strategies/follow-data.ts).
import type { Position } from '../portfolio/types';
export { freeBuyingPower } from '../portfolio/free-buying-power';

/**
 * Shape of GET /api/strategy-holdings as consumed by the desktop. Only the
 * fields the portfolio screen needs are typed; the rest stays opaque.
 */
export interface StrategyHolding {
  bucket: { id: string; status: string };
  strategy: {
    id: string;
    slug: string;
    displayName: string;
    description: string | null;
    iconUrl: string | null;
  };
  allocation: {
    sequence: number;
    weights: Array<{ symbol: string; weightPercent: number }>;
    cashPercent: number;
  } | null;
  valuation: {
    complete: boolean;
    currency: string;
    cash: string;
    totalValue: string | null;
  };
  /** The bucket's own shares per symbol; the own-holdings endpoint adds value and P&L on those shares. */
  positions: Array<{
    symbol: string;
    quantity: string;
    markPrice?: string | null;
    value?: string | null;
    costBasis?: string;
    unrealized?: string | null;
    realized?: string;
  }>;
  /** Recent plans that placed legs, newest first. */
  rebalances?: Array<{ on: string; trigger: string; legs: number }>;
  /** The newest failed leg while nothing has been planned since; retryAt is the scheduler's next automatic attempt. */
  lastFailure?: { symbol: string | null; code: string; at: string | null; retryAt: string | null } | null;
  /** When queued orders go out, while the market is closed: the next regular session's open. */
  ordersOpenAt?: string | null;
  /** The planner is holding this investment for a reason that needs no one, and when it looks again. */
  waiting?: { reason: string; until: string | null } | null;
  /** Orders working right now: the strategy is mid-trade and nothing else may run. */
  openExecutions?: number;
  /**
   * How closely the bucket holds what the strategy holds, and what it is
   * missing. `replication_limited` means a holding is absent with no order
   * working on it, so that share of the member's money is sitting as cash.
   */
  replication?: {
    state: 'initializing' | 'synchronized' | 'constrained' | 'replication_limited';
    missingSymbols: string[];
    /** Of those, the ones Robinhood will not trade right now; the strategy skips them until it can. */
    untradableSymbols: string[];
  };
  /**
   * A sale the member made in Robinhood that reached this investment's
   * shares and waits on them: keep following with what is left, top it back
   * up, or close.
   */
  outsideSale?: OutsideSale | null;
  /** Cash this investment held that left the account, waiting on the member. */
  outsideCash?: OutsideCash | null;
  /** Set once the bucket is being taken apart (strategy archived, or closed by the member). */
  closure?: BucketClosureState | null;
}

export interface OutsideSale {
  caseId: string;
  symbol: string;
  soldQuantity: string | null;
  soldAt: string | null;
  proceeds: string | null;
  /** How much of the sale came out of the member's own shares. */
  ownShares: string | null;
  /** This investment's share of what is missing. */
  strategyShares: string | null;
  /** `lots`: Robinhood's records settled which investment; `proportional`: split by size; `member`: as the member set it. */
  method: 'lots' | 'proportional' | 'member';
  others: Array<{ bucketId: string; strategyName: string; shares: string | null }>;
  /** Whether the member may still move the split between investments. */
  editable: boolean;
  /** What buying the missing shares back would cost. */
  restoreAmount: string | null;
}

export type ClosureStatus = 'awaiting' | 'selling' | 'held' | 'sold' | 'failed';
export type ClosureReason = 'archive' | 'close';

export interface BucketClosureState {
  reason: ClosureReason;
  status: ClosureStatus;
  /** Symbols the member chose to sell; null until decided, empty for hold-all. */
  sellSymbols: string[] | null;
  /** When the take was archived or the close was asked for. */
  openedAt?: string;
  /** Why the last sell could not be planned or placed, when it failed. */
  failureCode?: string | null;
}

/** One closure, as GET /api/me/bucket-closures reports it. */
export interface BucketClosure {
  id: string;
  bucketId: string;
  bucketStatus: string;
  reason: ClosureReason;
  strategy: { id: string; slug: string; displayName: string; iconUrl: string | null };
  openedAt: string;
  status: ClosureStatus;
  sellSymbols: string[] | null;
  decidedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
}

/** True while the member still has to choose (or a sell failed and they can retry). */
export function closureNeedsDecision(status: ClosureStatus | undefined): boolean {
  return status === 'awaiting' || status === 'failed';
}

/** Short state for badges and rows. */
export function closureLabel(closure: BucketClosureState, positionCount?: number): string {
  const archived = closure.reason === 'archive';
  switch (closure.status) {
    case 'awaiting': return 'Archived · decide';
    case 'failed': return 'Sell failed · decide';
    case 'selling': {
      const selling = closure.sellSymbols?.length ?? 0;
      return positionCount !== undefined && selling > 0 && selling < positionCount ? `Selling ${selling} of ${positionCount}…` : 'Selling…';
    }
    case 'held': return archived ? 'Archived · held' : 'Closed · held';
    case 'sold': return archived ? 'Archived · sold' : 'Closed · sold';
  }
}

/** Buckets that still hold something on the member's behalf. */
export function activeStrategyHoldings(holdings: readonly StrategyHolding[]): StrategyHolding[] {
  return holdings
    // A draft is an attempt that was never activated, not an investment;
    // showing it would offer Deposit on nothing.
    .filter((holding) => holding.bucket.status !== 'detached' && holding.bucket.status !== 'closed' && holding.bucket.status !== 'draft')
    .sort((left, right) => Number(right.valuation.totalValue ?? 0) - Number(left.valuation.totalValue ?? 0));
}

/** One account's positions outside every strategy, as the API computed them. */
export interface SelfDirectedAccount {
  accountId: string;
  asOf: string | null;
  /** Cash strategies on this account hold in their ledgers, not free to trade. */
  reservedCash: string;
  positions: Position[];
}

/** The largest weights plus cash, for a one-line "major allocation" summary. */
export function majorAllocations(
  allocation: StrategyHolding['allocation'],
  limit = 4,
): Array<{ label: string; percent: number }> {
  if (allocation == null) return [];
  const top = [...allocation.weights]
    .sort((left, right) => right.weightPercent - left.weightPercent)
    .slice(0, limit)
    .map((weight) => ({ label: weight.symbol, percent: weight.weightPercent }));
  const shown = top.reduce((sum, item) => sum + item.percent, 0);
  const other = 100 - allocation.cashPercent - shown;
  if (other > 0) top.push({ label: `${allocation.weights.length - top.length} others`, percent: other });
  if (allocation.cashPercent > 0) top.push({ label: 'Cash', percent: allocation.cashPercent });
  return top;
}

/** "scheduled", "new allocation", "AAPL drifted 5 pts": why a rebalance ran, for a member. */
export function rebalanceTriggerLabel(trigger: string | null): string {
  if (trigger === null) return '';
  if (trigger.startsWith('drift:')) {
    const [, symbol, points] = trigger.split(':');
    return `${symbol} drifted ${points} pts`;
  }
  return { schedule: 'scheduled', drift: 'drift', scheduled: 'scheduled', republish: 'new allocation', activation: 'first buys', manual: 'manual' }[trigger] ?? trigger;
}

/**
 * A strategy investment as another member's profile reports it. `strategy`
 * is null when the viewer may not see that strategy: the API folds every
 * such investment into one entry with the combined value and no holdings.
 */
export interface ProfileStrategyHolding {
  bucket: { id: string; status: string };
  strategy: StrategyHolding['strategy'] | null;
  allocation: StrategyHolding['allocation'];
  valuation: StrategyHolding['valuation'];
  positions: Array<{ symbol: string; quantity: string }>;
  closure?: StrategyHolding['closure'];
}

export const PRIVATE_STRATEGY_ID = 'private';

/** The profile shape as a holding the position rows can draw; a hidden strategy becomes an unnamed row. */
export function strategyHoldingFromProfile(holding: ProfileStrategyHolding): StrategyHolding {
  return {
    bucket: holding.bucket,
    strategy: holding.strategy ?? {
      id: PRIVATE_STRATEGY_ID,
      slug: PRIVATE_STRATEGY_ID,
      displayName: 'Private take',
      description: 'A take this member has not shared.',
      iconUrl: null,
    },
    allocation: holding.allocation,
    valuation: holding.valuation,
    positions: holding.positions,
    closure: holding.closure ?? null,
  };
}

export interface OutsideCash {
  caseId: string;
  detectedAt: string;
  accountCash: string | null;
  strategiesCash: string;
  /** This investment's share of the missing cash. */
  strategyAmount: string | null;
  method: 'lots' | 'proportional' | 'member';
  others: Array<{ bucketId: string; strategyName: string; amount: string | null }>;
  editable: boolean;
}
