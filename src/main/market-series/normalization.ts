import {
  classifySession,
  type MarketSession,
} from "./sessions";

/**
 * Normalizers for the Robinhood MCP `get_equity_historicals` and
 * `get_equity_quotes` payloads used by the market series endpoint. Both tools
 * return decimal strings; bars are left-edge labelled in UTC.
 */

export interface EquityBar {
  /** ISO instant of the bar's left edge. */
  beginsAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  session: MarketSession;
  /**
   * Robinhood synthesized this bar to fill a gap with no trades: flat at the
   * last price, zero volume. Kept only for 24/5 intraday series so the 1D
   * line spans quiet pre-market and after-hours stretches the way Robinhood
   * draws them; never a real print.
   */
  interpolated?: true;
}

export interface EquityQuoteDetail {
  symbol: string;
  /** Last regular-session trade. */
  lastTradePrice?: string;
  lastTradeAt?: string;
  /** Last extended-hours (pre/post/overnight) trade, when any. */
  lastExtendedTradePrice?: string;
  lastExtendedTradeAt?: string;
  previousClose?: string;
  previousCloseDate?: string;
  /**
   * How Robinhood settled that close, as it labels it (for example
   * `sip-list-exchange-close`), and whether it synthesized the price. Kept so
   * a mark can say where it came from instead of being called a close.
   */
  previousCloseSource?: string;
  previousCloseInterpolated?: boolean;
}

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value.toString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (DECIMAL_PATTERN.test(trimmed)) return trimmed;
  }
  return undefined;
}

function instant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function symbolOf(record: Record<string, unknown>): string | undefined {
  const symbol = record.symbol;
  return typeof symbol === "string" && symbol.trim().length > 0
    ? symbol.trim().toUpperCase()
    : undefined;
}

function sessionOf(record: Record<string, unknown>, beginsAtMs: number): MarketSession {
  const raw = typeof record.session === "string" ? record.session.toLowerCase() : "";
  if (raw.startsWith("reg")) return "regular";
  if (raw.startsWith("pre")) return "pre";
  if (raw.startsWith("post") || raw.startsWith("after") || raw === "ext") return "post";
  if (raw.startsWith("over") || raw.startsWith("night")) return "overnight";
  return classifySession(beginsAtMs);
}

/**
 * Walks the `data.results[]` payload (or a bare results array) and returns
 * bars per symbol, sorted by time and deduplicated on `begins_at`.
 * Interpolated bars are synthesized gap fillers: dropped by default, kept and
 * flagged with `keepInterpolated` so a 24/5 chart can draw through them.
 */
export function normalizeEquityHistoricals(
  value: unknown,
  options: { keepInterpolated?: boolean } = {},
): Map<string, EquityBar[]> {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  const results = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(value)
      ? value
      : [];

  const bySymbol = new Map<string, Map<number, EquityBar>>();
  for (const entry of results) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const symbol = symbolOf(record);
    if (symbol === undefined || !Array.isArray(record.bars)) continue;
    const bars = bySymbol.get(symbol) ?? new Map<number, EquityBar>();
    for (const item of record.bars) {
      const bar = asRecord(item);
      if (bar === undefined) continue;
      const interpolated = bar.interpolated === true;
      if (interpolated && options.keepInterpolated !== true) continue;
      const beginsAt = instant(bar.begins_at ?? bar.beginsAt ?? bar.timestamp);
      const open = decimal(bar.open_price ?? bar.open);
      const high = decimal(bar.high_price ?? bar.high);
      const low = decimal(bar.low_price ?? bar.low);
      const close = decimal(bar.close_price ?? bar.close);
      if (
        beginsAt === undefined || open === undefined || high === undefined ||
        low === undefined || close === undefined
      ) {
        continue;
      }
      const numeric = [open, high, low, close].map(Number);
      if (numeric.some((price) => price < 0)) continue;
      const beginsAtMs = Date.parse(beginsAt);
      // Guard the storage check: high must cap and low must floor open/close.
      const cappedHigh = Math.max(numeric[1]!, numeric[0]!, numeric[3]!, numeric[2]!);
      const flooredLow = Math.min(numeric[2]!, numeric[0]!, numeric[3]!);
      bars.set(beginsAtMs, {
        beginsAt,
        open,
        high: cappedHigh === numeric[1] ? high : cappedHigh.toString(),
        low: flooredLow === numeric[2] ? low : flooredLow.toString(),
        close,
        volume: decimal(bar.volume) ?? "0",
        session: sessionOf(bar, beginsAtMs),
        ...(interpolated ? { interpolated: true as const } : {}),
      });
    }
    bySymbol.set(symbol, bars);
  }

  return new Map(
    [...bySymbol].map(([symbol, bars]) => [
      symbol,
      [...bars.entries()].sort(([left], [right]) => left - right).map(([, bar]) => bar),
    ]),
  );
}

/**
 * Reads `data.results[]` entries shaped `{ quote, close }` and returns one
 * detail record per symbol. Falls back to flat quote records so older or
 * degraded payloads (e.g. `closes` dropped past 20 symbols) still price.
 */
export function normalizeEquityQuoteDetails(value: unknown): Map<string, EquityQuoteDetail> {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  const results = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.quotes)
      ? data.quotes
      : Array.isArray(value)
        ? value
        : [];

  const details = new Map<string, EquityQuoteDetail>();
  for (const entry of results) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const quote = asRecord(record.quote) ?? record;
    const close = asRecord(record.close);
    const symbol = symbolOf(quote) ?? (close === undefined ? undefined : symbolOf(close));
    if (symbol === undefined) continue;

    const detail: EquityQuoteDetail = { ...details.get(symbol), symbol };
    const lastTradePrice = decimal(quote.last_trade_price ?? quote.last_price ?? quote.price);
    const lastTradeAt = instant(quote.venue_last_trade_time ?? quote.last_trade_at ?? quote.updated_at);
    const extendedPrice = decimal(
      quote.last_non_reg_trade_price ?? quote.last_extended_hours_trade_price,
    );
    const extendedAt = instant(
      quote.venue_last_non_reg_trade_time ?? quote.last_extended_hours_trade_time,
    );
    const previousClose = decimal(close?.price) ??
      decimal(quote.previous_close ?? quote.adjusted_previous_close ?? quote.previous_close_price);
    const previousCloseDate = typeof close?.date === "string"
      ? close.date.slice(0, 10)
      : typeof quote.previous_close_date === "string"
        ? quote.previous_close_date.slice(0, 10)
        : undefined;

    if (lastTradePrice !== undefined) detail.lastTradePrice = lastTradePrice;
    if (lastTradeAt !== undefined) detail.lastTradeAt = lastTradeAt;
    if (extendedPrice !== undefined) detail.lastExtendedTradePrice = extendedPrice;
    if (extendedAt !== undefined) detail.lastExtendedTradeAt = extendedAt;
    if (previousClose !== undefined) detail.previousClose = previousClose;
    if (previousCloseDate !== undefined) detail.previousCloseDate = previousCloseDate;
    if (typeof close?.source === "string" && close.source.trim().length > 0) {
      detail.previousCloseSource = close.source.trim();
    }
    if (typeof close?.interpolated === "boolean") detail.previousCloseInterpolated = close.interpolated;
    details.set(symbol, detail);
  }
  return details;
}
