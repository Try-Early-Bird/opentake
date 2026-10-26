import {TakeVersionBannerTarget} from '../strategies/TakeVersionChanges';
import { StrategyActivityPanel } from '../strategies/StrategyActivityPanel';
import { TakeAccountPlan } from '../strategies/TakeAccountPlan';
import { supportsBasketExecution,hasPendingInstrumentSupport } from '../../../shared/strategies';
import { useTakeIcon } from '../components/TakeIcon';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, ArrowLeft, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '../lib/utils';
import { money, signedPercent } from '../portfolio/format';
import { Button } from '../components/ui/button';
import { useLogos } from '../components/HoldingLogo';
import { MarketChart, MARKER_COLORS, type ChartMarker, type ChartOverlay, type MarketHoverPoint, type MarkerCopy } from '../components/MarketChart';
import { RollingNumber } from '../components/RollingNumber';
import { SidePanelLayout } from '../components/SidePanelLayout';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import type { SeriesPoint, SymbolSeries } from '../market-series';
import type { PortfolioRange } from '../portfolio-history';
import type { BasketSpec } from '../../../shared/strategies';
import type { PointReadout } from '../../../shared/strategy-performance';
import { alignBenchmark, BENCHMARK_COLORS, benchmarkKey, dailyClosesOf, lineStats, loadBenchmarks, saveBenchmarks, withReinvestedYield, type Benchmark } from '../strategies/benchmarks';
import type { StrategyCardData, StrategyCardWeight } from '../strategies/preview-data';
import { StrategyHoldingsList } from '../strategies/StrategyCard';
import { FollowPanel } from '../strategies/FollowPanel';
import { StrategyKeyStats } from '../strategies/StrategyKeyStats';
import { AddToListMenu } from '../components/AddToListMenu';

// Self-hosted, a strategy is
// one of your local takes' committed baskets: there is no catalog, author or
// other investors, so publishing, archiving, lists and the investor counts
// are hosted-only and left out; the take is where a strategy is edited. The
// chart reads the local performance engine, and
// the markers are your own money in and out.
// One strategy's page, draft or published: the model-portfolio chart first
// (a unit index starting at 100), then holdings and description. Drafts the
// member owns are backtested on demand by the API from daily closes; the
// chart draws backtested days at reduced opacity, the way extended hours are
// drawn on a market chart.

type PerformanceRange = '1d' | '1w' | '1m' | '3m' | '1y' | '3y' | '5y' | 'all';
type RebalanceSchedule = 'daily' | 'monthly' | 'quarterly' | 'annual' | 'never';
interface RebalanceRule { schedule: RebalanceSchedule; driftBandPoints: number | null; driftBandRelative: number | null }

// The model line reaches back through the backtest; actual results start at
// launch and use the same slices as the Markets and Portfolio charts.
const MODEL_RANGES: readonly PerformanceRange[] = ['1m', '3m', '1y', '3y', '5y', 'all'];
const ACTUAL_RANGES: readonly PerformanceRange[] = ['1d', '1w', '1m', '3m', '1y', 'all'];
/** Days of history a slice needs before it shows anything the next-shorter slice does not. */
const RANGE_DAYS: Partial<Record<PerformanceRange, number>> = { '1w': 7, '1m': 30, '3m': 91, '1y': 365, '3y': 3 * 365, '5y': 5 * 365 };

/** A slice on the actual basis is worth offering only once the history is at least that long; 1D and ALL always are. */
function actualRangeAvailable(candidate: PerformanceRange, since: string | null): boolean {
  const needed = RANGE_DAYS[candidate];
  if (needed === undefined) return true;
  if (since === null) return false;
  return (Date.now() - Date.parse(since)) / 86_400_000 >= needed;
}

const rangeLabel: Record<PerformanceRange, string> = { '1d': 'Today', '1w': 'Past week', '1m': 'Past month', '3m': 'Past 3 months', '1y': 'Past year', '3y': 'Past 3 years', '5y': 'Past 5 years', all: 'All time' };

