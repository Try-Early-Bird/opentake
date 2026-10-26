/** Narrow read-only surface for the equity research UI; never accepts accounts or writes. */
export const marketResearchTools = [
  'get_earnings_results', 'get_financials', 'get_equity_analyst_ratings',
  'get_sec_filing_index', 'get_sec_filing',
] as const;
export type MarketResearchRequest = {
  tool: typeof marketResearchTools[number];
  arguments: Record<string, unknown>;
};
