import { assetActivity } from '../portfolio/local-adapter';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../lib/utils';
import { money, signedMoney } from '../portfolio/format';
import { Button } from '../components/ui/button';
import { MarketChart, type MarketHoverPoint } from '../components/MarketChart';
import { MarketEarnings } from '../components/MarketEarnings';
import { MarketResearchTabs } from '../components/MarketResearchTabs';
import { MarketFundamentals } from '../components/MarketFundamentals';
import { MarketHoldersPanel } from '../strategies/MarketHoldersPanel';
import { RollingNumber } from '../components/RollingNumber';
import { SidePanelLayout } from '../components/SidePanelLayout';
import { Skeleton } from '../components/ui/skeleton';
import {
  extendedSessionLabels,
  SERIES_REFOCUS_STALE_MS,
  SERIES_RETRY_LIMIT,
  SERIES_RETRY_MS,
  seriesDayIsBehind,
  type MarketSeries,
  type SeriesChange,
  type SymbolSeries,
} from '../market-series';
import type { PortfolioRange } from '../portfolio-history';
import type { MarketDetail as MarketFacts } from '../../../shared/market-series';
import type { PortfolioView } from '../../../shared/portfolio';
import { portfolioHoldings } from '../portfolio/local-adapter';
import { AddToListMenu } from '../components/AddToListMenu';

// Robinhood-style instrument
// page for a Robinhood Agentic equity: name, live price, one change line, the
// session chart with range tabs, and, when the member holds the symbol, their
// position summary. Reached from the holdings rows at /rh/$symbol; the `rh`
// segment names the source venue. Name and fundamentals come from the
// selected Robinhood connection instead of the hosted catalog.

const ranges: readonly PortfolioRange[] = ['1d', '1w', '1m', '3m', '1y', 'all'];

const periodLabels: Record<PortfolioRange, string> = {
  '1d': 'Today',
  '1w': 'Past week',
  '1m': 'Past month',
  '3m': 'Past 3 months',
  '1y': 'Past year',
  all: 'All time',
};

function changeLine(change: SeriesChange | null, label: string, currency: string): { text: string; positive: boolean } | null {
  if (change === null) return null;
  const amount = Number(change.amount);
  const percent = Number(change.percent);
  if (!Number.isFinite(amount) || !Number.isFinite(percent)) return null;
  const suffix = label ? ` ${label}` : '';
  return {
    text: `${signedMoney(amount, currency)} (${Math.abs(percent).toFixed(2)}%)${suffix}`,
    positive: amount >= 0,
  };
}

/** The symbol's series for `range`. While the account is still loading the
 *  series counts as pending, not missing. `previous` is the last series drawn
 *  for this symbol in another range, kept on screen while a new range loads. */
