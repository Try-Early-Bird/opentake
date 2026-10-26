/**
 * US equity session clock in America/New_York, mirroring how Robinhood frames
 * a trading day for charting. Sessions by wall clock: pre-market 04:00–09:30,
 * regular 09:30–16:00, after-hours 16:00–20:00, overnight 20:00–04:00. The
 * charted "day" is the Eastern calendar day, midnight to midnight, drawn only
 * as far as now; its baseline is the previous weekday's regular close. On
 * weekends the chart shows Friday. Holidays are not modelled here; callers
 * derive the active day from bar data instead.
 */

export const EASTERN_TIME_ZONE = "America/New_York";

export type MarketSession = "overnight" | "pre" | "regular" | "post";

const MINUTE_MS = 60 * 1_000;

const SESSION_BOUNDARIES = {
  overnightStart: 20 * 60,
  preStart: 4 * 60,
  regularStart: 9 * 60 + 30,
  regularEnd: 16 * 60,
} as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** A cached parts formatter for a time zone, falling back to Eastern when the
 *  zone is invalid so a bad client value can never throw. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = clockFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
  } catch {
    formatter = formatterFor(EASTERN_TIME_ZONE);
  }
  clockFormatters.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number; date: string; minutesOfDay: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Map<string, string>();
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  const year = Number(parts.get("year"));
  const month = Number(parts.get("month"));
  const day = Number(parts.get("day"));
  const hour = Number(parts.get("hour")) % 24;
  const minute = Number(parts.get("minute"));
  const second = Number(parts.get("second"));
  const weekday = WEEKDAYS.indexOf((parts.get("weekday") ?? "Sun").slice(0, 3) as (typeof WEEKDAYS)[number]);
  return {
    year, month, day, hour, minute, second,
    weekday: weekday === -1 ? 0 : weekday,
    date: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/** Calendar date (YYYY-MM-DD) at an instant, in the given time zone. */
export function zonedDate(ms: number, timeZone: string): string {
  return zonedParts(ms, timeZone).date;
}

function offsetMs(ms: number, timeZone: string): number {
  const clock = zonedParts(ms, timeZone);
  const wallAsUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return wallAsUtc - Math.floor(ms / 1_000) * 1_000;
}

/** UTC instant for a wall-clock time on a calendar date, in the given zone. */
export function wallTimeToUtc(date: string, minutesOfDay: number, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const firstOffset = offsetMs(guess, timeZone);
  const candidate = guess - firstOffset;
  const secondOffset = offsetMs(candidate, timeZone);
  return secondOffset === firstOffset ? candidate : guess - secondOffset;
}

export interface EasternClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in Eastern Time. */
  weekday: number;
  /** Calendar date in Eastern Time, YYYY-MM-DD. */
  date: string;
  /** Minutes since Eastern midnight. */
  minutesOfDay: number;
}

export function easternClock(ms: number): EasternClock {
  return zonedParts(ms, EASTERN_TIME_ZONE);
}

/** UTC instant for an Eastern wall-clock time on a calendar date (YYYY-MM-DD). */
export function easternWallTimeToUtc(date: string, minutesOfDay: number): number {
  return wallTimeToUtc(date, minutesOfDay, EASTERN_TIME_ZONE);
}

export function shiftEasternDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function weekdayOfDate(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isWeekendDate(date: string): boolean {
  const weekday = weekdayOfDate(date);
  return weekday === 0 || weekday === 6;
}

function previousWeekdayDate(date: string): string {
  let candidate = shiftEasternDate(date, -1);
  while (isWeekendDate(candidate)) candidate = shiftEasternDate(candidate, -1);
  return candidate;
}

function nextWeekdayDate(date: string): string {
  let candidate = shiftEasternDate(date, 1);
  while (isWeekendDate(candidate)) candidate = shiftEasternDate(candidate, 1);
  return candidate;
}

/**
 * NYSE full-day closures. Kept as a static list the way exchanges publish
 * them; extend each year. Early closes still count as trading days.
 */
// Published NYSE calendar: https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx
export const MARKET_CALENDAR_THROUGH=2028;
const EARLY_CLOSES=new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
export function regularCloseMinutes(date:string){return EARLY_CLOSES.has(date)?13*60:16*60;}
const NYSE_HOLIDAYS = new Set(['2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25',
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export function isMarketHoliday(easternDate: string): boolean {
  return NYSE_HOLIDAYS.has(easternDate);
}

/** A weekday that is not a full-day closure. */
export function isTradingDay(easternDate: string): boolean {
  return !isWeekendDate(easternDate) && !isMarketHoliday(easternDate);
}

/** True inside the regular 09:30–16:00 ET session on a trading day. */
export function isRegularSessionOpen(ms: number): boolean {
  const clock = easternClock(ms);
  if(clock.year>MARKET_CALENDAR_THROUGH)throw new Error('Market calendar expired; update Opentake before trading');
  return isTradingDay(clock.date) && clock.minutesOfDay>=SESSION_BOUNDARIES.regularStart && clock.minutesOfDay<regularCloseMinutes(clock.date);
}

/**
 * The next instant the regular session is open, at or after `ms`: now, if it
 * is open now; else 09:30 ET on the next trading day. What a queued order
 * waits for.
 */
export function nextRegularSessionOpen(ms: number): number {
  if (isRegularSessionOpen(ms)) return ms;
  const clock = easternClock(ms);
  let date = clock.date;
  if (!isTradingDay(date) || clock.minutesOfDay >= SESSION_BOUNDARIES.regularStart) {
    date = shiftEasternDate(date, 1);
    while (!isTradingDay(date)) date = shiftEasternDate(date, 1);
  }
  return easternWallTimeToUtc(date, SESSION_BOUNDARIES.regularStart);
}

/**
 * Minutes of regular session between two instants. How long an order has
 * really been waiting on the market, as opposed to on the clock: a leg
 * queued at nine in the evening has waited nothing by half past nine the
 * next morning.
 */
export function regularSessionMinutesBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  let total = 0;
  let date = easternClock(fromMs).date;
  const last = easternClock(toMs).date;
  for (let guard = 0; guard < 400 && date <= last; guard += 1, date = shiftEasternDate(date, 1)) {
    if (!isTradingDay(date)) continue;
    const open = easternWallTimeToUtc(date, SESSION_BOUNDARIES.regularStart);
    const close = easternWallTimeToUtc(date, regularCloseMinutes(date));
    const from = fromMs > open ? fromMs : open;
    const to = toMs < close ? toMs : close;
    if (to > from) total += (to - from) / MINUTE_MS;
  }
  return total;
}

/** Trading days from `from` to `to` inclusive (Eastern dates), oldest first. */
export function tradingDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    if (isTradingDay(cursor)) days.push(cursor);
    cursor = shiftEasternDate(cursor, 1);
  }
  return days;
}

