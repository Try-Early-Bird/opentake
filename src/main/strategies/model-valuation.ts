// Model valuation.
import type { BasketSpec } from "../../shared/strategies";
type StrategyAllocationWeight = { symbol: string; weightPercent: number };
type StrategyRebalanceSchedule = BasketSpec["rebalance"]["schedule"];
type StrategyRebalanceRule = BasketSpec["rebalance"];

import {
  decimalToScaledInteger,
  scaledIntegerToDecimal,
} from "../allocations/decimal";

// The canonical model portfolio: a strategy is valued as a unit
// index. At its first publication one unit is worth 100; the allocation's
// weights become units of each symbol at that day's close plus explicit cash.
// Each later day marks those units to close. When a new allocation is
// published the model rebalances at that day's close with no change in unit
// value, so performance is continuous across rebalances. Days before the
// first publication can be valued the same way and are labelled backtested.

export interface ModelAllocation {
  id: string;
  sequence: number;
  weights: readonly StrategyAllocationWeight[];
  cashPercent: number;
  /** Eastern trading date the allocation took effect (its publication day). */
  effectiveOn: string;
}

/**
 * Platform default when neither the strategy nor the operator names a rule:
 * buy and hold. Returning to authored weights on a calendar sells winners to
 * buy laggards, which most authors do not mean by "25% each" (product
 * decision 2026-09-16); weights drift until the author
 * publishes a new allocation. A schedule is an explicit opt-in, and drift
 * bands stay off unless an operator default or the rule turns them on.
 */
export const DEFAULT_REBALANCE_RULE: StrategyRebalanceRule = { schedule: "never", driftBandPoints: null, driftBandRelative: null };
export const REBALANCE_SCHEDULES: readonly StrategyRebalanceSchedule[] = ["daily", "monthly", "quarterly", "annual", "never"];
/** Supported local authoring schedules. */
export const PRODUCTION_REBALANCE_SCHEDULES: readonly StrategyRebalanceSchedule[] = ["daily", "monthly", "quarterly", "annual", "never"];
/** Band limits the API accepts, in percentage points and percent of target. */
export const DRIFT_BAND_POINTS_RANGE = [1, 25] as const;
export const DRIFT_BAND_RELATIVE_RANGE = [5, 50] as const;

/** Normalises a stored rule (object, or a bare schedule from older rows) to the full shape, or null when absent or malformed. */
export function normalizeRebalanceRule(value: unknown, fallback: StrategyRebalanceRule = DEFAULT_REBALANCE_RULE): StrategyRebalanceRule | null {
  if (typeof value === "string") {
    return REBALANCE_SCHEDULES.includes(value as StrategyRebalanceSchedule)
      ? { ...fallback, schedule: value as StrategyRebalanceSchedule }
      : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!REBALANCE_SCHEDULES.includes(record.schedule as StrategyRebalanceSchedule)) return null;
  const band = (raw: unknown, range: readonly [number, number]): number | null | undefined => {
    if (raw === null) return null;
    if (raw === undefined) return undefined;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= range[0] && raw <= range[1] ? raw : undefined;
  };
  const points = band(record.driftBandPoints, DRIFT_BAND_POINTS_RANGE);
  const relative = band(record.driftBandRelative, DRIFT_BAND_RELATIVE_RANGE);
  return {
    schedule: record.schedule as StrategyRebalanceSchedule,
    driftBandPoints: points === undefined ? fallback.driftBandPoints : points,
    driftBandRelative: relative === undefined ? fallback.driftBandRelative : relative,
  };
}

/**
 * The rule in force for a strategy: its own policy, else the operator's
 * default (a `strategy.rebalance_default` runtime setting), else the platform
 * default.
 */
export function rebalanceRuleOf(
  policy: { rebalance?: unknown } | null | undefined,
  operatorDefault?: unknown,
): StrategyRebalanceRule {
  const fallback = normalizeRebalanceRule(operatorDefault) ?? DEFAULT_REBALANCE_RULE;
  return normalizeRebalanceRule(policy?.rebalance, fallback) ?? fallback;
}

