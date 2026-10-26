import type { EquityBar, EquityQuoteDetail } from "./normalization";
import { subtractUtcMonths } from "./calendar";
import {
  chartTradingDay,
  classifySession,
  isMarketWeekendClosure,
  type MarketSession,
  type TradingDay,
} from "./sessions";

/**
 * Range → bar plan and per-symbol series assembly for the market series
 * endpoint. Mirrors Robinhood's charting: 1D spans the Eastern calendar day
 * (24/5 bars, drawn to now) with the prior regular close as baseline; longer
 * ranges use regular-hours bars with the close before the window as baseline.
 */

export type SeriesRange = "1d" | "1w" | "1m" | "3m" | "1y" | "all";
export type SeriesInterval = "5minute" | "10minute" | "hour" | "day" | "week";
export type SeriesBounds = "24_5" | "regular";

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const seriesIntervalMilliseconds: Record<SeriesInterval, number> = {
  "5minute": 5 * MINUTE,
  "10minute": 10 * MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
};

/** Upstream is re-queried at most this often per market and interval. */
export const seriesRefreshMilliseconds: Record<SeriesInterval, number> = {
  "5minute": MINUTE,
  "10minute": 2 * MINUTE,
  hour: 5 * MINUTE,
  day: 15 * MINUTE,
  week: 60 * MINUTE,
};

export interface SeriesPlan {
  range: SeriesRange;
  interval: SeriesInterval;
  bounds: SeriesBounds;
  /** Left edge of the displayed window; undefined for "all". */
  windowStartMs: number | undefined;
  windowEndMs: number;
  /** Where an uncached fetch starts: the window plus room for the baseline bar. */
  fetchStartMs: number;
  /** The trading day charted for 1D. */
  tradingDay?: TradingDay;
  /** IANA zone the 1D day is framed in (Eastern for longer ranges). */
  timeZone: string;
}

export function seriesPlan(
  range: SeriesRange,
  nowMs: number,
  timeZone: string = "America/New_York",
): SeriesPlan {
  switch (range) {
    case "1d": {
      const day = chartTradingDay(nowMs, timeZone);
      return {
        range,
        timeZone,
        interval: "5minute",
        bounds: "24_5",
        windowStartMs: day.dayStartMs,
        windowEndMs: nowMs,
        // Include the whole previous weekday (from its midnight) so its close
        // is in hand for the baseline and it charts without a gap when it is
        // the fallback day: a market holiday, or today's bars not cached yet.
        fetchStartMs: day.previousDayStartMs,
        tradingDay: day,
      };
    }
    case "1w": {
      const windowStartMs = nowMs - 7 * DAY;
      return {
        range,
        timeZone,
        interval: "10minute",
        bounds: "regular",
        windowStartMs,
        windowEndMs: nowMs,
        fetchStartMs: windowStartMs - 4 * DAY,
      };
    }
    case "1m": {
      const windowStartMs = subtractUtcMonths(nowMs, 1);
      return {
        range,
        timeZone,
        interval: "hour",
        bounds: "regular",
        windowStartMs,
        windowEndMs: nowMs,
        fetchStartMs: windowStartMs - 4 * DAY,
      };
    }
    case "3m":
    case "1y": {
      const windowStartMs = subtractUtcMonths(nowMs, range === "3m" ? 3 : 12);
      return {
        range,
        timeZone,
        interval: "day",
        bounds: "regular",
        windowStartMs,
        windowEndMs: nowMs,
        fetchStartMs: windowStartMs - 7 * DAY,
      };
    }
    case "all":
      return {
        range,
        timeZone,
        interval: "week",
        bounds: "regular",
        windowStartMs: undefined,
        windowEndMs: nowMs,
        fetchStartMs: nowMs - 30 * 365 * DAY,
      };
  }
}

export interface SeriesPoint {
  t: string;
  c: string;
  s: MarketSession;
}

export interface SeriesChange {
  amount: string;
  percent: string;
}

export interface SymbolSeries {
  symbol: string;
  interval: SeriesInterval;
  bounds: SeriesBounds;
  /** Eastern date of the charted trading day (1D only). */
  sessionDate?: string;
  /** ISO bounds of the 1D chart axis in the viewer's local day (1D only). */
  dayStart?: string;
  dayEnd?: string;
  baseline: { price: string; kind: "previous_close" | "window_open" | "first_bar" } | null;
  /** Latest regular-session price: quote first, last regular bar otherwise. */
  price: string | null;
  /** Latest extended-hours price when trading is outside the regular session. */
  extendedPrice: string | null;
  extendedSession: Exclude<MarketSession, "regular"> | null;
  /** Change of `price` against the baseline (Robinhood's "Today"/"Past Week"). */
  change: SeriesChange | null;
  /** Change of `extendedPrice` against `price` (Robinhood's second line). */
  extendedChange: SeriesChange | null;
  points: SeriesPoint[];
}

