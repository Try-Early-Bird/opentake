import type { SeriesPoint } from '../market-series';

// Benchmarks drawn beside a strategy's unit-index line: a symbol (SPY by
// default) or another strategy, rebased to 100 on the strategy's first day so
// both lines start together and read as cumulative return. Pure helpers here;
// the page fetches and renders.

export type Benchmark =
  | { kind: 'symbol'; symbol: string; label: string; detail?: string }
  | { kind: 'strategy'; strategyId: string; label: string; detail?: string };

export const DEFAULT_BENCHMARKS: readonly Benchmark[] = [{ kind: 'symbol', symbol: 'SPY', label: 'SPY', detail: 'S&P 500' }];

const STORAGE_KEY = 'strategy.benchmarks';

/** Distinct, deliberately muted strokes so the strategy line stays the focus. */
export const BENCHMARK_COLORS = ['#9ca3af', '#a78bfa', '#f59e0b', '#38bdf8'] as const;

export function benchmarkKey(benchmark: Benchmark): string {
  return benchmark.kind === 'symbol' ? `symbol:${benchmark.symbol}` : `strategy:${benchmark.strategyId}`;
}

export function loadBenchmarks(): Benchmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [...DEFAULT_BENCHMARKS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_BENCHMARKS];
    // Sets saved before detail text existed get the default's back.
    const withDetail = (item: Benchmark): Benchmark => {
      if (item.detail !== undefined) return item;
      const known = DEFAULT_BENCHMARKS.find((candidate) => benchmarkKey(candidate) === benchmarkKey(item));
      return known === undefined ? item : { ...item, detail: known.detail };
    };
    return parsed.map((item) => item as Benchmark).filter((item): item is Benchmark =>
      typeof item === 'object' && item !== null
      && ((item as Benchmark).kind === 'symbol' ? typeof (item as { symbol?: unknown }).symbol === 'string' : typeof (item as { strategyId?: unknown }).strategyId === 'string')
      && typeof (item as { label?: unknown }).label === 'string').map(withDetail);
  } catch {
    return [...DEFAULT_BENCHMARKS];
  }
}

export function saveBenchmarks(benchmarks: readonly Benchmark[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(benchmarks));
  } catch {
    // Per-device convenience only.
  }
}

/** One close per day (YYYY-MM-DD, UTC date of the bar), the last bar winning, sorted by day. */
export function dailyClosesOf(points: readonly SeriesPoint[]): { day: string; close: number }[] {
  const byDay = new Map<string, number>();
  for (const point of points) {
    const close = Number(point.c);
    const ms = Date.parse(point.t);
    if (!Number.isFinite(close) || !Number.isFinite(ms)) continue;
    byDay.set(new Date(ms).toISOString().slice(0, 10), close);
  }
  return [...byDay].sort(([left], [right]) => left.localeCompare(right)).map(([day, close]) => ({ day, close }));
}

/**
 * Reinvests a trailing yield (percent per year) into a close series as a
 * steady accrual, the same approximation the API applies to the strategy's
 * holdings, so a symbol benchmark compares like for like.
 */
export function withReinvestedYield(
  closes: readonly { day: string; close: number }[],
  yieldPercent: number | null,
): { day: string; close: number }[] {
  if (yieldPercent === null || !(yieldPercent > 0) || closes.length === 0) return [...closes];
  const sorted = [...closes].sort((left, right) => left.day.localeCompare(right.day));
  let factor = 1;
  let previous: string | null = null;
  return sorted.map((point) => {
    if (previous !== null) {
      const days = Math.max(0, Math.round((Date.parse(`${point.day}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`)) / 86_400_000));
      factor *= 1 + (yieldPercent / 100) * (days / 365);
    }
    previous = point.day;
    return { day: point.day, close: point.close * factor };
  });
}

export interface LineStats {
  /** Cumulative return over the line, percent. */
  returnPercent: number;
  /** Compound annual rate, null under a year. */
  annualizedPercent: number | null;
  /** Largest peak-to-trough fall, percent (a positive number). */
  maxDrawdownPercent: number;
  /** Annualized standard deviation of period returns, percent; null with too few points. */
  volatilityPercent: number | null;
}

/** Return, yearly rate, drawdown, and volatility for a line of {day, value} points sorted by day. */
export function lineStats(points: readonly { day: string; value: number }[]): LineStats | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (!(first.value > 0)) return null;
  const returnPercent = (last.value / first.value - 1) * 100;
  const years = (Date.parse(`${last.day}T00:00:00Z`) - Date.parse(`${first.day}T00:00:00Z`)) / (365.25 * 86_400_000);
  const annualizedPercent = years >= 1 ? ((last.value / first.value) ** (1 / years) - 1) * 100 : null;
  let peak = first.value;
  let maxDrawdown = 0;
  for (const point of points) {
    if (point.value > peak) peak = point.value;
    const drawdown = peak > 0 ? (1 - point.value / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  // Period returns, annualized by the median spacing between points (daily or weekly bars).
  const returns: number[] = [];
  const gaps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (previous.value > 0) returns.push(current.value / previous.value - 1);
    gaps.push((Date.parse(`${current.day}T00:00:00Z`) - Date.parse(`${previous.day}T00:00:00Z`)) / 86_400_000);
  }
  let volatilityPercent: number | null = null;
  if (returns.length >= 10) {
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const medianGap = [...gaps].sort((left, right) => left - right)[Math.floor(gaps.length / 2)] ?? 1;
    const periodsPerYear = medianGap >= 5 ? 52 : 252;
    volatilityPercent = Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
  }
  return { returnPercent, annualizedPercent, maxDrawdownPercent: maxDrawdown, volatilityPercent };
}

/**
 * Rebases a benchmark onto the strategy's days: for each strategy day, the
 * benchmark's last close on or before it, scaled so the first matched day is
 * 100. Days before the benchmark has any close are skipped, so a young ETF
 * starts its line late rather than flat.
 */
export function alignBenchmark(
  strategyDays: readonly string[],
  closes: readonly { day: string; close: number }[],
): { day: string; value: number }[] {
  if (closes.length === 0) return [];
  const sorted = [...closes].sort((left, right) => left.day.localeCompare(right.day));
  const result: { day: string; value: number }[] = [];
  let index = 0;
  let base: number | null = null;
  for (const day of [...strategyDays].sort()) {
    while (index + 1 < sorted.length && sorted[index + 1]!.day <= day) index += 1;
    const match = sorted[index];
    if (match === undefined || match.day > day || match.close <= 0) continue;
    if (base === null) base = match.close;
    result.push({ day, value: (match.close / base) * 100 });
  }
  return result;
}