/**
 * The model portfolio's current weights from a stored valuation day: each
 * symbol's units marked at that day's close over the model's total value,
 * in percent to two decimals, totalling exactly 100 with cash. This is what a
 * new subscriber should buy between rebalances (sized to every current
 * exposure): the published weights drift with prices, and under buy
 * and hold they never return. Null when the row cannot be valued (a missing
 * close, or no value at all).
 */
export function modelWeightsFromValuation(row: {
  units: Record<string, string>;
  closes: Record<string, string>;
  cash: string;
}): { weights: { symbol: string; weightPercent: number }[]; cashPercent: number } | null {
  const values = new Map<string, bigint>();
  let total = decimalToScaledInteger(row.cash);
  for (const [symbol, units] of Object.entries(row.units)) {
    const close = row.closes[symbol];
    if (close === undefined) return null;
    const value = decimalToScaledInteger(units) * decimalToScaledInteger(close) / SCALE;
    values.set(symbol, value);
    total += value;
  }
  if (total <= 0n) return null;
  const bps = new Map<string, number>();
  let assigned = 0;
  for (const [symbol, value] of values) {
    const share = Number(value * 10_000n / total);
    bps.set(symbol, share);
    assigned += share;
  }
  const cashBps = Number(decimalToScaledInteger(row.cash) * 10_000n / total);
  assigned += cashBps;
  // Flooring leaves a few basis points; the largest sleeve takes them so the result totals 100.
  const largest = [...bps.entries()].sort((left, right) => right[1] - left[1])[0];
  if (largest !== undefined) bps.set(largest[0], largest[1] + (10_000 - assigned));
  return {
    weights: [...bps.entries()]
      .filter(([, share]) => share > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([symbol, share]) => ({ symbol, weightPercent: share / 100 })),
    cashPercent: (largest === undefined ? cashBps + (10_000 - assigned) : cashBps) / 100,
  };
}

/** True when a sleeve's current weight (percent) is outside the rule's bands around its target. */
export function outOfBand(currentPercent: number, targetPercent: number, rule: Pick<StrategyRebalanceRule, "driftBandPoints" | "driftBandRelative">): boolean {
  const drift = Math.abs(currentPercent - targetPercent);
  if (rule.driftBandPoints !== null && drift > rule.driftBandPoints) return true;
  if (rule.driftBandRelative !== null && targetPercent > 0 && drift > targetPercent * (rule.driftBandRelative / 100)) return true;
  return false;
}

/**
 * Trading days on which the model returns to target weights: the first
 * trading day of each period under the rule, decided against the full
 * trading calendar so an incremental run (one day at a time) agrees with a
 * full backtest. The calendar's first day is never a rebalance day; the model
 * is already at target when it starts.
 */
export function scheduledRebalanceDays(
  tradingCalendar: readonly string[],
  rule: StrategyRebalanceSchedule | StrategyRebalanceRule,
): Set<string> {
  const schedule = typeof rule === "string" ? rule : rule.schedule;
  const result = new Set<string>();
  if (schedule === "never") return result;
  const periodOf = (day: string): string => {
    const year = day.slice(0, 4);
    const month = Number(day.slice(5, 7));
    if (schedule === "daily") return day;
    if (schedule === "annual") return year;
    if (schedule === "monthly") return `${year}-${day.slice(5, 7)}`;
    return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  };
  let previous: string | null = null;
  for (const day of [...tradingCalendar].sort()) {
    const period = periodOf(day);
    if (previous !== null && period !== previous) result.add(day);
    previous = period;
  }
  return result;
}

/**
 * The most recent scheduled rebalance day on or before `today` for a schedule,
 * decided against the trading calendar (first trading day of the period), or
 * null when the schedule has none in the calendar.
 */