const scheduleShort: Record<RebalanceSchedule, string> = { daily: 'Daily', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly', never: 'Buy & hold' };

function lastRebalanceLabel(iso: string): string | null {
 const at=new Date(iso);
 if(Number.isNaN(at.getTime()))return null;
 const time=at.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
 const now=new Date();
 if(at.toDateString()===now.toDateString())return `today at ${time}`;
 if(at.toDateString()===new Date(now.getTime()-86_400_000).toDateString())return `yesterday at ${time}`;
 return at.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

function rebalanceSentence(rule: RebalanceRule): string {
  const when: Record<RebalanceSchedule, string | null> = {
    daily: 'every trading day',
    monthly: 'on the first trading day of each month',
    quarterly: 'on the first trading day of each quarter',
    annual: 'on the first trading day of each year',
    never: null,
  };
  const parts: string[] = [];
  if (when[rule.schedule] !== null) parts.push(when[rule.schedule]!);
  if (rule.driftBandPoints !== null || rule.driftBandRelative !== null) {
    const bands: string[] = [];
    if (rule.driftBandPoints !== null) bands.push(`${rule.driftBandPoints} percentage points`);
    if (rule.driftBandRelative !== null) bands.push(`${rule.driftBandRelative}% of its target`);
    parts.push(`on any day a holding drifts more than ${bands.join(' or ')} from its weight`);
  }
  return parts.length === 0 ? 'held as bought, never rebalanced' : `rebalanced to target weights ${parts.join(', and ')}`;
}

function hoverDayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

interface PerformancePoint extends PointReadout {
  day: string;
  unitValue: string;
  source: 'backtested' | 'live';
}

type PerformanceBasis = 'model' | 'actual';

interface StrategyPerformance {
  unavailableReason?: string;
  strategyId: string;
  range: PerformanceRange;
  basis: PerformanceBasis;
  /** At least one investor bucket has traded, so an actual line exists. */
  actualAvailable: boolean;
  investors: number;
  /** When actual results begin; null when no investor has traded. */
  actualSince: string | null;
  /** Today's live line on the actual basis for 1D; null otherwise. */
  intraday: {
    sessionDate: string | null;
    dayStart: string | null;
    dayEnd: string | null;
    points: ({ t: string; c: string; s: 'overnight' | 'pre' | 'regular' | 'post' } & PointReadout)[];
  } | null;
  rebalance: RebalanceRule;
  /** When investors' buckets were last returned to target, newest across them; null when none has been planned. */
  lastRebalancedAt: string | null;
  dividends: 'reinvested_at_current_yield' | 'excluded';
  points: PerformancePoint[];
  stats: { source: 'backtested' | 'paper' | 'live'; allTimeReturnPercent: string | null; oneDayReturnPercent: string | null }[];
}

/** A local strategy as the page needs it: the committed version (else the draft) of its take's basket. */
interface OwnedStrategy {
  iconId: string | null;
  id: string;
  takeId: string;
  displayName: string;
  description: string | null;
  status: 'draft' | 'committed' | 'archived';
  spec: BasketSpec;
  /** When the first version still in view was committed; stands in for the hosted publish date. */
  publishedAt: string | null;
  versionNumber: number;
}

type MarketFacts = Pick<StrategyCardWeight, 'displayName' | 'logoUrl' | 'currentPrice' | 'previousClose'>;

async function loadOwnedStrategy(strategyId: string): Promise<OwnedStrategy | null> {
  const [active, archived] = await Promise.all([window.strategies.list(false), window.strategies.list(true)]);
  const summary = [...active, ...archived].find((item) => item.strategyId === strategyId);
  if (summary === undefined) return null;
  const view = await window.strategies.read(summary.targetTakeId);
  if (view === null) return null;
  const current = view.versions.find((version) => version.id === view.currentVersion) ?? null;
  const payload = current?.payload ?? view.draft;
  const first = [...view.versions].sort((left, right) => left.sequence - right.sequence)[0];
  return {
    iconId: view.iconId ?? null,
    id: strategyId,
    takeId: summary.targetTakeId,
    displayName: view.title,
    description: payload.metadata.description || null,
    status: view.archivedAt !== null ? 'archived' : current === null ? 'draft' : 'committed',
    spec: payload.spec,
    publishedAt: first?.createdAt ?? null,
    versionNumber: current?.sequence ?? 1,
  };
}

/**
 * Names, logos and the last two prices for the holdings: read locally.
 * Logos come from the local cache, prices from
 * the 1D series (price and previous close), names from the connection.
 */
function useLocalMarketFacts(symbols: readonly string[]): ReadonlyMap<string, MarketFacts> {
  const key = symbols.join(',');
  const logos = useLogos(symbols);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [prices, setPrices] = useState<Map<string, { currentPrice: string | null; previousClose: string | null }>>(new Map());
  useEffect(() => {
    let cancelled = false;
    if (symbols.length === 0) return;
    void window.portfolio.snapshot().then(async (view) => {
      const accountId = view.account?.selected && view.account.available ? view.account.id : null;
      if (accountId === null) return;
      const series = await window.dataSources.marketSeries(accountId, '1d', [...symbols]);
      if (cancelled) return;
      setPrices(new Map(series.series.map((item) => [item.symbol, { currentPrice: item.extendedPrice ?? item.price, previousClose: item.baseline?.kind === 'previous_close' ? item.baseline.price : null }])));
    }).catch(() => {});
    void (async () => {
      for (const symbol of symbols) {
        const detail = await window.dataSources.marketDetails(symbol).catch(() => null);
        if (cancelled) return;
        if (detail !== null && detail.displayName !== symbol) setNames((current) => new Map(current).set(symbol, detail.displayName));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => new Map(symbols.map((symbol) => [symbol, {
    displayName: names.get(symbol) ?? null,
    logoUrl: logos.get(symbol) ?? null,
    ...(prices.get(symbol) ?? {}),
  }])), [symbols, names, logos, prices]);
}

function cardFromOwned(strategy: OwnedStrategy, facts: ReadonlyMap<string, MarketFacts>): StrategyCardData {
  return {
    id: strategy.id,
    displayName: strategy.displayName,
    description: strategy.description,
    iconUrl: null,
    author: { name: 'You', handle: null, earlybirdHandle: null },
    targets: {
      complete: true,
      cashReserveBps: strategy.spec.target.cashBps,
      weights: strategy.spec.target.weights.map((weight) => ({
        symbol: weight.instrument.symbol,
        venue: weight.instrument.venue,
        market: weight.instrument.market,
        weightBps: weight.bps,
        ...(weight.instrument.venue === 'robinhood' && !weight.instrument.market ? facts.get(weight.instrument.symbol) ?? {} : {}),
      })),
    },
    stats: [],
    version: { number: strategy.versionNumber },
  };
}

/** One label-over-value figure in the page header, beside the title. */
function HeaderStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{value}</dd>
    </div>
  );
}

/** The unit-value series in the shape the market chart draws: live days regular, backtested days "extended". */
function seriesFromPerformance(performance: StrategyPerformance, continuous=false): SymbolSeries | null {
  // Today's live line: real bar times and sessions, yesterday's close as 100.
  if (performance.intraday !== null) {
    const points = performance.intraday.points;
    const last = points[points.length - 1];
    if (last === undefined) return null;
    const change = Number(last.c) - 100;
    return {
      symbol: performance.strategyId,
      interval: continuous?'hour':'5minute',
      bounds: continuous?'regular':'24_5',
      ...(performance.intraday.sessionDate === null ? {} : { sessionDate: performance.intraday.sessionDate }),
      ...(performance.intraday.dayStart === null || performance.intraday.dayEnd === null
        ? {}
        : { dayStart: performance.intraday.dayStart, dayEnd: performance.intraday.dayEnd }),
      baseline: { price: '100', kind: 'previous_close' },
      price: last.c,
      extendedPrice: null,
      extendedSession: null,
      change: { amount: String(change), percent: String(change) },
      extendedChange: null,
      points: points.map((point) => ({ t: point.t, c: point.c, s: point.s })),
    };
  }
  if (performance.points.length < 2) return null;
  const first = performance.points[0]!;
  const last = performance.points[performance.points.length - 1]!;
  const change = Number(last.unitValue) - Number(first.unitValue);
  return {
    symbol: performance.strategyId,
    interval: 'day',
    bounds: 'regular',
    baseline: { price: first.unitValue, kind: 'window_open' },
    price: last.unitValue,
    extendedPrice: null,
    extendedSession: null,
    change: { amount: String(change), percent: String((change / Number(first.unitValue)) * 100) },
    extendedChange: null,
    // Closes are end of the Eastern trading day; 21:00 UTC sits inside it year-round.
    points: performance.points.map((point) => ({
      t: `${point.day}T21:00:00.000Z`,
      c: point.unitValue,
      s: point.source === 'live' ? 'regular' : 'post',
    })),
  };
}

interface BenchmarkLine {
  benchmark: Benchmark;
  /** Rebased to 100 on the strategy's first day; empty while loading or when nothing matched. */
  points: { day: string; value: number }[];
  pending: boolean;
}

const BENCHMARK_RETRY_MS = 1500;
const BENCHMARK_RETRY_LIMIT = 8;

/** Daily closes for one benchmark over the range: a symbol's series, or another strategy's unit index. */
async function loadBenchmarkCloses(benchmark: Benchmark, range: PerformanceRange): Promise<{ closes: { day: string; close: number }[]; pending: boolean }> {
  if (benchmark.kind === 'strategy') {
    const result = await window.strategies.performance(benchmark.strategyId, range, 'model');
    const points = result?.points ?? [];
    return { closes: points.map((point) => ({ day: point.day, close: Number(point.unitValue) })), pending: false };
  }
  const seriesRange = range === '3y' || range === '5y' ? 'all' : range;
  const view = await window.portfolio.snapshot();
  const accountId = view.account?.selected && view.account.available ? view.account.id : null;
  const response = accountId === null ? null : await window.dataSources.marketSeries(accountId, seriesRange, [benchmark.symbol]);
  const series = response?.series.find((item) => item.symbol === benchmark.symbol);
  const raw = dailyClosesOf(series?.points ?? []);
  const pending = response !== null && (response.pendingSymbols.length > 0 || raw.length === 0);
  // Same dividend treatment as the strategy line: the trailing yield, reinvested as a steady accrual.
  const fundamentals = (await window.portfolio.fundamentals([benchmark.symbol]).catch(() => ({} as Record<string, Record<string, unknown>>)))[benchmark.symbol];
  const rawYield = fundamentals?.dividend_yield ?? fundamentals?.dividendYield;
  const yieldPercent = typeof rawYield === 'number' ? rawYield : typeof rawYield === 'string' ? Number(rawYield.replaceAll(',', '')) : Number.NaN;
  const closes = withReinvestedYield(raw, Number.isFinite(yieldPercent) && yieldPercent >= 0 && yieldPercent < 100 ? yieldPercent : null);
  return { closes, pending };
}

/** Rebased benchmark lines for the current strategy days; re-polls symbols the cache is still filling. */
function useBenchmarkLines(benchmarks: readonly Benchmark[], range: PerformanceRange, strategyDays: readonly string[]): BenchmarkLine[] {
  const [closesByKey, setClosesByKey] = useState<Map<string, { closes: { day: string; close: number }[]; pending: boolean }>>(new Map());
  const keys = benchmarks.map(benchmarkKey).join(',');
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setClosesByKey(new Map());
    for (const benchmark of benchmarks) {
      const key = benchmarkKey(benchmark);
      const request = async (attempt: number): Promise<void> => {
        const next = await loadBenchmarkCloses(benchmark, range).catch(() => ({ closes: [], pending: false }));
        if (cancelled) return;
        setClosesByKey((current) => new Map(current).set(key, next));
        if (next.pending && attempt < BENCHMARK_RETRY_LIMIT) timers.push(setTimeout(() => void request(attempt + 1), BENCHMARK_RETRY_MS));
      };
      void request(0);
    }
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [keys, range]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => benchmarks.map((benchmark) => {
    const entry = closesByKey.get(benchmarkKey(benchmark));
    return {
      benchmark,
      points: entry === undefined ? [] : alignBenchmark(strategyDays, entry.closes),
      pending: entry === undefined || entry.pending,
    };
  }), [benchmarks, closesByKey, strategyDays]);
}

/** Search box for adding a benchmark: symbols from the market search, strategies from your own. */
function BenchmarkPicker({ exclude, strategies, onPick, onClose }: {
  exclude: ReadonlySet<string>;
  strategies: readonly { id: string; displayName: string; author: string }[];
  onPick: (benchmark: Benchmark) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ symbol: string; displayName: string }[]>([]);
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 1) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.portfolio.search(needle).then((markets) => {
        if (cancelled) return;
        setHits(markets.slice(0, 6));
      }).catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  const needle = query.trim().toLowerCase();
  const strategyHits = needle === '' ? [] : strategies.filter((item) => item.displayName.toLowerCase().includes(needle)).slice(0, 4);
  return (
    <div className="relative w-full max-w-sm">
      <label className="flex h-8 items-center gap-2 border-b border-border transition-colors focus-within:border-foreground">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
          placeholder="Symbol, ETF, or take"
          aria-label="Add a benchmark"
          autoFocus
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-muted-foreground hover:text-foreground"><X size={13} /></button>
      </label>
      {(hits.length > 0 || strategyHits.length > 0) && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg" role="listbox">
          {hits.filter((hit) => !exclude.has(`symbol:${hit.symbol.toUpperCase()}`)).map((hit) => (
            <li key={`s-${hit.symbol}`}>
              <button
                type="button"
                onClick={() => onPick({ kind: 'symbol', symbol: hit.symbol.toUpperCase(), label: hit.symbol.toUpperCase(), detail: hit.displayName })}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <span className="w-14 shrink-0 font-medium">{hit.symbol.toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{hit.displayName}</span>
              </button>
            </li>
          ))}
          {strategyHits.filter((item) => !exclude.has(`strategy:${item.id}`)).map((item) => (
            <li key={`t-${item.id}`}>
              <button
                type="button"
                onClick={() => onPick({ kind: 'strategy', strategyId: item.id, label: item.displayName, detail: `take by ${item.author}` })}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <span className="w-14 shrink-0 font-medium text-muted-foreground">Take</span>
                <span className="min-w-0 flex-1 truncate">{item.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "4y 2m" between two ISO instants, or null under a month. */
function runningFor(fromIso: string, toMs: number): string | null {
  const months = Math.floor((toMs - Date.parse(fromIso)) / (30.44 * 86_400_000));
  if (!(months >= 1)) return null;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return years === 0 ? `${rest}m` : rest === 0 ? `${years}y` : `${years}y ${rest}m`;
}

/** Compound annual rate between two unit values, null under a year (where it would only mislead). */
function annualizedPercent(firstDay: string, lastDay: string, first: number, last: number): number | null {
  const years = (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / (365.25 * 86_400_000);
  if (!(years >= 1) || first <= 0 || last <= 0) return null;
  return ((last / first) ** (1 / years) - 1) * 100;
}

/** Remembered per device: whether the strategy chart shows investors' money in and out. */

const MARKER_VERB = { invested: 'invested', deposit: 'deposited', withdrew: 'withdrew', closed: 'closed out' } as const;

/**
 * What a marker says: a headline with the total, and for a group a short
 * breakdown by action. "3 investors put in $170.00" / "2 new, 1 added";
 * "2 investors took out $25.00" / "1 withdrew, 1 left keeping shares".
 */
export function markerCopy(marker: ChartMarker): MarkerCopy {
  const withAmount = (amount: string | null) => (amount === null ? '' : ` ${money(amount)}`);
  const breakdown = marker.breakdown ?? [];
  const single = breakdown.length <= 1;
  const onlyKind = breakdown[0]?.kind ?? (Object.keys(marker.kinds)[0] as keyof typeof MARKER_VERB | undefined);
  // A close that sold nothing is someone leaving with their shares.
  const keptShares = (entry: { kind: string; amount: string | null }) => entry.kind === 'closed' && entry.amount === null;
  const verb = single && onlyKind !== undefined
    ? keptShares({ kind: onlyKind, amount: marker.amount }) ? 'left keeping shares' : MARKER_VERB[onlyKind]
    : marker.direction === 'in' ? 'put in' : 'took out';
  const amount = verb === 'left keeping shares' ? '' : withAmount(marker.amount);
  const who = marker.party === 'viewer'
    ? 'You'
    : marker.party === 'owner'
      ? 'The author'
      : marker.members === 1 ? 'An investor' : `${marker.members} investors`;
  const detail = single
    ? null
    : breakdown.map((entry) => {
      const count = marker.party === 'others' ? `${entry.members} ` : '';
      if (entry.kind === 'invested') return marker.party === 'others' ? `${count}new` : 'invested';
      if (entry.kind === 'deposit') return marker.party === 'others' ? `${count}added` : 'deposited';
      if (keptShares(entry)) return `${count}left keeping shares`;
      return `${count}${MARKER_VERB[entry.kind]}${withAmount(entry.amount)}`;
    }).join(', ');
  return { text: `${who} ${verb}${amount}`, detail };
}

export function StrategyDetail(): React.JSX.Element {
  const params = useParams({ strict: false }) as { strategyId?: string };
  const navigate = useNavigate();
  const strategyId = params.strategyId ?? '';
  const [owned, setOwned] = useState<OwnedStrategy | null | undefined>(undefined);
  const [archiving, setArchiving] = useState(false);
  // No public catalog when self-hosted: every strategy is your own.
  const catalog: StrategyCardData | null = null;
  const [range, setRange] = useState<PerformanceRange>('1y');
  // Live strategies open on what investors actually got; the model line is a toggle away.
  const [basis, setBasis] = useState<PerformanceBasis>('model');
  const [basisChosen, setBasisChosen] = useState(false);
  const coinbaseOnly = !!owned?.spec.target.weights.length && owned.spec.target.weights.every(weight=>weight.instrument.venue==='coinbase');
  useEffect(()=>{
    // Every Take starts simulated until its performance response confirms actual history.
    // Reset on navigation so a previous Take's manual selection cannot leak into a draft.
    setBasis('model');setBasisChosen(false);setRange('1y');setHoverPoint(null);
  },[strategyId]);
  const [performance, setPerformance] = useState<StrategyPerformance | null | undefined>(undefined);
  const [hoverPoint, setHoverPoint] = useState<MarketHoverPoint | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The model-portfolio chart depends only on what was published, never on
  // who invested or deposited, so it refetches on its own key.
  const [performanceKey, setPerformanceKey] = useState(0);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>(() => loadBenchmarks());
  const [picking, setPicking] = useState(false);
  const [catalogList, setCatalogList] = useState<{ id: string; displayName: string; author: string }[]>([]);
  const updateBenchmarks = (next: Benchmark[]): void => {
    setBenchmarks(next);
    saveBenchmarks(next);
  };

  // The strategy itself, from your local takes.
  useEffect(() => {
    let cancelled = false;
    void loadOwnedStrategy(strategyId).then((mine) => {
      if (!cancelled) setOwned(mine);
    }).catch(() => {
      if (!cancelled) setOwned(null);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId, reloadKey]);

  // Your other strategies, for the benchmark picker.
  useEffect(() => {
    let cancelled = false;
    void window.strategies.list(false).then((rows) => {
      if (cancelled) return;
      setCatalogList(rows.filter((item) => item.strategyId !== strategyId).map((item) => ({ id: item.strategyId, displayName: item.title, author: 'you' })));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [strategyId]);

  // What you have in it: your allocations' value, beside the title.
  const [investedValue, setInvestedValue] = useState<string | null>(null);
  const [investors, setInvestors] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void window.portfolio.snapshot().then((view) => {
      if (cancelled) return;
      const mine = (view.strategies ?? []).filter((item) => item.strategyId === strategyId);
      // Self-hosted, every investor is you: one per allocation following it.
      setInvestors(mine.length);
      setInvestedValue(mine.length === 0 || mine.some((item) => item.value === null) ? null : String(mine.reduce((sum, item) => sum + Number(item.value), 0)));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [strategyId, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setPerformance(undefined);
    void window.strategies.performance(strategyId, range, basis).catch(() => null).then((result) => {
      if (cancelled) return;
      const next = result as StrategyPerformance | null;
      // First load of a live strategy: switch to actual results once we know they exist.
      // A live strategy opens on today's actual line.
      if (next !== null && !basisChosen && basis === 'model' && next.actualAvailable) {
        setBasisChosen(true);
        setBasis('actual');
        setRange('1d');
        return;
      }
      setPerformance(next);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId, range, basis, basisChosen, performanceKey]);

  // Always show investment activity when chart markers are available.
  const [markers, setMarkers] = useState<ChartMarker[]>([]);
  useEffect(() => {
    let cancelled = false;
    // A dev app whose preload predates this bridge has no such call; the chart just has no markers.
    const load = window.strategies.markers as typeof window.strategies.markers | undefined;
    if (load === undefined) return;
    void load(strategyId, range).then((result) => {
      if (!cancelled) setMarkers(result as ChartMarker[]);
    }).catch(() => {
      if (!cancelled) setMarkers([]);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId, range, performanceKey]);
  const symbols = useMemo(() => (owned?.spec.target.weights.filter(weight => weight.instrument.venue === 'robinhood' && !weight.instrument.market).map((weight) => weight.instrument.symbol) ?? []).sort(), [owned]);
  const researchOnly = owned ? !supportsBasketExecution(owned.spec) : false;
  useEffect(()=>{
    if(!researchOnly)return;
    const refresh=()=>setPerformanceKey(key=>key+1);
    const timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);
    return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[researchOnly,strategyId]);
  const facts = useLocalMarketFacts(symbols);
  const iconUrl = useTakeIcon(owned?.iconId);
  const card: StrategyCardData | null = owned ? { ...cardFromOwned(owned, facts), iconUrl, investors, investedValue, ownerInvestedValue: investedValue } : (catalog ?? null);

  const series = useMemo(() => (performance ? seriesFromPerformance(performance,researchOnly) : null), [performance,researchOnly]);
  const strategyDays = useMemo(() => (performance?.points ?? []).map((point) => point.day), [performance]);
  const benchmarkLines = useBenchmarkLines(benchmarks, range, strategyDays);
  const overlays = useMemo<ChartOverlay[]>(() => benchmarkLines.map((line, index) => ({
    key: benchmarkKey(line.benchmark),
    color: BENCHMARK_COLORS[index % BENCHMARK_COLORS.length]!,
    points: line.points.map((point) => ({ timestamp: Date.parse(`${point.day}T21:00:00.000Z`), value: point.value })),
  })), [benchmarkLines]);
  const excluded = useMemo(() => new Set(benchmarks.map(benchmarkKey)), [benchmarks]);
  const strategyStats = useMemo(() => lineStats((performance?.points ?? []).map((point) => ({ day: point.day, value: Number(point.unitValue) }))), [performance]);
  const benchmarkStats = useMemo(() => benchmarkLines.map((line) => lineStats(line.points)), [benchmarkLines]);
  const showRisk = strategyStats !== null && strategyStats.volatilityPercent !== null;
  const lastRebalanced=useMemo(()=>performance?.lastRebalancedAt==null?null:lastRebalanceLabel(performance.lastRebalancedAt),[performance]);
  const backtestedOnly = performance !== null && performance !== undefined
    && performance.points.length > 0 && performance.points.every((point) => point.source === 'backtested');

  // Header number: return since the start of the range, or at the hovered day.
  const header = useMemo(() => {
    if (series === null) return null;
    const base = Number(series.baseline?.price ?? series.points[0]?.c ?? 'NaN');
    const current = hoverPoint !== null ? hoverPoint.value : Number(series.price ?? 'NaN');
    if (!Number.isFinite(base) || !Number.isFinite(current) || base === 0) return null;
    const percent = ((current - base) / base) * 100;
    return { value: current, percent, positive: percent >= 0 };
  }, [series, hoverPoint]);

  // While a point is hovered, Holdings and Key stats show its prices and your value; off the chart they flip back.
  const readouts = useMemo(() => {
    const byTime = new Map<number, PointReadout>();
    if (performance?.intraday) for (const point of performance.intraday.points) byTime.set(Date.parse(point.t), point);
    else for (const point of performance?.points ?? []) byTime.set(Date.parse(`${point.day}T21:00:00.000Z`), point);
    return byTime;
  }, [performance]);
  const hovered = useMemo(() => {
    if (hoverPoint === null) return null;
    const point = readouts.get(hoverPoint.timestamp);
    const label = performance?.intraday ? new Date(hoverPoint.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : hoverDayLabel(hoverPoint.timestamp).replace(/, \d{4}$/u, '');
    return { label, prices: point?.prices ?? {}, value: performance?.basis === 'actual' ? point?.value ?? null : null };
  }, [hoverPoint, readouts, performance]);

  // Yearly rate for ranges of a year or more, so a 5Y figure compares to anything else.
  const annualized = useMemo(() => {
    if (!performance || performance.points.length < 2 || hoverPoint !== null) return null;
    const first = performance.points[0]!;
    const last = performance.points[performance.points.length - 1]!;
    return annualizedPercent(first.day, last.day, Number(first.unitValue), Number(last.unitValue));
  }, [performance, hoverPoint]);

  const minimumAllocation = useMemo(() => {
    if (card === null) return null;
    // Sized like a subscription: the model's current weights once valued, else the targets.
    const current = card.targets.currentAsOf != null;
    const positive = card.targets.weights.map((weight) => (current ? (weight.currentWeightBps ?? weight.weightBps) : weight.weightBps) / 100).filter((weight) => weight > 0);
    if (positive.length === 0) return null;
    const smallest = Math.min(...positive);
    return Math.ceil(200 / smallest);
  }, [card]);

  const [versionBannerTarget,setVersionBannerTarget]=useState<HTMLDivElement|null>(null);
  const loading = owned === undefined;
  const isDraft = owned?.status === 'draft';
  const running = owned?.publishedAt ? runningFor(owned.publishedAt, Date.now()) : null;
  const statusLabel = [isDraft ? 'Draft' : owned?.status === 'archived' ? 'Archived' : null, running === null ? null : `Running ${running}`].filter(Boolean).join(' · ');

  return (
    <TakeVersionBannerTarget.Provider value={versionBannerTarget}>
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/takes"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Takes
        </Link>
        <div className="ml-auto flex items-center justify-end gap-1">
          {owned && (
            <Button size="icon-sm" variant="ghost" aria-label="Edit take" title="Edit take" onClick={() => void navigate({ to: '/', search: { takeId: owned.takeId } })}><Pencil size={16} aria-hidden="true" /></Button>
          )}
          {owned?.status === 'committed' && (
            <Button size="icon-sm" variant="ghost" aria-label="Archive take" title="Archive take" disabled={archiving}
              onClick={() => { setArchiving(true); void window.takes.update(owned.takeId, { archived: true }).finally(() => { setArchiving(false); setReloadKey((key) => key + 1); }); }}><Archive size={16} aria-hidden="true" /></Button>
          )}
        </div>
      </header>

      <div ref={setVersionBannerTarget} className="empty:hidden"/>

      {loading ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      ) : card === null ? (
        <div className="rounded-xl bg-muted/40 p-8 text-center">
          <h1 className="text-lg font-medium">Take not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">It may have been deleted, or it is not visible to you.</p>
        </div>
      ) : (
        <>
          <SidePanelLayout
            aside={researchOnly ? <div className="space-y-3 text-sm">
              {owned&&hasPendingInstrumentSupport(owned.spec)?<p>Robinhood crypto Takes are research-only. Funding and trading are not available yet.</p>:owned&&<><TakeAccountPlan key={owned.takeId} takeId={owned.takeId} showInvestment={!isDraft}/><DraftCommitLink takeId={owned.takeId} visible={isDraft}/></>}
              <StrategyActivityPanel strategyId={strategyId} reloadKey={reloadKey}/>
            </div> : isDraft&&owned ? <DraftCommitLink takeId={owned.takeId} visible/> : (
              <FollowPanel
                takeId={owned?.takeId}
                strategyId={strategyId}
                published={owned ? owned.status === 'committed' : false}
                minimumAllocation={minimumAllocation}
                onChanged={() => setReloadKey((key) => key + 1)}
              />
            )}
            sticky
            asideClassName={undefined}
            className="space-y-10"
          >
          <section aria-labelledby="strategy-heading">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                {card.iconUrl && (
                  <img src={card.iconUrl} alt="" className="size-12 shrink-0 rounded-xl object-cover" />
                )}
                <div className="min-w-0">
                  <h1 id="strategy-heading" className="font-display text-[26px] tracking-[-0.02em] [overflow-wrap:anywhere]">{card.displayName}</h1>
                  {statusLabel && <p className="text-xs text-muted-foreground">{statusLabel}</p>}
                </div>
              </div>
              <div className="flex shrink-0 items-start gap-3">
                <AddToListMenu target={{ kind: 'take', strategyId }} />
                {!isDraft && (
                  <dl className="hidden items-start gap-7 md:flex" aria-label="Take figures">
                    {owned?.publishedAt && (() => { const span = runningFor(owned.publishedAt, Date.now()); return span === null ? null : <HeaderStat label="Running" value={span} />; })()}
                  </dl>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              {/* Same size and weight as the Portfolio and market change lines. */}
              <p className={cn('flex items-baseline gap-1 text-[13px] font-medium tabular-nums', header === null ? 'text-muted-foreground' : header.positive ? 'text-success' : 'text-error')}>
                <RollingNumber value={header === null ? '—' : `${signedPercent(header.percent)} ${hoverPoint !== null ? hoverDayLabel(hoverPoint.timestamp) : rangeLabel[range]}`} />
                {annualized !== null && <span className="text-muted-foreground">· {signedPercent(annualized)} a year</span>}
                {hoverPoint?.markers !== undefined && hoverPoint.markers.map((marker) => (
                  <span key={`${marker.party}:${marker.direction}`} className="text-muted-foreground">
                    · <span style={{ color: MARKER_COLORS[marker.direction] }}>{marker.direction === 'in' ? '↑' : '↓'}</span> {markerCopy(marker).text}
                  </span>
                ))}
              </p>
            </div>

            {header !== null && (
              <table className="mt-3 w-full max-w-4xl border-collapse text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground">
                    <th className="w-4" />
                    <th className="pb-1 text-left font-normal">Over {rangeLabel[range].toLowerCase().replace('past ', 'the past ')}</th>
                    <th className="w-20 pb-1 text-right font-normal">Return</th>
                    {annualized !== null && <th className="w-20 pb-1 text-right font-normal">Per year</th>}
                    {showRisk && <th className="w-24 pb-1 text-right font-normal" title="Largest peak-to-trough fall in the range">Max drawdown</th>}
                    {showRisk && <th className="w-20 pb-1 text-right font-normal" title="Annualized standard deviation of returns; lower is steadier">Volatility</th>}
                    <th className="w-32 pb-1 text-right font-normal">vs this take</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr className="h-9">
                    <td className="w-4 pr-2"><span className="block h-0.5 w-3 rounded-full" style={{ backgroundColor: header.positive ? 'var(--success)' : 'var(--error)' }} aria-hidden="true" /></td>
                    <td className="font-medium">This take</td>
                    <td className={cn('w-20 text-right tabular-nums', header.positive ? 'text-success' : 'text-error')}>{signedPercent(header.percent)}</td>
                    {annualized !== null && <td className="w-20 text-right tabular-nums text-muted-foreground">{signedPercent(annualized)}</td>}
                    {showRisk && <td className="w-24 text-right tabular-nums text-muted-foreground">{strategyStats === null ? '' : `−${strategyStats.maxDrawdownPercent.toFixed(1)}%`}</td>}
                    {showRisk && <td className="w-20 text-right tabular-nums text-muted-foreground">{strategyStats?.volatilityPercent === null || strategyStats === null ? '' : `${strategyStats.volatilityPercent.toFixed(1)}%`}</td>}
                    <td className="w-32 text-right text-muted-foreground">—</td>
                    <td className="w-8" />
                  </tr>
                  {benchmarkLines.map((line, index) => {
                    const key = benchmarkKey(line.benchmark);
                    const color = BENCHMARK_COLORS[index % BENCHMARK_COLORS.length]!;
                    const hovered = hoverPoint?.overlays?.[key] ?? null;
                    const last = line.points[line.points.length - 1]?.value ?? null;
                    const value = hoverPoint !== null ? hovered : last;
                    const change = value === null ? null : value - 100;
                    const gap = change === null ? null : header.percent - change;
                    const stats = benchmarkStats[index] ?? null;
                    return (
                      <tr key={key} className="h-9">
                        <td className="w-4 pr-2"><span className="block h-0.5 w-3 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" /></td>
                        <td className="min-w-0">
                          <span className="font-medium">{line.benchmark.label}</span>
                          {line.benchmark.detail && <span className="ml-2 text-muted-foreground">{line.benchmark.detail}</span>}
                        </td>
                        <td className={cn('w-20 text-right tabular-nums', change === null ? 'text-muted-foreground' : change >= 0 ? 'text-success' : 'text-error')}>
                          {change === null ? (line.pending ? '…' : '—') : signedPercent(change)}
                        </td>
                        {annualized !== null && <td className="w-20 text-right tabular-nums text-muted-foreground">{stats?.annualizedPercent == null ? '' : signedPercent(stats.annualizedPercent)}</td>}
                        {showRisk && <td className="w-24 text-right tabular-nums text-muted-foreground">{stats === null ? '' : `−${stats.maxDrawdownPercent.toFixed(1)}%`}</td>}
                        {showRisk && <td className="w-20 text-right tabular-nums text-muted-foreground">{stats?.volatilityPercent == null ? '' : `${stats.volatilityPercent.toFixed(1)}%`}</td>}
                        <td className={cn('w-32 text-right text-xs tabular-nums', gap === null ? 'text-muted-foreground' : gap >= 0 ? 'text-success' : 'text-error')}>
                          {gap === null ? '' : `${Math.abs(gap).toFixed(2)} pts ${gap >= 0 ? 'ahead' : 'behind'}`}
                        </td>
                        <td className="w-8 text-right">
                          <button
                            type="button"
                            onClick={() => updateBenchmarks(benchmarks.filter((item) => benchmarkKey(item) !== key))}
                            aria-label={`Remove ${line.benchmark.label}`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="h-9">
                    <td colSpan={8}>
                      {picking ? (
                        <BenchmarkPicker
                          exclude={excluded}
                          strategies={catalogList}
                          onPick={(benchmark) => {
                            updateBenchmarks([...benchmarks, benchmark]);
                            setPicking(false);
                          }}
                          onClose={() => setPicking(false)}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPicking(true)}
                          disabled={benchmarks.length >= BENCHMARK_COLORS.length}
                          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                        >
                          <Plus size={13} />
                          {benchmarks.length >= BENCHMARK_COLORS.length
                            ? `Up to ${BENCHMARK_COLORS.length} comparisons; remove one to add another`
                            : `Compare symbol, ETF, or take${benchmarks.length > 0 ? ` (${benchmarks.length} of ${BENCHMARK_COLORS.length})` : ''}`}
                        </button>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            <div className="mt-6 h-[clamp(14rem,40vh,28rem)]">
              {series !== null ? (
                <MarketChart series={series} range={(range === '3y' || range === '5y' ? 'all' : range) as PortfolioRange} positive={header?.positive ?? true} onHoverPoint={setHoverPoint} overlays={overlays} markers={markers} describeMarker={markerCopy} />
              ) : (
                <div className={cn('flex h-full items-center justify-center text-sm text-muted-foreground', performance === undefined && 'animate-pulse')}>
                  {performance === undefined
                    ? 'Building the chart from daily closes…'
                    : performance?.unavailableReason ?? (owned?.spec.target.weights.some(weight => weight.instrument.venue !== 'robinhood') ? 'Coinbase price history is unavailable for this range.' : 'No price history for this range yet.')}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border py-2">
              <div className="flex items-center gap-1">
              {(basis === 'actual' ? ACTUAL_RANGES : MODEL_RANGES).map((candidate) => {
                const available = basis !== 'actual' || actualRangeAvailable(candidate, performance?.actualSince ?? null);
                return (
                  <Button
                    key={candidate}
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!available}
                    title={available ? undefined : 'Not enough history yet'}
                    className={cn(
                      'h-8 rounded-none border-b-2 text-sm uppercase hover:bg-transparent disabled:opacity-40',
                      candidate === range ? 'border-brand font-semibold text-brand' : 'border-transparent text-muted-foreground',
                    )}
                    onClick={() => {
                      setHoverPoint(null);
                      setRange(candidate);
                    }}
                  >
                    {candidate}
                  </Button>
                );
              })}
              </div>
              <div className="flex items-center gap-4">
              {(coinbaseOnly || performance?.actualAvailable || basis === 'actual') && (
                <div className="flex items-center gap-3 text-xs" aria-label="Chart basis">
                  {([
                    { id: 'actual', label: 'Actual' },
                    { id: 'model', label: 'Simulated' },
                  ] as const).map((option) => (
                    <Tooltip key={option.id}>
                    <TooltipTrigger
                      type="button"
                      aria-pressed={basis === option.id}
                      onClick={() => {
                        setBasisChosen(true);
                        setHoverPoint(null);
                        setBasis(option.id);
                        // Actual opens on today; the model line keeps a slice it offers.
                        if (option.id === 'actual') setRange('1d');
                        else if (!MODEL_RANGES.includes(range)) setRange('1y');
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 font-medium transition-colors',
                        basis === option.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {option.label}
                    </TooltipTrigger>
                    {performance?<>
                  <TooltipContent side="top" className="max-w-72">
                    {option.id === 'actual'
                      ? researchOnly ? 'Actual Take holdings marked with Coinbase candle history and the latest account prices. Includes trading fees; deposits and withdrawals are removed from returns.' : `What investors actually got: real fills across every traded account, marked to ${range === '1d' ? 'live prices' : "each day's closes"} and value-weighted, with deposits taken out. The take is ${rebalanceSentence(performance.rebalance)}.`
                      : <>Growth of $100 put into this mix at the start of the range, marked to each day's closes and {rebalanceSentence(performance.rebalance)}.</>}
                    {performance.basis === option.id && performance.dividends === 'reinvested_at_current_yield'
                      ? ' Dividends are assumed reinvested at each holding\u2019s current yield, for benchmarks too; an estimate, since payment history is not available. To match that in your own account, turn on dividend reinvestment for your Robinhood Agentic account. Earlybird cannot set it for you.'
                      : option.id === 'actual'
                        ? researchOnly?'':' Dividends appear once Robinhood reports them.'
                        : ' Dividends are not included.'}
                    {option.id === 'actual'
                      ? ''
                      : backtestedOnly
                        ? ' The take has not traded yet, so every day here is simulated on prices. Actual results start with the first investor.'
                        : ' Days since publish follow the published take; earlier days are simulated from prices too, before it existed.'}
                    {annualized !== null ? ' The yearly figure is the compound annual rate over the range.' : ''}
                    {lastRebalanced === null
                      ? ''
                      : ` The last rebalance ran ${lastRebalanced}. One that finds every holding already on target places no trades, so it leaves nothing in the activity feed.`}
                  </TooltipContent>
                    </>:<TooltipContent side="top">{option.id==='actual'?'Returns from your actual investments.':'Simulated returns based on historical prices.'}</TooltipContent>}
                    </Tooltip>
                  ))}
                </div>
              )}
              </div>
            </div>
            {!researchOnly && <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" aria-label="About these figures">
              {(performance?.basis === 'actual'
                ? [
                  `Actual results across ${performance.investors} ${performance.investors === 1 ? 'investor account' : 'investor accounts'}, value-weighted`,
                  range === '1d' ? 'Real holdings at live prices; deposits are taken out' : 'Real fills, marked to daily closes; deposits and closes are taken out',
                  'Dividends appear once Robinhood reports them; reinvestment is a setting on your Agentic account',
                  'Before taxes',
                ]
                : [
                  backtestedOnly ? 'Simulated on prices; the take has not traded' : 'Simulated on prices, not an account',
                  'Growth of $100 at the start of the range',
                  'Dividends assumed reinvested; turn that on in your Robinhood Agentic account to match',
                  'Before fees and taxes',
                  'Past performance is not a guide to future results',
                ]).map((note) => <li key={note}>· {note}</li>)}
            </ul>}
          </section>

          {card.description !== null && card.description !== '' && (
            <section aria-labelledby="idea-heading" className="space-y-5">
              <h2 id="idea-heading" className="font-display border-b border-border pb-4 text-[22px] tracking-[-0.02em]">The Idea</h2>
              <p className="max-w-2xl whitespace-pre-line text-pretty text-sm leading-6 text-foreground/90">{card.description}</p>
            </section>
          )}

          <section aria-labelledby="holdings-heading" className="space-y-5">
            <h2 id="holdings-heading" className="font-display border-b border-border pb-4 text-[22px] tracking-[-0.02em]">Holdings</h2>
            <StrategyHoldingsList strategy={card} roomy pricesAt={hovered} />
          </section>

          {!researchOnly && <section aria-labelledby="stats-heading" className="space-y-5">
            <h2 id="stats-heading" className="font-display border-b border-border pb-4 text-[22px] tracking-[-0.02em]">Key stats</h2>
            <StrategyKeyStats strategy={hovered?.value == null ? card : { ...card, investedValue: String(hovered.value) }} investedAsOf={hovered?.value == null ? undefined : hovered.label} minimumAllocation={minimumAllocation} />
          </section>}
          </SidePanelLayout>

        </>
      )}
    </div>
    </TakeVersionBannerTarget.Provider>
  );
}


function DraftCommitLink({takeId,visible}:{takeId:string;visible:boolean}){
 if(!visible)return null;
 return <div className="space-y-3"><p className="text-xs text-muted-foreground">Review and commit this draft before investing.</p><Link to="/" search={{takeId}} className="inline-flex w-full items-center justify-center rounded-full bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:bg-foreground/90">Review and commit</Link></div>;
}
