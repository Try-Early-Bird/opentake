import type { AllocationHistory, PortfolioStrategy, PortfolioView } from '../../../shared/portfolio';
import type { PortfolioAccount } from '../portfolio/types';
import type { SelfDirectedAccount, StrategyHolding } from './holdings';

// The strategy panel's reads, answered from the local portfolio view in the
// shapes the panel reads.

/** A holding plus the fields the panel reads beyond the base shape. */
export interface HoldingWithPnl extends StrategyHolding {
  pnl?: { capitalAllocated: string; unrealized: string | null; realized: string; allTimeReturn: string | null };
  bucket: StrategyHolding['bucket'] & { allocationValue?: string; activatedAt?: string | null; createdAt?: string };
  /** Imported or restored: paused until reviewed against the account. */
  requiresReconciliation?: boolean;
  /** Orders Robinhood never confirmed or refused; the member can clear one after checking Robinhood. */
  unknownOrders?: { legId: string; symbol: string; side: string; amount: string | null; quantity: string | null; sentAt: string | null }[];
}

function holdingOf(strategy: PortfolioStrategy, currency: string): HoldingWithPnl {
  return {
    bucket: { id: strategy.allocationId, status: strategy.status, activatedAt: null, ...(strategy.importedAsOf === null ? {} : { createdAt: strategy.importedAsOf }) },
    strategy: { id: strategy.strategyId, slug: strategy.title, displayName: strategy.title, description: strategy.description || null, iconUrl: null },
    allocation: {
      sequence: 0,
      weights: strategy.spec.target.weights.map((weight) => ({ symbol: weight.instrument.symbol, weightPercent: weight.bps / 100 })),
      cashPercent: strategy.spec.target.cashBps / 100,
    },
    valuation: { complete: strategy.value !== null, currency, cash: strategy.cash, totalValue: strategy.value },
    positions: strategy.positions.map((position) => ({ symbol: position.symbol ?? position.instrumentRef, quantity: position.quantity })),
    requiresReconciliation: strategy.requiresReconciliation,
  };
}

let shared: Promise<PortfolioView> | null = null;
/** One snapshot serves the holdings and account reads made together. */
function snapshot(): Promise<PortfolioView> {
  if (shared === null) {
    shared = window.portfolio.snapshot();
    void shared.finally(() => { shared = null; }).catch(() => undefined);
  }
  return shared;
}

export const followData = {
  async getStrategyHoldings(): Promise<{ status: number; holdings: HoldingWithPnl[]; selfDirected: SelfDirectedAccount[] }> {
    // The execution layer answers in the hosted shape, with the live fields
    // (P&L, open orders, waits, failures, outside sales, closures); an older
    // background service without it falls back to the portfolio snapshot.
    const bridge = (window.allocations as typeof window.allocations | undefined)?.holdings;
    if (bridge !== undefined) {
      try {
        const result = await bridge();
        if (result.status === 200) return { status: 200, holdings: result.holdings as HoldingWithPnl[], selfDirected: result.selfDirected as SelfDirectedAccount[] };
      } catch { /* Fall back to the snapshot below. */ }
    }
    try {
      const view = await snapshot();
      const currency = view.portfolio?.currency ?? 'USD';
      return {
        status: 200,
        holdings: (view.strategies ?? []).map((strategy) => holdingOf(strategy, currency)),
        selfDirected: view.account === null ? [] : [{ accountId: view.account.id, asOf: null, reservedCash: view.reservedCash ?? '0', positions: [] }],
      };
    } catch {
      return { status: 0, holdings: [], selfDirected: [] };
    }
  },
  async getPortfolio(): Promise<PortfolioAccount | null> {
    const view = await snapshot().catch(() => null);
    if (!view?.account?.available) return null;
    return {
      accountId: view.account.id,
      maskedNumber: view.account.maskedNumber,
      venue: view.account.venue,
      venueDisplayName: view.account.venue === 'robinhood' ? 'Robinhood' : view.account.venue,
      asOf: view.resources.find((resource) => resource.resource === 'portfolio')?.observedAt ?? '',
      summary: {
        totalAssetValue: view.portfolio?.totalValue ?? '0',
        currency: view.portfolio?.currency ?? 'USD',
        cash: view.portfolio?.cash ?? null,
        buyingPower: view.portfolio?.buyingPower ?? null,
      },
      positions: [],
    };
  },
  async getStrategyBucketHistory(allocationId: string, range: 'all'): Promise<{ status: number; history: AllocationHistory | null }> {
    try {
      return { status: 200, history: await window.portfolio.strategyHistory(allocationId, range) };
    } catch {
      return { status: 0, history: null };
    }
  },
};