export function lastRebalanceDayFor(
  tradingCalendar: readonly string[],
  schedule: StrategyRebalanceSchedule,
  today: string,
): string | null {
  const days = [...scheduledRebalanceDays(tradingCalendar, schedule)].filter((day) => day <= today);
  return days.length === 0 ? null : days[days.length - 1]!;
}

/**
 * Buckets due for a scheduled rebalance: the strategy's schedule has a
 * rebalance day on or before today that the bucket has not reached (its last
 * completed plan is older, or it was activated before that day and never
 * planned). Pure, so the calendar rule is unit tested without a database.
 */
export function dueForScheduledRebalance(
  bucket: { lastRebalancedOn: string | null; activatedAt: string | null },
  rule: StrategyRebalanceRule,
  calendar: readonly string[],
  today: string,
): boolean {
  if (rule.schedule === "never") return false;
  const due = lastRebalanceDayFor(calendar, rule.schedule, today);
  if (due === null) return false;
  if (bucket.lastRebalancedOn !== null) return bucket.lastRebalancedOn < due;
  return bucket.activatedAt !== null && activatedDate(bucket.activatedAt) < due;
}

/** The sleeve furthest out of band, or null when every sleeve is within the rule's bands. */
export function driftBreach(
  sleeves: ReadonlyArray<{ symbol: string; targetWeightPercent: number; currentWeightPercent: number }>,
  rule: StrategyRebalanceRule,
): { symbol: string; points: number } | null {
  let worst: { symbol: string; points: number } | null = null;
  for (const sleeve of sleeves) {
    if (!outOfBand(sleeve.currentWeightPercent, sleeve.targetWeightPercent, rule)) continue;
    const points = Math.round((sleeve.currentWeightPercent - sleeve.targetWeightPercent) * 100) / 100;
    if (worst === null || Math.abs(points) > Math.abs(worst.points)) worst = { symbol: sleeve.symbol, points };
  }
  return worst;
}

/** Eastern calendar date of an ISO instant, without importing the sessions clock here. */
function activatedDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export interface DailyClose {
  /** Eastern trading date, YYYY-MM-DD. */
  day: string;
  close: string;
}

/** A symbol that stopped trading: the sleeve is closed to cash at `lastClose` on `day`. */
export interface DelistedSymbol {
  day: string;
  lastClose: string;
}

export interface ModelValuationRow {
  allocationId: string;
  valuedOn: string;
  source: "backtested" | "live";
  unitValue: string;
  cash: string;
  units: Record<string, string>;
  closes: Record<string, string>;
}

export interface ModelState {
  allocationId: string;
  unitValue: string;
  cash: string;
  units: Record<string, string>;
}

const SCALE = 10n ** 18n;
export const INITIAL_UNIT_VALUE = "100";

function format(value: bigint): string {
  return scaledIntegerToDecimal(value < 0n ? 0n : value);
}

/**
 * Values a strategy over `days`, continuing from `previous` when provided.
 * Days whose closes are not all known are skipped rather than estimated.
 */
