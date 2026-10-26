import type {MarketHit} from '../../../shared/search';
export interface StrategyCardWeight {
  venue?: string;
  market?: MarketHit['identity'];
  symbol: string;
  weightBps: number;
  /** Instrument facts from the market catalog; absent or null when unknown. */
  displayName?: string | null;
  logoUrl?: string | null;
  currentPrice?: string | null;
  previousClose?: string | null;
  /** Weight in the model portfolio as of `targets.currentAsOf`, what new money buys; absent or null until valued. */
  currentWeightBps?: number | null;
  /** Eastern trading day the symbol was marked delisted; absent or null while it trades. */
  delistedOn?: string | null;
}

export interface StrategyCardData {
  id: string;
  displayName: string;
  description: string | null;
  iconUrl: string | null;
  /** 3:2 banner shown above the mark when present. */
  coverPhotoUrl?: string | null;
  /** Open buckets following the strategy, the author's own included. */
  investors?: number;
  /** Their current USD value; null while any cannot be valued yet. */
  investedValue?: string | null;
  /** The author's own buckets' value within that total; null when none or it cannot be valued yet. */
  ownerInvestedValue?: string | null;
  // `handle` is the display handle (Earlybird, else X); profiles resolve either one.
  author: { name: string; handle: string | null; earlybirdHandle: string | null };
  targets: {
    complete: boolean;
    cashReserveBps: number;
    weights: StrategyCardWeight[];
    /** Eastern trading day the current weights were valued on; absent or null until the model has been valued. */
    currentAsOf?: string | null;
    currentCashBps?: number | null;
    /** What the current weights were priced from; `settled_close` is Robinhood's own settled price for that session. */
    currentPricedFrom?: 'settled_close' | 'day_bar' | 'mixed' | null;
    currentObservedAt?: string | null;
  };
  stats: {
    source: 'backtested' | 'paper' | 'live';
    allTimeReturnPercent: string | null;
    oneDayReturnPercent: string | null;
  }[];
  version: { number: number };
}

