import {riskEligibility} from '../trading/risk';
type StrategyAllocationWeight = { symbol: string; weightPercent: number };

import {
  decimalToScaledInteger,
  scaledIntegerToDecimal,
} from "../allocations/decimal";

// Pure guardrail math for follower buckets: the dynamic activation floor
// (reachability), the daily notional cap, and the loss limit.

/** Robinhood's minimum fractional order, matching the planner's default. */
export const MINIMUM_ORDER_NOTIONAL_USD = "1";
/** Headroom so the smallest leg is not on the minimum at activation. */
export const ACTIVATION_HEADROOM = 2n;

const SCALE = 10n ** 18n;

function wholeDollarsUp(value: bigint): bigint {
  return (value + SCALE - 1n) / SCALE * SCALE;
}

export interface MinimumAllocationOptions {
  minimumOrderNotionalUsd?: string;
  headroom?: bigint;
}

/**
 * Smallest allocation at which every leg of the snapshot clears the minimum
 * order with headroom: `headroom × minimum / smallest weight`. Weights are
 * percents to two decimals. Whole dollars, rounded up.
 */
export function minimumAllocationFor(
  weights: readonly StrategyAllocationWeight[],
  options: MinimumAllocationOptions = {},
): string {
  const minimumOrder = decimalToScaledInteger(options.minimumOrderNotionalUsd ?? MINIMUM_ORDER_NOTIONAL_USD);
  const headroom = options.headroom ?? ACTIVATION_HEADROOM;
  const positive = weights.filter((weight) => weight.weightPercent > 0);
  const smallestBps = positive
    .map((weight) => Math.round(weight.weightPercent * 100))
    .reduce((low, bps) => Math.min(low, bps), 10_000);
  const floor = minimumOrder * headroom * 10_000n / BigInt(Math.max(1, smallestBps));
  return scaledIntegerToDecimal(wholeDollarsUp(floor));
}

/** True when the allocation is below the floor for this snapshot. */
export function allocationBelowMinimum(
  allocationValue: string,
  weights: readonly StrategyAllocationWeight[],
  options: MinimumAllocationOptions = {},
): { minimum: string; below: boolean } {
  const minimum = minimumAllocationFor(weights, options);
  return {
    minimum,
    below: decimalToScaledInteger(allocationValue) < decimalToScaledInteger(minimum),
  };
}

/** True when today's placed notional plus this group's would exceed the cap. */
export function dailyNotionalExceeded(
  maxDailyNotional: string | null,
  placedTodayUsd: string,
  plannedUsd: string,
): boolean {
  if (maxDailyNotional === null) return false;
  return !riskEligibility({currency:'USD',maxDailyNotional,placedToday:placedTodayUsd,planned:plannedUsd}).ok;
}

/** True when the bucket has lost more than its limit against capital allocated. */
export function lossLimitReached(
  maxLoss: string | null,
  capitalAllocatedUsd: string,
  bucketValueUsd: string,
): boolean {
  if (maxLoss === null) return false;
  return !riskEligibility({currency:'USD',maxLoss,capital:capitalAllocatedUsd,value:bucketValueUsd}).ok;
}