export function computeModelValuations(input: {
  allocations: readonly ModelAllocation[];
  closesBySymbol: ReadonlyMap<string, readonly DailyClose[]>;
  /** Sorted trading days to value, YYYY-MM-DD. */
  days: readonly string[];
  previous?: ModelState | null;
  /** Assets whose missing daily close must never carry forward. */
  exactCloseSymbols?: ReadonlySet<string>;
  /** Days the model returns to the current allocation's weights (see scheduledRebalanceDays). */
  rebalanceDays?: ReadonlySet<string>;
  /** Drift bands: any day a sleeve is out of band after marking to close, the model rebalances at that close. */
  driftBands?: Pick<StrategyRebalanceRule, "driftBandPoints" | "driftBandRelative">;
  /**
   * Trailing dividend yield per symbol, percent per year. Reinvested as a
   * steady accrual: each day a holding's units grow by yield × elapsed
   * days / 365, which approximates a reinvestment plan when only the current
   * yield is known.
   */
  dividendYieldPercent?: ReadonlyMap<string, number>;
  /** The day the previous state was valued on, so the first accrual spans the right gap. */
  previousDay?: string;
  /**
   * Symbols that no longer trade. From `day` on, the symbol needs no close:
   * any units held convert to cash at `lastClose` (an estimate; a merger pays
   * about that, OTC or bankruptcy less) and an allocation naming the symbol
   * leaves its weight in cash.
   */
  delisted?: ReadonlyMap<string, DelistedSymbol>;
}): ModelValuationRow[] {
  const allocations = [...input.allocations].sort((left, right) => left.sequence - right.sequence);
  if (allocations.length === 0 || input.days.length === 0) return [];
  const firstLiveDay = allocations[0]!.effectiveOn;

  // Close lookup with carry-forward: the last close on or before the day.
  const sorted = new Map<string, DailyClose[]>();
  for (const [symbol, closes] of input.closesBySymbol) {
    sorted.set(symbol, [...closes].sort((left, right) => left.day.localeCompare(right.day)));
  }
  const cursors = new Map<string, number>();
  const closeOn = (symbol: string, day: string): bigint | null => {
    const closes = sorted.get(symbol);
    if (closes === undefined) return null;
    let index = cursors.get(symbol) ?? 0;
    while (index + 1 < closes.length && closes[index + 1]!.day <= day) index += 1;
    cursors.set(symbol, index);
    const close = closes[index];
    if (close === undefined || close.day > day || (input.exactCloseSymbols?.has(symbol) && close.day !== day)) return null;
    return decimalToScaledInteger(close.close);
  };

  const allocationOn = (day: string): ModelAllocation => {
    let current = allocations[0]!;
    for (const allocation of allocations) {
      if (allocation.effectiveOn <= day) current = allocation;
    }
    return current;
  };

  let state: { allocationId: string; unitValue: bigint; cash: bigint; units: Map<string, bigint> } | null =
    input.previous === undefined || input.previous === null
      ? null
      : {
          allocationId: input.previous.allocationId,
          unitValue: decimalToScaledInteger(input.previous.unitValue),
          cash: decimalToScaledInteger(input.previous.cash),
          units: new Map(
            Object.entries(input.previous.units).map(([symbol, units]) => [symbol, decimalToScaledInteger(units)]),
          ),
        };

  const dayCount = (from: string, to: string): bigint =>
    BigInt(Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)));
  let lastDay: string | null = input.previous ? (input.previousDay ?? null) : null;

  const rows: ModelValuationRow[] = [];
  for (const day of input.days) {
    const allocation = allocationOn(day);
    const delistedOn = (symbol: string): boolean => {
      const mark = input.delisted?.get(symbol);
      return mark !== undefined && mark.day <= day;
    };
    // A delisted sleeve closes to cash at its last close before anything else that day.
    if (state !== null) {
      for (const [symbol, units] of [...state.units]) {
        const mark = input.delisted?.get(symbol);
        if (mark === undefined || mark.day > day) continue;
        state.cash += units * decimalToScaledInteger(mark.lastClose) / SCALE;
        state.units.delete(symbol);
      }
    }
    // Dividends accrue on the units held coming into the day, before marking.
    if (state !== null && lastDay !== null && input.dividendYieldPercent !== undefined) {
      const elapsed = dayCount(lastDay, day);
      if (elapsed > 0n) {
        for (const [symbol, units] of state.units) {
          const yieldPct = input.dividendYieldPercent.get(symbol);
          if (yieldPct === undefined || yieldPct <= 0) continue;
          const yieldBps = BigInt(Math.round(yieldPct * 100));
          state.units.set(symbol, units + units * yieldBps * elapsed / (10_000n * 365n));
        }
      }
    }
    const symbols = [...new Set([
      ...allocation.weights.map((weight) => weight.symbol),
      ...(state?.units.keys() ?? []),
    ])].filter((symbol) => !delistedOn(symbol)).sort();
    const closes = new Map<string, bigint>();
    let complete = true;
    for (const symbol of symbols) {
      const close = closeOn(symbol, day);
      if (close === null || close === 0n) {
        complete = false;
        break;
      }
      closes.set(symbol, close);
    }
    if (!complete) continue;

    let unitValue: bigint;
    if (state === null) {
      unitValue = decimalToScaledInteger(INITIAL_UNIT_VALUE);
    } else {
      unitValue = state.cash;
      for (const [symbol, units] of state.units) {
        unitValue += units * closes.get(symbol)! / SCALE;
      }
    }

    // Drift check on the marked position: a sleeve's share of unit value against its target weight.
    let drifted = false;
    if (state !== null && input.driftBands !== undefined && unitValue > 0n) {
      for (const weight of allocation.weights) {
        if (delistedOn(weight.symbol)) continue;
        const units = state.units.get(weight.symbol) ?? 0n;
        const currentPercent = Number(units * closes.get(weight.symbol)! * 10_000n / SCALE / unitValue) / 100;
        if (outOfBand(currentPercent, weight.weightPercent, input.driftBands)) {
          drifted = true;
          break;
        }
      }
    }
    const needsRebalance = state === null || state.allocationId !== allocation.id || (input.rebalanceDays?.has(day) ?? false) || drifted;
    let cash = state?.cash ?? 0n;
    let units = state?.units ?? new Map<string, bigint>();
    if (needsRebalance) {
      cash = unitValue * BigInt(Math.round(allocation.cashPercent * 100)) / 10_000n;
      units = new Map();
      for (const weight of allocation.weights) {
        const target = unitValue * BigInt(Math.round(weight.weightPercent * 100)) / 10_000n;
        if (delistedOn(weight.symbol)) {
          // The published weight has nowhere to go until the author republishes.
          cash += target;
          continue;
        }
        units.set(weight.symbol, target * SCALE / closes.get(weight.symbol)!);
      }
    }
    state = { allocationId: allocation.id, unitValue, cash, units };
    lastDay = day;
    rows.push({
      allocationId: allocation.id,
      valuedOn: day,
      source: day < firstLiveDay ? "backtested" : "live",
      unitValue: format(unitValue),
      cash: format(cash),
      units: Object.fromEntries([...units].map(([symbol, value]) => [symbol, format(value)])),
      closes: Object.fromEntries(
        [...units.keys()].map((symbol) => [symbol, format(closes.get(symbol)!)]),
      ),
    });
  }
  return rows;
}

