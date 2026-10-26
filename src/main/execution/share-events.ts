import { decimalToScaledInteger, scaledIntegerToDecimal } from "../allocations/decimal";
import type { DailyClose } from "../strategies/model-valuation";

// Share-count events from Robinhood's own closes. For one symbol and day, the raw close divided by the
// split-adjusted close is the product of every share-count event after that
// day, so it is 1 when nothing has happened since. The step between two
// consecutive days is the factor of an event effective on the later day.
// Pure: no database or provider imports, so the verified cases are unit
// tested directly.

const SCALE = 10n ** 18n;

/** A ratio step within this relative distance of 1 is no event. Adjusted prices come back rounded to six decimals. */
export const NO_EVENT_TOLERANCE = 0.002;
/** A step within this relative distance of a simple fraction is that fraction. */
export const SNAP_TOLERANCE = 0.002;
/** The smaller side of a simple fraction is at most this. */
const MAX_SMALL_SIDE = 10;
/** The larger side of a simple fraction is at most this (1-for-1000 reverse splits happen). */
const MAX_LARGE_SIDE = 1000;
/**
 * A raw day-over-day move at least this large, with no ratio step, on the
 * newest bar looks like a split Robinhood has not adjusted for yet. The
 * strategy waits a night rather than value it. Real moves this large also
 * trip it, but only while they are the newest bar, so they cost one night.
 */
export const UNCONFIRMED_FALL = 0.55;
export const UNCONFIRMED_RISE = 1.8;

export interface ShareEventStep {
  /** Effective day: the first day on the new share basis. */
  day: string;
  previousDay: string;
  /** Old ratio over new ratio, as a decimal string: 10 for a 10-for-1, 0.1 for a 1-for-10. */
  observedStep: string;
  kind: "split" | "unclassified";
  /** Set for a split; null when the step is not a simple fraction. */
  splitTo: number | null;
  splitFrom: number | null;
}

export interface ShareEventReading {
  events: ShareEventStep[];
  /**
   * The newest day, when it looks like an event Robinhood has not settled:
   * a split-sized raw move with no ratio step, or adjusted history that
   * already disagrees with raw on the newest bar.
   */
  unconfirmedOn: string | null;
  /** Days present in both series. Fewer than two means nothing could be read. */
  comparedDays: number;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** The simplest fraction `to / from` within tolerance of `step`, or null when none is simple. */
export function snapToSimpleFraction(step: number): { splitTo: number; splitFrom: number } | null {
  if (!Number.isFinite(step) || step <= 0) return null;
  const candidates: { splitTo: number; splitFrom: number }[] = [];
  const consider = (to: number, from: number) => {
    if (to < 1 || from < 1 || to > MAX_LARGE_SIDE || from > MAX_LARGE_SIDE) return;
    if (Math.min(to, from) > MAX_SMALL_SIDE) return;
    if (Math.abs(to / from - step) / step > SNAP_TOLERANCE) return;
    const divisor = greatestCommonDivisor(to, from);
    const reduced = { splitTo: to / divisor, splitFrom: from / divisor };
    if (reduced.splitTo === reduced.splitFrom) return;
    candidates.push(reduced);
  };
  for (let small = 1; small <= MAX_SMALL_SIDE; small += 1) {
    consider(Math.round(step * small), small);
    consider(small, Math.round(small / step));
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => (left.splitTo + left.splitFrom) - (right.splitTo + right.splitFrom));
  return candidates[0]!;
}

function positive(value: string): bigint | null {
  try {
    const scaled = decimalToScaledInteger(value);
    return scaled > 0n ? scaled : null;
  } catch {
    return null;
  }
}

/** A scaled ratio as a float, for classification only; factors applied to money are integers. */
function asNumber(scaled: bigint): number {
  return Number(scaled) / 1e18;
}

/**
 * Reads share-count events from raw and split-adjusted daily closes for one
 * symbol over the same days. Days missing from either side are ignored.
 */
export function readShareEvents(
  raw: readonly DailyClose[],
  adjusted: readonly DailyClose[],
): ShareEventReading {
  const adjustedByDay = new Map(adjusted.map((close) => [close.day, close.close]));
  const joined: { day: string; raw: bigint; ratio: bigint }[] = [];
  for (const close of [...raw].sort((left, right) => left.day.localeCompare(right.day))) {
    const rawClose = positive(close.close);
    const adjustedValue = adjustedByDay.get(close.day);
    const adjustedClose = adjustedValue === undefined ? null : positive(adjustedValue);
    if (rawClose === null || adjustedClose === null) continue;
    joined.push({ day: close.day, raw: rawClose, ratio: rawClose * SCALE / adjustedClose });
  }
  const events: ShareEventStep[] = [];
  let unconfirmedOn: string | null = null;
  for (let index = 1; index < joined.length; index += 1) {
    const previous = joined[index - 1]!;
    const current = joined[index]!;
    const stepScaled = previous.ratio * SCALE / current.ratio;
    const step = asNumber(stepScaled);
    if (Math.abs(step - 1) <= NO_EVENT_TOLERANCE) {
      const newest = index === joined.length - 1;
      const rawMove = asNumber(current.raw * SCALE / previous.raw);
      if (newest && (rawMove <= UNCONFIRMED_FALL || rawMove >= UNCONFIRMED_RISE)) unconfirmedOn = current.day;
      continue;
    }
    const fraction = snapToSimpleFraction(step);
    events.push({
      day: current.day,
      previousDay: previous.day,
      observedStep: scaledIntegerToDecimal(stepScaled),
      kind: fraction === null ? "unclassified" : "split",
      splitTo: fraction?.splitTo ?? null,
      splitFrom: fraction?.splitFrom ?? null,
    });
  }
  const newest = joined.at(-1);
  if (newest !== undefined && Math.abs(asNumber(newest.ratio) - 1) > NO_EVENT_TOLERANCE) {
    unconfirmedOn = newest.day;
  }
  return { events, unconfirmedOn, comparedDays: joined.length };
}

function scale(value: string, numerator: number, denominator: number): string {
  const scaled = decimalToScaledInteger(value);
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  // Half-up at 18 decimals, the precision the model stores.
  return scaledIntegerToDecimal((2n * scaled * top + bottom) / (2n * bottom));
}

/**
 * Moves one valuation row's holding of `symbol` onto the new share basis
 * (`apply`) or back (`undo`): units scale by `splitTo / splitFrom` and the
 * recorded close by the inverse, so the row's value, unit value, and cash do
 * not change. Returns null when the row does not hold the symbol.
 */
export function rescaleValuationRow(
  row: { units: Readonly<Record<string, string>>; closes: Readonly<Record<string, string>> },
  symbol: string,
  factor: { splitTo: number; splitFrom: number },
  direction: "apply" | "undo",
): { units: Record<string, string>; closes: Record<string, string> } | null {
  const units = row.units[symbol];
  if (units === undefined) return null;
  const [unitTop, unitBottom] = direction === "apply"
    ? [factor.splitTo, factor.splitFrom]
    : [factor.splitFrom, factor.splitTo];
  const close = row.closes[symbol];
  return {
    units: { ...row.units, [symbol]: scale(units, unitTop, unitBottom) },
    closes: close === undefined ? { ...row.closes } : { ...row.closes, [symbol]: scale(close, unitBottom, unitTop) },
  };
}

/** Statuses that keep strategies holding the symbol from being valued past the event. */
export const BLOCKING_SHARE_EVENT_STATUSES = [
  "pending_review",
  "apply_requested",
  "dismiss_requested",
  "undo_requested",
] as const;
