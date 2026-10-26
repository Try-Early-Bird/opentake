// Venue minimum/headroom are required inputs; follower-only policy is excluded.
const INTERNAL_SCALE = 18;
const INTERNAL_FACTOR = 10n ** BigInt(INTERNAL_SCALE);

export const DEFAULT_REBALANCE_THRESHOLD_BPS = 25;

/**
 * Margin a share-denominated sell keeps above the provider's minimum. The
 * quantity is floored and priced at the snapshot's mark; the fill is at the
 * live price. A $1.00 AMZN sell reached Robinhood at $0.99 and was refused
 * (2026-09-30), so a partial sell must clear the minimum by this much.
 */


/** The smallest notional a partial, share-denominated sell is sized to. */
export function sellFloorNotional(minimum: bigint, headroomBps: number): bigint {
  return minimum * (10_000n + BigInt(headroomBps)) / 10_000n;
}

function parseDecimal(value: string): bigint {
  const match = /^(0|[1-9][0-9]{0,19})(?:\.([0-9]{1,18}))?$/u.exec(value);
  if (match === null) throw new Error(`Invalid non-negative decimal: ${value}`);
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").slice(0, INTERNAL_SCALE)
    .padEnd(INTERNAL_SCALE, "0");
  return whole * INTERNAL_FACTOR + BigInt(fraction || "0");
}

