// Renderer-side types for the /api/portfolio/history payload delivered over
// IPC (window.earlybird.getPortfolioHistory).

export type PortfolioRange = '1d' | '1w' | '1m' | '3m' | '1y' | 'all';

export interface PortfolioHistoryPoint {
  observedAt: string;
  totalAssetValue: string;
  observed: boolean;
}

export interface PortfolioHistoryAccount {
  accountId: string;
  venue: string;
  venueDisplayName: string;
  currency: string;
  points: PortfolioHistoryPoint[];
}

export interface PortfolioHistory {
  range: PortfolioRange;
  accounts: PortfolioHistoryAccount[];
}