function toDecimalString(value: number): string {
  // Keep enough precision for sub-cent equities without float noise.
  return Number(value.toFixed(6)).toString();
}

function change(from: string | undefined, to: string | undefined): SeriesChange | null {
  if (from === undefined || to === undefined) return null;
  const base = Number(from);
  const current = Number(to);
  if (!Number.isFinite(base) || !Number.isFinite(current) || base === 0) return null;
  return {
    amount: toDecimalString(current - base),
    percent: toDecimalString(((current - base) / base) * 100),
  };
}

function point(bar: EquityBar): SeriesPoint {
  return { t: bar.beginsAt, c: bar.close, s: bar.session };
}

/**
 * The historicals feed omits the in-progress bar, so a fresh quote is often
 * newer than the last bar. Robinhood extends the line to that live price;
 * this appends it as a trailing point when it is quote-derived and lands
 * after the last drawn bar (and inside the window).
 */
function appendLivePoint(
  points: SeriesPoint[],
  live: { atMs: number; price: string; session: MarketSession } | null,
  windowEndMs: number,
): SeriesPoint[] {
  if (live === null || !Number.isFinite(live.atMs) || live.atMs >= windowEndMs) return points;
  const lastMs = points.length > 0 ? Date.parse(points.at(-1)!.t) : -Infinity;
  if (live.atMs <= lastMs) return points;
  return [...points, { t: new Date(live.atMs).toISOString(), c: live.price, s: live.session }];
}

/**
 * Picks the trading day to chart for 1D: the planned day when it has traded
 * bars, otherwise the day of the latest regular-session bar (a market
 * holiday), and the planned day again when there is nothing at all.
 * Interpolated bars are gap fill, not trades, so they never pick a day.
 */
function chartedTradingDay(bars: readonly EquityBar[], plan: SeriesPlan): TradingDay {
  const planned = plan.tradingDay ?? chartTradingDay(plan.windowEndMs, plan.timeZone);
  const inPlanned = bars.some((bar) => {
    if (bar.interpolated === true) return false;
    const ms = Date.parse(bar.beginsAt);
    return ms >= planned.dayStartMs && ms < planned.dayEndMs;
  });
  if (inPlanned) return planned;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index]!;
    if (bar.session !== "regular" || bar.interpolated === true) continue;
    return chartTradingDay(Date.parse(bar.beginsAt));
  }
  return planned;
}

