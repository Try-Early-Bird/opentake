// Renderer-side types for the /api/markets/series payload delivered over IPC
// (window.earlybird.getMarketSeries), plus the small slice of Robinhood's
// Eastern-time session clock the dashboard needs to label changes and lay out
// 1D sparklines.

import type { PortfolioRange } from './portfolio-history';

export type {MarketSession, SeriesPoint, SeriesChange, SymbolSeries, MarketSeries} from '../../shared/market-series';
import type {MarketSession,SymbolSeries} from '../../shared/market-series';

/** Delay before re-requesting a series response that reported pending symbols. */
export const SERIES_RETRY_MS = 4_000;
export const SERIES_RETRY_LIMIT = 8;

/**
 * A response older than this is re-requested when the member returns to the
 * window after being idle (see hooks/useUserActivity), so they see the current
 * day without a manual reload. Polling itself stays bounded (see the retry limit).
 */
export const SERIES_REFOCUS_STALE_MS = 60_000;

export const extendedSessionLabels: Record<Exclude<MarketSession, 'regular'>, string> = {
  overnight: 'Overnight',
  pre: 'Pre-market',
  post: 'After-hours',
};

const EASTERN_TIME_ZONE = 'America/New_York';
const REGULAR_OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTES = 16 * 60;
const OVERNIGHT_START_MINUTES = 20 * 60;
const PRE_START_MINUTES = 4 * 60;

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = clockFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    formatter = formatterFor(EASTERN_TIME_ZONE);
  }
  clockFormatters.set(timeZone, formatter);
  return formatter;
}

interface ZonedClock {
  date: string;
  minutesOfDay: number;
  wallAsUtcMs: number;
}

function zonedClock(ms: number, timeZone: string): ZonedClock {
  const parts = new Map<string, string>();
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts.set(part.type, part.value);
  }
  const year = Number(parts.get('year'));
  const month = Number(parts.get('month'));
  const day = Number(parts.get('day'));
  const hour = Number(parts.get('hour')) % 24;
  const minute = Number(parts.get('minute'));
  const second = Number(parts.get('second'));
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutesOfDay: hour * 60 + minute,
    wallAsUtcMs: Date.UTC(year, month - 1, day, hour, minute, second),
  };
}

function easternClock(ms: number): ZonedClock {
  return zonedClock(ms, EASTERN_TIME_ZONE);
}

/** The viewer's IANA time zone, e.g. "America/Los_Angeles". */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || EASTERN_TIME_ZONE;
  } catch {
    return EASTERN_TIME_ZONE;
  }
}

function wallTimeToUtc(date: string, minutesOfDay: number, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const offset = (at: number): number => zonedClock(at, timeZone).wallAsUtcMs - Math.floor(at / 1000) * 1000;
  const first = offset(guess);
  const candidate = guess - first;
  const second = offset(candidate);
  return second === first ? candidate : guess - second;
}

function easternWallTimeToUtc(date: string, minutesOfDay: number): number {
  return wallTimeToUtc(date, minutesOfDay, EASTERN_TIME_ZONE);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export interface TradingDay {
  date: string;
  /** Midnight ET starting the calendar day: left edge of the 1D chart. */
  dayStartMs: number;
  /** Midnight ET ending the calendar day: right edge of the 1D chart. */
  dayEndMs: number;
  /** 16:00 ET of the previous weekday. */
  previousCloseMs: number;
  regularOpenMs: number;
  regularCloseMs: number;
  /** 20:00 ET. */
  afterHoursEndMs: number;
  /** 09:30 ET of the next weekday: end of the charted day. */
  nextOpenMs: number;
}

function isWeekendDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function stepWeekday(date: string, direction: -1 | 1): string {
  let candidate = shiftDate(date, direction);
  while (isWeekendDate(candidate)) candidate = shiftDate(candidate, direction);
  return candidate;
}

export function tradingDayForDate(date: string): TradingDay {
  return {
    date,
    dayStartMs: easternWallTimeToUtc(date, 0),
    dayEndMs: easternWallTimeToUtc(shiftDate(date, 1), 0),
    previousCloseMs: easternWallTimeToUtc(stepWeekday(date, -1), REGULAR_CLOSE_MINUTES),
    regularOpenMs: easternWallTimeToUtc(date, REGULAR_OPEN_MINUTES),
    regularCloseMs: easternWallTimeToUtc(date, REGULAR_CLOSE_MINUTES),
    afterHoursEndMs: easternWallTimeToUtc(date, OVERNIGHT_START_MINUTES),
    nextOpenMs: easternWallTimeToUtc(stepWeekday(date, 1), REGULAR_OPEN_MINUTES),
  };
}

/**
 * The trading day Robinhood charts at the instant, framed in the viewer's time
 * zone: the 1D window is the viewer's
 * local calendar day; the regular-session fields stay Eastern.
 */
export function chartTradingDay(ms: number, timeZone: string = localTimeZone()): TradingDay {
  let localDate = zonedClock(ms, timeZone).date;
  while (isWeekendDate(localDate)) localDate = shiftDate(localDate, -1);
  const dayStartMs = wallTimeToUtc(localDate, 0, timeZone);
  const dayEndMs = wallTimeToUtc(shiftDate(localDate, 1), 0, timeZone);
  let referenceDate = easternClock(dayStartMs + 12 * 60 * 60 * 1000).date;
  while (isWeekendDate(referenceDate)) referenceDate = shiftDate(referenceDate, -1);
  return { ...tradingDayForDate(referenceDate), dayStartMs, dayEndMs };
}

export function classifySession(ms: number): MarketSession {
  const { minutesOfDay } = easternClock(ms);
  if (minutesOfDay >= OVERNIGHT_START_MINUTES || minutesOfDay < PRE_START_MINUTES) return 'overnight';
  if (minutesOfDay < REGULAR_OPEN_MINUTES) return 'pre';
  if (minutesOfDay < REGULAR_CLOSE_MINUTES) return 'regular';
  return 'post';
}

/**
 * True when a 1D series charts an earlier day than the one the viewer's clock
 * says should be charted. The server falls back to the last cached day while
 * today's bars are still being fetched (or on a market holiday); the client
 * keeps asking while that is the case so the chart fills in on its own.
 */
export function seriesDayIsBehind(series: Pick<SymbolSeries, 'sessionDate'>, nowMs: number): boolean {
  if (series.sessionDate === undefined) return false;
  return series.sessionDate < chartTradingDay(nowMs).date;
}
