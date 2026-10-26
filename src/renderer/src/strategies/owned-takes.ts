import type { CoinbaseCapitalView } from '../../../shared/coinbase-capital';
import type { HoldingWithPnl } from './follow-data';
import type { BasketSummary, BasketRowDetail } from '../../../shared/strategies';
import type { PortfolioView } from '../../../shared/portfolio';
import type { OwnedTakeRowData } from './OwnedTakeRow';

/** Published weights stay visible when the author has uncommitted edits. */
export function ownedTakeRow(summary: BasketSummary, view: BasketRowDetail | null, portfolio: PortfolioView | null, holdings: readonly HoldingWithPnl[] | null = null, coinbase: CoinbaseCapitalView | null = null): OwnedTakeRowData {
  const version = view?.versions.find((item) => item.id === view.currentVersion);
  const payload = version?.payload ?? (summary.status === 'draft' ? view?.draft : undefined);
  const first = view?.versions.reduce<typeof version>((oldest, item) => !oldest || item.sequence < oldest.sequence ? item : oldest, undefined);
  const allocations = portfolio?.strategies?.filter((item) => item.strategyId === summary.strategyId) ?? [];
  const values = allocations.map((item) => item.value === null ? NaN : Number(item.value));
  const coinbaseFunded = coinbase?.balances.some(balance => Number(balance.quantity) > 0) ?? false;
  if (coinbaseFunded) values.push(coinbase?.valuation?.value != null && coinbase.valuation.currency === (portfolio?.portfolio?.currency ?? 'USD') ? Number(coinbase.valuation.value) : NaN);
  // Use the same actual, all-time return as the take's investment panel.
  // Weight multiple allocations by contributed capital, never by current value.
  const ownedHoldings = allocations.map((allocation) => holdings?.find((holding) => holding.bucket.id === allocation.allocationId && holding.strategy.id === summary.strategyId));
  const complete = ownedHoldings.length > 0 && ownedHoldings.every((holding) => holding?.valuation.complete && holding.pnl?.allTimeReturn != null && Number.isFinite(Number(holding.pnl.allTimeReturn)) && Number.isFinite(Number(holding.pnl.capitalAllocated)) && Number(holding.pnl.capitalAllocated) > 0);
  const capital = complete ? ownedHoldings.reduce((sum, holding) => sum + Number(holding!.pnl!.capitalAllocated), 0) : 0;
  const robinhoodReturn = capital > 0 ? ownedHoldings.reduce((sum, holding) => sum + Number(holding!.pnl!.capitalAllocated) * Number(holding!.pnl!.allTimeReturn), 0) / capital : null;
  const currency = portfolio?.portfolio?.currency ?? 'USD';
  const coinbasePnl = coinbaseFunded && coinbase?.pnl?.currency === currency && coinbase.valuation?.currency === currency && coinbase.valuation.value !== null && Number.isFinite(Number(coinbase.valuation.value)) && Number.isFinite(Number(coinbase.pnl.gain)) ? coinbase.pnl : null;
  const coinbaseCapital = coinbasePnl ? Number(coinbase!.valuation!.value) - Number(coinbasePnl.gain) : 0;
  const allComplete = (allocations.length === 0 || complete) && (!coinbaseFunded || coinbasePnl !== null) && values.every(Number.isFinite);
  const totalPnl = allComplete && (allocations.length > 0 || coinbaseFunded) ? values.reduce((sum,value)=>sum+value,0) - capital - coinbaseCapital : null;
  const combinedCapital = capital + coinbaseCapital;
  const coinbaseReturn = coinbasePnl?.returnPercent;
  const returnPercent = !coinbaseFunded ? robinhoodReturn : allComplete && combinedCapital > 0 && coinbaseReturn != null && Number.isFinite(Number(coinbaseReturn)) && (allocations.length === 0 || robinhoodReturn !== null)
    ? ((robinhoodReturn ?? 0) * capital + Number(coinbaseReturn) * coinbaseCapital) / combinedCapital : null;
  return {
    ...summary,
    iconId: view?.iconId ?? null,
    description: payload?.metadata.description ?? null,
    spec: payload?.spec ?? null,
    // Truncated history cannot establish the initial commit date.
    startedAt: first?.sequence === 1 ? first.createdAt : null,
    funded: coinbaseFunded || allocations.some(allocation => allocation.value === null || Number(allocation.value) > 0),
    investedValue: portfolio === null || values.some((value) => !Number.isFinite(value)) ? null : String(values.reduce((sum, value) => sum + value, 0)),
    returnPercent,
    totalPnl,
    currency,
  };
}
