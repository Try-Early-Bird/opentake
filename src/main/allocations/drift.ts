import { decimalToScaledInteger, multiplyDecimals, scaledIntegerToDecimal } from "./decimal";

// How far a allocation sits from its applied strategy version.
// The measure is active share: half the sum of the absolute differences
// between the allocated's weights and the target's, cash included. It reads as
// the share of capital that would have to move to be back in line, which is
// what makes it a control rather than a statistic -- a correction plan is
// valid only if it lowers this number. It is not the return-based measure
// usually called tracking error, which needs a time series and answers a
// different question.
// Both sides must be weighed at the same marks, or the number reports the
// price move between two valuations rather than any drift.

export interface DriftPosition {
  symbol: string;
  valueUsd: string;
}

export interface SymbolDrift {
  symbol: string;
  /** Allocated weight in basis points of the allocation, cash excluded from the symbol itself. */
  allocatedBps: number;
  targetBps: number;
  /** Allocated minus target: positive means the allocation holds too much of it. */
  differenceBps: number;
}

export interface DriftMeasure {
  /** Half the sum of absolute differences, in basis points of the allocation. */
  totalBps: number;
  /** The single worst holding, cash included, and by how much. */
  maxSymbol: string | null;
  maxBps: number;
  /** Every symbol either side holds, worst first. */
  symbols: SymbolDrift[];
  /** Cash is a position for this purpose: holding cash the strategy does not is drift. */
  cash: { allocatedBps: number; targetBps: number; differenceBps: number };
}

function bps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number(part * 10_000n / whole);
}

/**
 * Weighs a allocation against the target it follows. Values on both sides must
 * come from the same marks; the caller is responsible for that, and the
 * valuation job passes the target's own closes for both.
 */
export function measureDrift(input: {
  allocated: { positions: readonly DriftPosition[]; cashUsd: string };
  target: { positions: readonly DriftPosition[]; cashUsd: string };
}): DriftMeasure {
  const allocatedValues = new Map(input.allocated.positions.map((position) => [
    position.symbol,
    decimalToScaledInteger(position.valueUsd),
  ]));
  const targetValues = new Map(input.target.positions.map((position) => [
    position.symbol,
    decimalToScaledInteger(position.valueUsd),
  ]));
  const allocatedCash = decimalToScaledInteger(input.allocated.cashUsd);
  const targetCash = decimalToScaledInteger(input.target.cashUsd);
  const allocatedTotal = [...allocatedValues.values()].reduce((sum, value) => sum + value, allocatedCash);
  const targetTotal = [...targetValues.values()].reduce((sum, value) => sum + value, targetCash);
  if (allocatedTotal <= 0n || targetTotal <= 0n) {
    return {
      totalBps: 0,
      maxSymbol: null,
      maxBps: 0,
      symbols: [],
      cash: { allocatedBps: 0, targetBps: 0, differenceBps: 0 },
    };
  }

  const symbols = [...new Set([...allocatedValues.keys(), ...targetValues.keys()])].sort();
  const measured: SymbolDrift[] = symbols.map((symbol) => {
    const allocatedBps = bps(allocatedValues.get(symbol) ?? 0n, allocatedTotal);
    const targetBps = bps(targetValues.get(symbol) ?? 0n, targetTotal);
    return { symbol, allocatedBps, targetBps, differenceBps: allocatedBps - targetBps };
  });
  const cash = {
    allocatedBps: bps(allocatedCash, allocatedTotal),
    targetBps: bps(targetCash, targetTotal),
    differenceBps: bps(allocatedCash, allocatedTotal) - bps(targetCash, targetTotal),
  };

  const absolute = [...measured.map((entry) => Math.abs(entry.differenceBps)), Math.abs(cash.differenceBps)];
  const totalBps = Math.round(absolute.reduce((sum, value) => sum + value, 0) / 2);
  const worst = measured.reduce<SymbolDrift | null>(
    (highest, entry) =>
      highest === null || Math.abs(entry.differenceBps) > Math.abs(highest.differenceBps) ? entry : highest,
    null,
  );
  const worstIsCash = worst === null || Math.abs(cash.differenceBps) > Math.abs(worst.differenceBps);
  return {
    totalBps,
    maxSymbol: worstIsCash ? "CASH" : worst.symbol,
    maxBps: worstIsCash ? Math.abs(cash.differenceBps) : Math.abs(worst.differenceBps),
    symbols: [...measured].sort((left, right) => Math.abs(right.differenceBps) - Math.abs(left.differenceBps)),
    cash,
  };
}

/**
 * Values share counts at one set of closes, which is how both sides of the
 * measure are put on the same marks. A symbol the closes do not cover falls
 * back to the mark supplied with it; a symbol with neither is returned as
 * unpriced, and the caller decides whether the measure is worth taking.
 */
export function positionsAtCloses(
  positions: ReadonlyMap<string, { quantity: string; markPriceUsd?: string }>,
  closes: Readonly<Record<string, string>>,
): { positions: DriftPosition[]; unpriced: string[] } {
  const priced: DriftPosition[] = [];
  const unpriced: string[] = [];
  for (const [symbol, position] of positions) {
    const close = closes[symbol] ?? position.markPriceUsd;
    if (close === undefined || decimalToScaledInteger(close) === 0n) {
      unpriced.push(symbol);
      continue;
    }
    priced.push({ symbol, valueUsd: multiplyDecimals(position.quantity, close) });
  }
  return { positions: priced, unpriced: unpriced.sort() };
}