export interface PerformanceStat {
  source: "backtested" | "live";
  asOf: string;
  startedAt: string | null;
  allTimeReturnPercent: string | null;
  oneDayReturnPercent: string | null;
}

function percentChange(from: string, to: string): string {
  const base = decimalToScaledInteger(from);
  if (base === 0n) return "0";
  const delta = (decimalToScaledInteger(to) - base) * 100n * SCALE / base;
  const rounded = delta >= 0n
    ? (delta + 5n * 10n ** 15n) / 10n ** 16n
    : -((-delta + 5n * 10n ** 15n) / 10n ** 16n);
  const whole = rounded / 100n;
  const fraction = (rounded < 0n ? -rounded : rounded) % 100n;
  const sign = rounded < 0n && whole === 0n ? "-" : "";
  return `${sign}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** Summarises one source's rows (sorted by day) into the catalog stat shape. */
export function performanceStat(
  source: "backtested" | "live",
  rows: ReadonlyArray<{ valuedOn: string; unitValue: string }>,
): PerformanceStat | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const previous = rows.length > 1 ? rows[rows.length - 2]! : null;
  return {
    source,
    asOf: `${last.valuedOn}T00:00:00.000Z`,
    startedAt: `${first.valuedOn}T00:00:00.000Z`,
    allTimeReturnPercent: percentChange(first.unitValue, last.unitValue),
    oneDayReturnPercent: previous === null ? null : percentChange(previous.unitValue, last.unitValue),
  };
}