function useMarketSeries(symbol: string, range: PortfolioRange, accountId: string | null, accountLoading: boolean): {
  series: SymbolSeries | undefined;
  pending: boolean;
  previous: { series: SymbolSeries; range: PortfolioRange } | undefined;
} {
  const [response, setResponse] = useState<MarketSeries | null>(null);
  const [pending, setPending] = useState(true);
  // Bumped to run the request again when the member returns to the window
  // with a stale response in hand.
  const [generation, setGeneration] = useState(0);
  const responseRef = useRef<MarketSeries | null>(null);
  useEffect(() => {
    const onFocus = (): void => {
      const current = responseRef.current;
      if (current === null) return;
      const nowMs = Date.now();
      const asOfMs = Date.parse(current.asOf);
      const stale = !Number.isFinite(asOfMs) || nowMs - asOfMs >= SERIES_REFOCUS_STALE_MS ||
        (current.range === '1d' && current.series.some((item) => seriesDayIsBehind(item, nowMs)));
      if (stale) setGeneration((value) => value + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  useEffect(() => {
    if (accountId === null) {
      setPending(accountLoading);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPending(true);
    const request = async (attempt: number): Promise<void> => {
      // Name the symbol: without it the series covers held positions only, so a
      // stock opened from a list or search would never chart.
      const next = await window.dataSources.marketSeries(accountId, range, [symbol]);
      if (cancelled) return;
      responseRef.current = next;
      setResponse(next);
      // Ask again while the cache is still filling, while there is nothing
      // to draw, or while a 1D series still charts an earlier day than today.
      const own = next.series.find((item) => item.symbol === symbol);
      const wantsMore = next.pendingSymbols.includes(symbol) || next.refreshingSymbols.includes(symbol) ||
        (own !== undefined && own.points.length === 0) ||
        (range === '1d' && own !== undefined && seriesDayIsBehind(own, Date.now()));
      if (wantsMore && attempt < SERIES_RETRY_LIMIT) {
        timer = setTimeout(() => void request(attempt + 1), SERIES_RETRY_MS);
        return;
      }
      setPending(false);
    };
    void request(0).catch(() => {
      if (!cancelled) setPending(false);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [symbol, range, accountId, accountLoading, generation]);
  const own = response?.series.find((item) => item.symbol === symbol);
  const series = response?.range === range ? own : undefined;
  const previous = response !== null && response.range !== range && own !== undefined && own.points.length > 1
    ? { series: own, range: response.range as PortfolioRange }
    : undefined;
  return { series, pending, previous };
}

export function MarketDetail({ resolvedSymbol }: { resolvedSymbol?: string } = {}): React.JSX.Element {
  const params = useParams({ strict: false }) as { symbol?: string };
  const symbol = (resolvedSymbol ?? params.symbol ?? '').toUpperCase();
  const [range, setRange] = useState<PortfolioRange>('1d');
  const [hoverPoint, setHoverPoint] = useState<MarketHoverPoint | null>(null);
  const [market, setMarket] = useState<MarketFacts | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [view, setView] = useState<PortfolioView | null>(null);
  const [viewLoading, setViewLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setMarket(null);
    setMarketLoading(true);
    void window.dataSources.marketDetails(symbol).then((detail) => {
      if (!cancelled) setMarket(detail);
    }).catch(() => {
      if (!cancelled) setMarket(null);
    }).finally(() => {
      if (!cancelled) setMarketLoading(false);
    });
    void window.portfolio.snapshot().then((data) => {
      if (!cancelled) setView(data);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setViewLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const holding = useMemo(() => portfolioHoldings(view).find(
    (position) => position.assetClass === 'equity' && position.symbol.toUpperCase() === symbol,
  ), [view, symbol]);
  const accountId = view?.account?.selected && view.account.available ? view.account.id : null;
  const { series, pending, previous } = useMarketSeries(symbol, range, accountId, viewLoading);
  // Nothing to show yet and something is still on its way: draw placeholders.
  const priceLoading = series === undefined && holding?.markPrice == null && (pending || viewLoading);
  const currency = view?.portfolio?.currency ?? 'USD';

  // Outside regular hours the extended-hours trade and move lead, as on
  // Robinhood; scrubbing the chart swaps in the hovered bar against baseline.
  const header = useMemo(() => {
    if (series === undefined) {
      const fallback = holding?.markPrice ?? null;
      return { price: fallback ? money(fallback, currency) : '—', change: null as { text: string; positive: boolean } | null };
    }
    if (hoverPoint !== null) {
      const base = series.baseline === null ? Number.NaN : Number(series.baseline.price);
      const change = Number.isFinite(base) && base !== 0
        ? { amount: String(hoverPoint.value - base), percent: String(((hoverPoint.value - base) / base) * 100) }
        : null;
      // No "Past X"/"Today" label while scrubbing a specific point.
      return { price: money(hoverPoint.value, currency), change: changeLine(change, '', currency) };
    }
    // Only the 1D view leads with the extended-hours move; longer ranges
    // report the period change, as Robinhood does.
    const extended = range === '1d' && series.extendedChange !== null && series.extendedSession !== null;
    const price = (extended ? series.extendedPrice : null) ?? series.price ?? series.extendedPrice;
    return {
      price: price === null ? '—' : money(price, currency),
      change: extended
        ? changeLine(series.extendedChange, extendedSessionLabels[series.extendedSession!], currency)
        : changeLine(series.change, periodLabels[range], currency),
    };
  }, [series, hoverPoint, holding, currency, range]);

  const regularPositive = Number(series?.change?.amount ?? series?.extendedChange?.amount ?? 0) >= 0;

  const title = market?.displayName !== undefined && market.displayName.toUpperCase() !== symbol
    ? market.displayName
    : symbol;

  return (
    <div className="space-y-8">
      <Link to="/portfolio" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Back
      </Link>

      <SidePanelLayout
        aside={<MarketHoldersPanel activity={assetActivity(view,symbol)} symbol={symbol} holding={holding} strategies={view?.strategies ?? []} currency={currency} series={series} />}
        sticky
        className="space-y-8"
      >
      <section aria-labelledby="market-heading">
        <div className="flex items-start justify-between gap-4">
          <h1 id="market-heading" className="font-display text-[26px] tracking-[-0.02em]">{title}</h1>
          <AddToListMenu target={{ kind: 'market', market: { identity: { venue: 'robinhood', instance: 'production', reference: symbol, kind: 'equity' }, symbol, ...(title !== symbol ? { name: title } : {}) } }} />
        </div>
        {title !== symbol && <p className="text-xs text-muted-foreground">{symbol}</p>}
        {priceLoading ? (
          <div role="status" aria-label="Loading price" className="mt-2 space-y-2">
            <Skeleton className="h-9 w-44 rounded-md" />
            <Skeleton className="h-4 w-36" />
          </div>
        ) : (
          <p className="font-display mt-1 text-[32px] tracking-[-0.03em]">
            <RollingNumber value={header.price} />
          </p>
        )}
        {!priceLoading && header.change !== null && (
          <p className={cn('mt-1 text-[13px] font-medium', header.change.positive ? 'text-success' : 'text-error')}>
            <RollingNumber value={header.change.text} />
          </p>
        )}
        {series?.bounds === '24_5' && (
          <p className="mt-2 text-xs font-semibold">24 Hour Market</p>
        )}

        <div className="mt-6 h-[clamp(14rem,40vh,28rem)]">
          {series !== undefined && series.points.length > 1 ? (
            <MarketChart series={series} range={range} positive={regularPositive} onHoverPoint={setHoverPoint} />
          ) : pending && previous !== undefined ? (
            // A new range is loading: keep the last chart, dimmed, instead of blanking.
            <div role="status" aria-label={`Loading ${range.toUpperCase()} price history`} className="relative h-full">
              <div className="pointer-events-none h-full opacity-40 transition-opacity">
                <MarketChart series={previous.series} range={previous.range} positive={Number(previous.series.change?.amount ?? 0) >= 0} />
              </div>
            </div>
          ) : pending ? (
            <div role="status" aria-label="Loading price history" className="flex h-full flex-col justify-end gap-3 pb-2">
              <Skeleton className="h-full w-full rounded-lg opacity-60" />
            </div>
          ) : accountId === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <p>Connect Robinhood to see price history.</p>
              <Link to="/settings" search={{ section: 'connections' }} className="text-xs underline hover:text-foreground">Manage connections</Link>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No price history available for this range.
            </div>
          )}
        </div>
        <div className="flex items-center justify-start gap-1 border-b border-border py-2">
          {ranges.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 rounded-none border-b-2 text-sm uppercase hover:bg-transparent',
                candidate === range ? 'border-brand font-semibold text-brand' : 'border-transparent text-muted-foreground',
              )}
              onClick={() => {
                setHoverPoint(null);
                setRange(candidate);
              }}
            >
              {candidate}
            </Button>
          ))}
        </div>
      </section>

      <MarketFundamentals loading={marketLoading} fundamentals={market?.fundamentals ?? undefined} currency={currency} earnings={<MarketEarnings symbol={symbol} currency={currency} />} renderStatistics={(statistics) => <MarketResearchTabs key={symbol} symbol={symbol} currency={currency} statistics={statistics} />} />
      </SidePanelLayout>
    </div>
  );
}
