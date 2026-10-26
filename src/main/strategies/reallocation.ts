import {venueBasket} from '../mixed-execution/basket';
import type { Transaction } from '@electric-sql/pglite';
import { instrumentKey,type BasketSpec } from '../../shared/strategies';
import { MINIMUM_ORDER_NOTIONAL_USD } from '../execution/limits';

// Publish guards for committing a new version of a take that has money in it. Committing
// rebalances those investments, so a version that sells and
// rebuys half or more of what they hold, or that leaves an investment unable to
// hold every holding at Robinhood's $1 minimum, is refused unless the member
// accepts it. A take with no money in it commits whatever it likes.

/** Above this share of an investment's money changing hands, the member says so deliberately. */
export const HIGH_TURNOVER_PERCENT = 50;

export interface FollowerReach { belowMinimum: number; smallestValueUsd: string | null; weightThatFitsPercent: number | null }

export function followerReach(
  weights: readonly { weightPercent: number }[],
  investmentValuesUsd: readonly string[],
  options: { minimumOrderNotionalUsd?: string } = {},
): FollowerReach {
  const minimum = Number(options.minimumOrderNotionalUsd ?? MINIMUM_ORDER_NOTIONAL_USD);
  const smallestWeight = weights.reduce((lowest, weight) => Math.min(lowest, weight.weightPercent), 100);
  if (weights.length === 0 || smallestWeight <= 0) {
    return { belowMinimum: 0, smallestValueUsd: null, weightThatFitsPercent: null };
  }
  const stranded = investmentValuesUsd
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value * smallestWeight / 100 < minimum)
    .sort((left, right) => left - right);
  if (stranded.length === 0) {
    return { belowMinimum: 0, smallestValueUsd: null, weightThatFitsPercent: null };
  }
  const smallest = stranded[0]!;
  // The weight at which the smallest investment's share clears the minimum,
  // rounded up to the hundredth the editor works in.
  const fits = Math.ceil((minimum / smallest) * 100 * 100) / 100;
  return {
    belowMinimum: stranded.length,
    smallestValueUsd: smallest.toFixed(2),
    weightThatFitsPercent: fits > 100 ? null : fits,
  };
}

/**
 * How much of an investment's
 * money changes hands when one basket replaces another, half the sum of the
 * absolute weight differences, cash included.
 */
export function basketTurnoverPercent(
  before: { weights: readonly { symbol: string; weightPercent: number }[]; cashPercent: number },
  after: { weights: readonly { symbol: string; weightPercent: number }[]; cashPercent: number },
): number {
  const of = (side: typeof before): Map<string, number> => {
    const map = new Map<string, number>();
    for (const weight of side.weights) {
      map.set(weight.symbol.toUpperCase(), (map.get(weight.symbol.toUpperCase()) ?? 0) + weight.weightPercent);
    }
    map.set('__cash', side.cashPercent);
    return map;
  };
  const left = of(before);
  const right = of(after);
  const symbols = new Set([...left.keys(), ...right.keys()]);
  const total = [...symbols].reduce(
    (sum, symbol) => sum + Math.abs((right.get(symbol) ?? 0) - (left.get(symbol) ?? 0)),
    0,
  );
  return Math.round(total / 2 * 100) / 100;
}

export interface CommitReview extends FollowerReach {
  /** Active and paused investments in this take: the ones a commit rebalances. */
  investments: number;
  turnoverPercent: number;
  highTurnover: boolean;
}

const percents = (spec: BasketSpec) => ({
  weights: spec.target.weights.map((weight) => ({ symbol: instrumentKey(weight.instrument), weightPercent: weight.bps / 100 })),
  cashPercent: spec.target.cashBps / 100,
});

/** What committing `next` would do to the money in this take, against its committed version. */
export async function commitReview(tx: Pick<Transaction, 'query'>, strategyId: string, currentVersionId: string | null, next: BasketSpec): Promise<CommitReview> {
  const values = (await tx.query<{ value: string }>(`SELECT allocation_value::text AS value FROM strategy_allocations WHERE strategy_id=$1 AND status IN ('active','paused')`, [strategyId])).rows.map((row) => row.value);
  const current = currentVersionId === null ? null
    : (await tx.query<{ spec: BasketSpec }>('SELECT spec FROM strategy_versions WHERE id=$1', [currentVersionId])).rows[0]?.spec ?? null;
  const turnoverPercent = current === null ? 0 : basketTurnoverPercent(percents(current), percents(next));
  const reach = followerReach(percents(next.target.weights.some(w=>w.instrument.venue==='robinhood')?venueBasket(next,'robinhood'):next).weights, values);
  return { investments: values.length, turnoverPercent, highTurnover: values.length > 0 && turnoverPercent >= HIGH_TURNOVER_PERCENT, ...reach };
}