/** The target portfolio as dollar positions: its units at its own closes. */
export function targetPositionsAtCloses(
  units: Readonly<Record<string, string>>,
  closes: Readonly<Record<string, string>>,
): { positions: DriftPosition[]; unpriced: string[] } {
  return positionsAtCloses(
    new Map(Object.entries(units).map(([symbol, quantity]) => [symbol, { quantity }])),
    closes,
  );
}

/** Percent, to two places, for a figure carried in basis points. */
export function driftPercent(bps: number): number {
  return Math.round(bps) / 100;
}

/** Dollars of the allocation that would have to change hands to close the gap. */
export function driftValueUsd(totalBps: number, allocationValueUsd: string): string {
  return scaledIntegerToDecimal(
    decimalToScaledInteger(allocationValueUsd) * BigInt(Math.round(totalBps)) / 10_000n,
  );
}

/** An order the planner would place, as sizing describes it. */
export type ProjectedOrder =
  | { symbol: string; side: "buy"; dollarAmount: string }
  | { symbol: string; side: "sell"; quantity: string };

/**
 * The allocation as the orders would leave it, at the marks the orders were sized
 * against: a buy adds the shares its dollars buy at the mark and takes the
 * dollars from cash, a sell removes the shares and adds what they fetch. It
 * is the input to the correction gate:
 * a plan is measured on the set that would actually execute -- skipped and
 * deferred sleeves already absent -- so a rebalance whose executable half
 * only raises cash is seen for what it is before any order is placed.
 *
 * A buy of a symbol the allocation does not yet hold needs a price to turn into
 * shares; the caller supplies one per symbol, and a symbol with none is
 * reported rather than guessed.
 */
export function projectPositionsAfterOrders(input: {
  positions: ReadonlyMap<string, { quantity: string; markPriceUsd?: string }>;
  cashUsd: string;
  orders: readonly ProjectedOrder[];
  /** Marks for symbols not yet held, and for any held without one. */
  marks?: Readonly<Record<string, string>>;
}): { positions: Map<string, { quantity: string; markPriceUsd?: string }>; cashUsd: string; unpriced: string[] } {
  const SCALE = 10n ** 18n;
  const quantities = new Map<string, bigint>();
  const marks = new Map<string, bigint>();
  for (const [symbol, position] of input.positions) {
    quantities.set(symbol, decimalToScaledInteger(position.quantity));
    const mark = position.markPriceUsd ?? input.marks?.[symbol];
    if (mark !== undefined) marks.set(symbol, decimalToScaledInteger(mark));
  }
  let cash = decimalToScaledInteger(input.cashUsd);
  const unpriced = new Set<string>();
  for (const order of input.orders) {
    const mark = marks.get(order.symbol) ?? (input.marks?.[order.symbol] === undefined ? undefined : decimalToScaledInteger(input.marks[order.symbol]!));
    if (mark === undefined || mark <= 0n) {
      unpriced.add(order.symbol);
      continue;
    }
    marks.set(order.symbol, mark);
    const held = quantities.get(order.symbol) ?? 0n;
    if (order.side === "buy") {
      const dollars = decimalToScaledInteger(order.dollarAmount);
      quantities.set(order.symbol, held + dollars * SCALE / mark);
      cash -= dollars;
    } else {
      const shares = decimalToScaledInteger(order.quantity);
      const sold = shares > held ? held : shares;
      quantities.set(order.symbol, held - sold);
      cash += sold * mark / SCALE;
    }
  }
  const positions = new Map<string, { quantity: string; markPriceUsd?: string }>();
  for (const [symbol, quantity] of quantities) {
    if (quantity <= 0n) continue;
    const mark = marks.get(symbol);
    positions.set(symbol, mark === undefined
      ? { quantity: scaledIntegerToDecimal(quantity) }
      : { quantity: scaledIntegerToDecimal(quantity), markPriceUsd: scaledIntegerToDecimal(mark) });
  }
  return { positions, cashUsd: scaledIntegerToDecimal(cash < 0n ? 0n : cash), unpriced: [...unpriced].sort() };
}

/**
 * The least a plan must improve drift by to count, in basis points. Each
 * holding's share is truncated to whole basis points, so a set that is
 * exactly neutral -- selling an overweight holding into cash the target does
 * not hold -- could read one or two points better from truncation alone and
 * pass (found building the 2026-09-24 case as a test, 2026-09-29). Any order
 * worth the provider minimum moves drift by far more than this.
 */
export const MIN_CORRECTION_BPS = 5;

/**
 * Whether a plan is worth placing: the set that would execute must leave the
 * allocation closer to the target than it sits now, by more than rounding. Equal
 * is not closer -- an order that moves nothing measurable is churn.
 */
export function correctionImproves(before: Pick<DriftMeasure, "totalBps">, after: Pick<DriftMeasure, "totalBps">): boolean {
  return before.totalBps - after.totalBps >= MIN_CORRECTION_BPS;
}