export function buildSymbolSeries(input: {
  symbol: string;
  bars: readonly EquityBar[];
  quote: EquityQuoteDetail | undefined;
  plan: SeriesPlan;
  nowMs: number;
}): SymbolSeries {
  const { symbol, plan, quote, nowMs } = input;
  const sorted = [...input.bars].sort(
    (left, right) => Date.parse(left.beginsAt) - Date.parse(right.beginsAt),
  );

  if (plan.range === "1d") {
    const day = chartedTradingDay(sorted, plan);
    const visible = sorted.filter((bar) => {
      const ms = Date.parse(bar.beginsAt);
      return ms >= day.dayStartMs && ms < day.dayEndMs;
    });
    const lastRegular = [...visible].reverse().find((bar) => {
      const ms = Date.parse(bar.beginsAt);
      return bar.session === "regular" && ms < day.regularCloseMs;
    });
    const lastVisible = visible.at(-1);
    const priorRegular = [...sorted]
      .reverse()
      .find((bar) => bar.session === "regular" && Date.parse(bar.beginsAt) < day.regularOpenMs);

    // The quote's official close is the previous session's until Robinhood
    // rolls it after this session closes; then it is this day's close.
    const quoteCloseIsPrevious = quote?.previousClose !== undefined &&
      (quote.previousCloseDate === undefined || quote.previousCloseDate < day.date);
    const quoteCloseIsToday = quote?.previousClose !== undefined &&
      quote.previousCloseDate === day.date;
    const baseline = quoteCloseIsPrevious
      ? { price: quote!.previousClose!, kind: "previous_close" as const }
      : priorRegular !== undefined
        ? { price: priorRegular.close, kind: "previous_close" as const }
        : visible[0] !== undefined
          ? { price: visible[0].open, kind: "first_bar" as const }
          : null;

    // Regular price: the quote's regular last trade if it belongs to this
    // charted day, else the last regular bar of the day.
    const inDay = (iso: string | undefined): boolean => {
      if (iso === undefined) return true;
      const ms = Date.parse(iso);
      return ms >= day.dayStartMs && ms < day.dayEndMs;
    };
    const quoteRegularPrice = quote?.lastTradePrice !== undefined && inDay(quote.lastTradeAt)
      ? quote.lastTradePrice
      : undefined;
    const price = quoteRegularPrice ?? lastRegular?.close ?? null;
    // After the close the quote's regular last trade is the closing print.
    const regularClose = quoteCloseIsToday ? quote!.previousClose! : price ?? undefined;

    // Extended price: the latest activity when it falls outside the regular
    // session. Its change is measured from this day's regular close, or from
    // the baseline when the day has no regular bars (holiday fallback).
    const latestSession = lastVisible === undefined
      ? classifySession(nowMs)
      : lastVisible.session;
    const outsideRegular = lastVisible !== undefined && latestSession !== "regular";
    const quoteExtendedPrice = quote?.lastExtendedTradePrice !== undefined &&
        inDay(quote.lastExtendedTradeAt)
      ? quote.lastExtendedTradePrice
      : undefined;
    const extendedPrice = outsideRegular ? quoteExtendedPrice ?? lastVisible.close : null;
    const extendedSession = outsideRegular
      ? (latestSession as Exclude<MarketSession, "regular">)
      : null;
    const extendedBase = lastRegular === undefined ? baseline?.price : regularClose;

    return {
      symbol,
      interval: plan.interval,
      bounds: plan.bounds,
      sessionDate: day.date,
      dayStart: new Date(day.dayStartMs).toISOString(),
      dayEnd: new Date(day.dayEndMs).toISOString(),
      baseline,
      price,
      extendedPrice,
      extendedSession,
      change: change(baseline?.price, price ?? undefined),
      extendedChange: extendedPrice === null ? null : change(extendedBase, extendedPrice),
      points: appendLivePoint(
        visible.map(point),
        extendedPrice !== null && quoteExtendedPrice !== undefined && quote?.lastExtendedTradeAt !== undefined
          ? { atMs: Date.parse(quote.lastExtendedTradeAt), price: extendedPrice, session: extendedSession! }
          : quoteRegularPrice !== undefined && quote?.lastTradeAt !== undefined
            ? { atMs: Date.parse(quote.lastTradeAt), price: quoteRegularPrice, session: "regular" }
            : null,
        Math.min(nowMs, day.dayEndMs),
      ),
    };
  }

  const windowStartMs = plan.windowStartMs;
  const visible = windowStartMs === undefined
    ? sorted
    : sorted.filter((bar) => Date.parse(bar.beginsAt) >= windowStartMs);
  const before = windowStartMs === undefined
    ? undefined
    : [...sorted].reverse().find((bar) => Date.parse(bar.beginsAt) < windowStartMs);
  const baseline = before !== undefined
    ? { price: before.close, kind: "window_open" as const }
    : visible[0] !== undefined
      ? { price: visible[0].open, kind: "first_bar" as const }
      : null;
  const price = quote?.lastTradePrice ?? visible.at(-1)?.close ?? null;
  const session = classifySession(nowMs);
  const extendedPrice = session !== "regular" && quote?.lastExtendedTradePrice !== undefined &&
      quote.lastExtendedTradeAt !== undefined &&
      (quote.lastTradeAt === undefined || quote.lastExtendedTradeAt > quote.lastTradeAt)
    ? quote.lastExtendedTradePrice
    : null;

  return {
    symbol,
    interval: plan.interval,
    bounds: plan.bounds,
    baseline,
    price,
    extendedPrice,
    extendedSession: extendedPrice === null ? null : (session as Exclude<MarketSession, "regular">),
    change: change(baseline?.price, price ?? undefined),
    extendedChange: extendedPrice === null ? null : change(price ?? undefined, extendedPrice),
    // Regular-hours ranges extend to the live quote only while the regular
    // session is open, so the line never draws into closed time.
    points: appendLivePoint(
      visible.map(point),
      quote?.lastTradePrice !== undefined && quote.lastTradeAt !== undefined &&
          classifySession(Date.parse(quote.lastTradeAt)) === "regular"
        ? { atMs: Date.parse(quote.lastTradeAt), price: quote.lastTradePrice, session: "regular" }
        : null,
      nowMs + 1,
    ),
  };
}

/**
 * Decides, per market, where an upstream fetch should start. `undefined`
 * means the cache is fresh enough to serve as is.
 */
export function planFetchStart(input: {
  coverage: { earliestMs: number; latestMs: number; latestUpdatedAtMs: number } | undefined;
  fetchStartMs: number;
  intervalMs: number;
  refreshMs: number;
  nowMs: number;
}): number | undefined {
  const { coverage, fetchStartMs, intervalMs, refreshMs, nowMs } = input;
  if (coverage === undefined) return fetchStartMs;
  // The cache does not reach far enough back for this window: refill.
  if (coverage.earliestMs > fetchStartMs + Math.max(4 * DAY, 2 * intervalMs)) {
    return fetchStartMs;
  }
  if (nowMs - coverage.latestUpdatedAtMs < refreshMs) return undefined;
  // Nothing trades over the weekend; once the last bar was written after it
  // closed there is nothing new to fetch until Sunday evening.
  if (
    isMarketWeekendClosure(nowMs) &&
    coverage.latestUpdatedAtMs >= coverage.latestMs + intervalMs
  ) {
    return undefined;
  }
  // Re-fetch the trailing bar so an in-progress bar gets its final values.
  return coverage.latestMs - intervalMs;
}