export function classifySession(ms: number): MarketSession {
  const { minutesOfDay } = easternClock(ms);
  if (minutesOfDay >= SESSION_BOUNDARIES.overnightStart || minutesOfDay < SESSION_BOUNDARIES.preStart) {
    return "overnight";
  }
  if (minutesOfDay < SESSION_BOUNDARIES.regularStart) return "pre";
  if (minutesOfDay < SESSION_BOUNDARIES.regularEnd) return "regular";
  return "post";
}

export interface TradingDay {
  /** Eastern calendar date of the regular session (always a weekday). */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Midnight ET starting the calendar day: left edge of the 1D chart. */
  dayStartMs: number;
  /** Midnight ET ending the calendar day: right edge of the 1D chart. */
  dayEndMs: number;
  /** Midnight ET starting the previous weekday: where a 1D bar fetch starts,
   *  so that day is complete when it is charted as a fallback. */
  previousDayStartMs: number;
  /** 09:30 ET of the previous weekday. */
  previousOpenMs: number;
  /** 16:00 ET of the previous weekday: the previous-close reference point. */
  previousCloseMs: number;
  /** 09:30 ET: start of the charted day. */
  regularOpenMs: number;
  regularCloseMs: number;
  /** 20:00 ET: end of after-hours. */
  afterHoursEndMs: number;
  /** 09:30 ET of the next weekday: end of the charted day. */
  nextOpenMs: number;
}

export function tradingDayForDate(date: string): TradingDay {
  return {
    date,
    weekday: weekdayOfDate(date),
    dayStartMs: easternWallTimeToUtc(date, 0),
    dayEndMs: easternWallTimeToUtc(shiftEasternDate(date, 1), 0),
    previousDayStartMs: easternWallTimeToUtc(previousWeekdayDate(date), 0),
    previousOpenMs: easternWallTimeToUtc(previousWeekdayDate(date), SESSION_BOUNDARIES.regularStart),
    previousCloseMs: easternWallTimeToUtc(previousWeekdayDate(date), SESSION_BOUNDARIES.regularEnd),
    regularOpenMs: easternWallTimeToUtc(date, SESSION_BOUNDARIES.regularStart),
    regularCloseMs: easternWallTimeToUtc(date, regularCloseMinutes(date)),
    afterHoursEndMs: easternWallTimeToUtc(date, SESSION_BOUNDARIES.overnightStart),
    nextOpenMs: easternWallTimeToUtc(nextWeekdayDate(date), SESSION_BOUNDARIES.regularStart),
  };
}

/**
 * The trading day Robinhood charts at the instant, framed in the viewer's time
 * zone. The 1D window is the viewer's local calendar day (local midnight to
 * local midnight), or the most recent weekday on a weekend. The regular
 * session fields (open/close, previous close) stay Eastern: they name the US
 * session the local day contains, picked from the local day's midday so the
 * right Eastern date is chosen from any zone. Defaults to Eastern.
 */
export function chartTradingDay(ms: number, timeZone: string = EASTERN_TIME_ZONE): TradingDay {
  let localDate = zonedDate(ms, timeZone);
  while (isWeekendDate(localDate)) localDate = shiftEasternDate(localDate, -1);
  const dayStartMs = wallTimeToUtc(localDate, 0, timeZone);
  const dayEndMs = wallTimeToUtc(shiftEasternDate(localDate, 1), 0, timeZone);
  let referenceDate = easternClock(dayStartMs + 12 * 60 * 60 * 1_000).date;
  while (isWeekendDate(referenceDate)) referenceDate = shiftEasternDate(referenceDate, -1);
  return { ...tradingDayForDate(referenceDate), dayStartMs, dayEndMs };
}

/**
 * True when no US equity session (including the 24/5 overnight session) is
 * running: Friday 20:00 ET through Sunday 20:00 ET.
 */
export function isMarketWeekendClosure(ms: number): boolean {
  const clock = easternClock(ms);
  if (clock.weekday === 6) return true;
  if (clock.weekday === 0) return clock.minutesOfDay < SESSION_BOUNDARIES.overnightStart;
  if (clock.weekday === 5) return clock.minutesOfDay >= SESSION_BOUNDARIES.overnightStart;
  return false;
}

export const sessionMilliseconds = { minute: MINUTE_MS } as const;
