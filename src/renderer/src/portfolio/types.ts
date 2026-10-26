// Presentational portfolio shapes — the subset the shared view renders. Apps map
// their API responses (same shape, from the same endpoints) onto these.

export type PositionSide = "long" | "short" | "flat" | "none";

export interface Position {
  marketRef: string;
  symbol: string;
  assetClass?: string;
  side: PositionSide;
  size: string;
  averageEntryPrice: string | null;
  positionValue: string | null;
  unrealizedPnl: string | null;
  realizedPnl: string | null;
}

export interface PortfolioSummary {
  totalAssetValue: string;
  currency?: string;
  cash?: string | null;
  buyingPower?: string | null;
}

export interface PortfolioAccount {
  maskedNumber?: string;
  accountId: string;
  venue: string;
  venueDisplayName: string;
  asOf: string;
  summary: PortfolioSummary;
  positions: Position[];
}

export interface Portfolio {
  accounts: PortfolioAccount[];
}