function formatDecimal(value: bigint, scale = INTERNAL_SCALE): string {
  if (value < 0n) throw new Error("Cannot format a negative decimal");
  const factor = 10n ** BigInt(scale);
  const internalValue = scale === INTERNAL_SCALE
    ? value
    : value / (10n ** BigInt(INTERNAL_SCALE - scale));
  const whole = internalValue / factor;
  const fraction = (internalValue % factor).toString().padStart(scale, "0")
    .replace(/0+$/u, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

function multiply(left: bigint, right: bigint): bigint {
  return left * right / INTERNAL_FACTOR;
}

function divide(left: bigint, right: bigint): bigint {
  if (right === 0n) throw new Error("Cannot divide by zero");
  return left * INTERNAL_FACTOR / right;
}

function floorToScale(value: bigint, scale: number): bigint {
  const factor = 10n ** BigInt(INTERNAL_SCALE - scale);
  return value / factor * factor;
}

export interface TargetSizingInput {
  /** Size a buy down to the cash on hand rather than deferring, when that still clears the minimum. */
  capBuyToCash?: boolean;
  /** Fresh venue quantity step; legacy equity callers retain six-place shares. */
  quantityIncrement?: string;
  symbol: string;
  /** Whole-percent target for this symbol from the allocation snapshot; 0 exits. */
  targetWeightPercent: number;
  allocationValueUsd: string;
  currentInstrumentValueUsd: string;
  currentQuantity: string;
  availableCashUsd: string;
  markPriceUsd: string | null;
  maximumOrderNotionalUsd: string;
  rebalanceThresholdBps?: number;
  minimumOrderNotionalUsd: string;
  sellMinimumHeadroomBps: number;
}

export type TargetSizingDecision =
  | {
      disposition: "order";
      targetValueUsd: string;
      currentValueUsd: string;
      deltaValueUsd: string;
      order: {
        symbol: string;
        side: "buy";
        type: "market";
        dollarAmount: string;
      } | {
        symbol: string;
        side: "sell";
        type: "market";
        quantity: string;
      };
    }
  | {
      disposition: "skip" | "defer";
      reason:
        | "within_rebalance_threshold"
        | "below_minimum_order"
        | "insufficient_allocation_cash"
        | "order_notional_limit"
        | "missing_mark_price"
        | "insufficient_attributed_quantity";
      targetValueUsd: string;
      currentValueUsd: string;
      deltaValueUsd: string;
    };

/** Pure fixed-point sizing of one symbol toward its allocation weight. */
export function sizeTargetAllocation(
  input: TargetSizingInput,
): TargetSizingDecision {
  if (!Number.isInteger(input.sellMinimumHeadroomBps) || input.sellMinimumHeadroomBps < 0 || input.sellMinimumHeadroomBps > 10_000 ||
    !Number.isInteger(input.rebalanceThresholdBps ?? DEFAULT_REBALANCE_THRESHOLD_BPS) ||
    (input.rebalanceThresholdBps ?? DEFAULT_REBALANCE_THRESHOLD_BPS) < 0 ||
    (input.rebalanceThresholdBps ?? DEFAULT_REBALANCE_THRESHOLD_BPS) > 10_000) throw new Error("Invalid sizing policy");
  const targetBps = Number.isFinite(input.targetWeightPercent)
    ? Math.round(input.targetWeightPercent * 100)
    : Number.NaN;
  if (!Number.isInteger(targetBps) || Math.abs(input.targetWeightPercent * 100 - targetBps) > 1e-6 ||
    targetBps < 0 || targetBps > 10_000) {
    throw new Error("target weight must be a percent between 0 and 100 with at most two decimals");
  }
  const allocationValue = parseDecimal(input.allocationValueUsd);
  const currentValue = parseDecimal(input.currentInstrumentValueUsd);
  const currentQuantity = parseDecimal(input.currentQuantity);
  const quantityIncrement = parseDecimal(input.quantityIncrement ?? '0.000001');
  if (quantityIncrement <= 0n) throw new Error('Positive quantity increment required');
  const availableCash = parseDecimal(input.availableCashUsd);
  const maximumOrderNotional = parseDecimal(input.maximumOrderNotionalUsd);
  const minimumOrderNotional = parseDecimal(
    input.minimumOrderNotionalUsd,
  );
  if (minimumOrderNotional <= 0n || maximumOrderNotional <= 0n) throw new Error("Positive order limits required");
  const thresholdBps = BigInt(
    input.rebalanceThresholdBps ?? DEFAULT_REBALANCE_THRESHOLD_BPS,
  );
  const targetValue = allocationValue * BigInt(targetBps) / 10_000n;
  const threshold = allocationValue * thresholdBps / 10_000n;
  const isBuy = targetValue >= currentValue;
  const delta = isBuy ? targetValue - currentValue : currentValue - targetValue;
  const base = {
    targetValueUsd: formatDecimal(targetValue),
    currentValueUsd: formatDecimal(currentValue),
    deltaValueUsd: formatDecimal(delta),
  };

  if (delta <= threshold) {
    return { disposition: "skip", reason: "within_rebalance_threshold", ...base };
  }
  if (delta < minimumOrderNotional) {
    return { disposition: "skip", reason: "below_minimum_order", ...base };
  }
  if (delta > maximumOrderNotional) {
    return { disposition: "defer", reason: "order_notional_limit", ...base };
  }
  if (isBuy) {
    // A sleeve short by more than the cash on hand is bought up to the cash
    // when the caller allows it: part of the way toward target is closer
    // than none of the way, and the rest follows when sells settle or money
    // arrives. The caller chooses whether partial cash sizing is appropriate;
    // a buy that would fall under the venue minimum is skipped.
    const affordable = delta > availableCash && input.capBuyToCash === true && availableCash >= minimumOrderNotional
      ? availableCash
      : delta;
    if (affordable > availableCash) {
      return { disposition: "defer", reason: "insufficient_allocation_cash", ...base };
    }
    const dollarAmount = floorToScale(affordable, 2);
    if (dollarAmount < minimumOrderNotional || dollarAmount === 0n) {
      return { disposition: "skip", reason: "below_minimum_order", ...base };
    }
    return {
      disposition: "order",
      ...base,
      order: {
        symbol: input.symbol,
        side: "buy",
        type: "market",
        dollarAmount: formatDecimal(dollarAmount, 2),
      },
    };
  }

  if (input.markPriceUsd === null) {
    return { disposition: "defer", reason: "missing_mark_price", ...base };
  }
  const markPrice = parseDecimal(input.markPriceUsd);
  if (markPrice === 0n) {
    return { disposition: "defer", reason: "missing_mark_price", ...base };
  }
  // A full exit sells the exact attributed quantity rather than a price-derived
  // estimate, so dust never remains from rounding. A partial sell is skipped
  // unless it clears the minimum with headroom, since its fill price is not
  // the mark it was sized at.
  const fullExit = input.targetWeightPercent === 0;
  const requestedQuantity = fullExit ? currentQuantity : divide(delta, markPrice);
  const quantity = requestedQuantity / quantityIncrement * quantityIncrement;
  const floor = fullExit ? minimumOrderNotional : sellFloorNotional(minimumOrderNotional, input.sellMinimumHeadroomBps);
  if (quantity === 0n || multiply(quantity, markPrice) < floor) {
    return { disposition: "skip", reason: "below_minimum_order", ...base };
  }
  if (quantity > currentQuantity) {
    return {
      disposition: "defer",
      reason: "insufficient_attributed_quantity",
      ...base,
    };
  }
  return {
    disposition: "order",
    ...base,
    order: {
      symbol: input.symbol,
      side: "sell",
      type: "market",
      quantity: formatDecimal(quantity),
    },
  };
}

/**
 * Puts the cents that per-leg rounding dropped back into the plan. Each buy is floored to cents,
 * so a basket's requested notionals can add up to less than the member's
 * money less the cash the strategy keeps -- a dollar short across fifty
 * holdings. The remainder goes to the largest legs, a cent each, because a
 * cent is the smallest thing the provider will take and the largest holding
 * is the one least distorted by it.
 *
 * Nothing is added beyond `availableCashUsd`: conserving the request must
 * never ask for money the allocation does not have. Returns the orders unchanged
 * when they already sum to the intended total or exceed it.
 */
export function conserveRequestedNotionals(
  orders: ReadonlyArray<{ symbol: string; dollarAmount: string }>,
  intendedTotalUsd: string,
  availableCashUsd: string,
): { symbol: string; dollarAmount: string }[] {
  const adjusted = orders.map((order) => ({ ...order, amount: parseDecimal(order.dollarAmount) }));
  const requested = adjusted.reduce((total, order) => total + order.amount, 0n);
  const intended = floorToScale(parseDecimal(intendedTotalUsd), 2);
  const available = floorToScale(parseDecimal(availableCashUsd), 2);
  const ceiling = intended < available ? intended : available;
  let remainder = ceiling - requested;
  if (remainder <= 0n || adjusted.length === 0) {
    return orders.map((order) => ({ symbol: order.symbol, dollarAmount: order.dollarAmount }));
  }
  const cent = 10n ** BigInt(INTERNAL_SCALE - 2);
  const byLargest = [...adjusted].sort((left, right) =>
    right.amount === left.amount ? left.symbol.localeCompare(right.symbol) : (right.amount > left.amount ? 1 : -1));
  for (let index = 0; remainder >= cent && index < byLargest.length * 100; index += 1) {
    byLargest[index % byLargest.length]!.amount += cent;
    remainder -= cent;
  }
  return adjusted.map((order) => ({ symbol: order.symbol, dollarAmount: formatDecimal(order.amount, 2) }));
}

/**
 * What a deposit's buys should add up to: `N` dollars contributed and `C` kept as cash means the
 * buys sum to `N - C`. Here that is read from the allocation rather than the
 * deposit, because by the time the planner runs the deposit is just cash:
 * the cash on hand less what the strategy keeps at the allocation's new size.
 *
 * It is capped at what the underweight sleeves are actually short. A deposit
 * buys only those; an overweight sleeve waits for the rebalance, and the
 * money it would have taken stays as cash by design, not by rounding. So the
 * conservation pass gives back the cents per-leg flooring dropped and never
 * a dollar more.
 */
export function contributionIntendedNotional(input: {
  cashUsd: string;
  /** The strategy's explicit cash share at the allocation's value after the deposit. */
  keptCashUsd: string;
  /** Each buy's unfloored shortfall against its target. */
  buyShortfallsUsd: readonly string[];
}): string {
  const spendable = parseDecimal(input.cashUsd) - parseDecimal(input.keptCashUsd);
  const short = input.buyShortfallsUsd.reduce((total, value) => total + parseDecimal(value), 0n);
  const intended = short < spendable ? short : spendable;
  return formatDecimal(intended < 0n ? 0n : intended, 2);
}

