import type { BasketSpec } from "./strategies";
type StrategyRebalanceRule=BasketSpec["rebalance"];
type StrategyRebalanceSchedule=StrategyRebalanceRule["schedule"];
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

/** Stored basket rule, with the local default for absent fields. */
export function rebalanceRuleOf(policy: { rebalance?: unknown } | null | undefined): StrategyRebalanceRule {
  return normalizeRebalanceRule(policy?.rebalance) ?? DEFAULT_REBALANCE_RULE;
}

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
    if (schedule === "daily") return day;
    const year = day.slice(0, 4);
    const month = Number(day.slice(5, 7));
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

