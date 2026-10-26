export type PriceRange = '1d'|'1w'|'1m'|'3m'|'1y'|'all';
export type MarketSession = 'overnight' | 'pre' | 'regular' | 'post';

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
  interval: '5minute' | '10minute' | 'hour' | 'day' | 'week';
  bounds: '24_5' | 'regular';
  sessionDate?: string;
  dayStart?: string;
  dayEnd?: string;
  baseline: { price: string; kind: 'previous_close' | 'window_open' | 'first_bar' } | null;
  price: string | null;
  extendedPrice: string | null;
  extendedSession: Exclude<MarketSession, 'regular'> | null;
  change: SeriesChange | null;
  extendedChange: SeriesChange | null;
  points: SeriesPoint[];
}

export interface MarketSeries {
  venue: 'robinhood_agentic'|'coinbase';
  range: PriceRange;
  asOf: string;
  series: SymbolSeries[];
  staleSymbols: string[];
  /** Symbols still awaiting their first cache fill; request again shortly. */
  pendingSymbols: string[];
  /** Symbols whose cache is refreshing in the background; re-request shortly. */
  refreshingSymbols: string[];
}


/** An instrument page's name and the provider's raw get_equity_fundamentals record. */
export interface MarketDetail {
  symbol: string;
  displayName: string;
  fundamentals: Record<string, unknown> | null;
}
