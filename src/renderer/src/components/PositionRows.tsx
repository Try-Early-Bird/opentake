import {cryptoLogo} from '../crypto-logos';
import {useNavigate} from '@tanstack/react-router';
import {useMemo} from 'react';
import {HoldingLogo,useLogos} from './HoldingLogo';
import type {AllocationHistory,PortfolioStrategy} from '../../../shared/portfolio';
import {composeStrategySeries,majorAllocations,seriesFromAllocationHistory,sortedStrategyHoldings} from '../portfolio/strategy-series';
import { cn } from '../lib/utils';
import { money, quantity, signedMoney } from '../portfolio/format';
import type { Position } from '../portfolio/types';
import type { SymbolSeries } from '../market-series';
import type { PortfolioRange } from '../portfolio-history';
import { changeTone, SeriesRow, toneClass } from './SeriesRow';
const periodLabels: Record<PortfolioRange,string> = { '1d':'Today','1w':'Past week','1m':'Past month','3m':'Past 3 months','1y':'Past year',all:'All time' };
function PositionDetail({
  holding,
  series,
  range,
  currency,
}: {
  holding: Position;
  series: SymbolSeries | undefined;
  range: PortfolioRange;
  currency: string;
}): React.JSX.Element {
  const pnl = Number(holding.unrealizedPnl ?? Number.NaN);
  const change = series?.change ?? null;
  const tone = changeTone(change);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 pb-4 text-xs sm:grid-cols-4">
      <div>
        <dt className="text-muted-foreground">Position value</dt>
        <dd className="mt-0.5 tabular-nums">
          {holding.positionValue === null ? '—' : money(holding.positionValue, currency)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Average cost</dt>
        <dd className="mt-0.5 tabular-nums">
          {holding.averageEntryPrice === null ? '—' : money(holding.averageEntryPrice, currency)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Unrealized P&amp;L</dt>
        <dd className={cn('mt-0.5 tabular-nums', pnl > 0 ? 'text-success' : pnl < 0 ? 'text-error' : '')}>
          {holding.unrealizedPnl === null ? '—' : signedMoney(pnl, currency)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{periodLabels[range]}</dt>
        <dd className={cn('mt-0.5 tabular-nums', toneClass(tone))}>
          {change === null
            ? '—'
            : `${signedMoney(change.amount, currency)} (${Math.abs(Number(change.percent)).toFixed(2)}%)`}
          {series?.baseline != null && (
            <span className="ml-1 text-muted-foreground">vs {money(series.baseline.price, currency)}</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

// Container-query tiers: narrow rows keep two chips, medium four, wide all.
// A "+N" tail counts whatever the current tier hides.
const CHIP_TIERS = [
  { visible: 2, className: 'hidden @md:inline-flex' },
  { visible: 4, className: 'hidden @xl:inline-flex' },
] as const;

function AllocationChips({ items }: {
  /** `logoUrl` present (even null) renders the market logo, as the owned-strategy rows do; absent means a plain label like "Cash". */
  items: ReadonlyArray<{ label: string; percent: number; logoUrl?: string | null }>;
}): React.JSX.Element {
  const chipClass = (index: number): string =>
    index < CHIP_TIERS[0].visible ? '' : index < CHIP_TIERS[1].visible ? CHIP_TIERS[0].className : CHIP_TIERS[1].className;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
      {items.map((item, index) => (
        <span key={item.label} className={cn('inline-flex items-center gap-1', chipClass(index))}>
          {item.logoUrl !== undefined && <HoldingLogo weight={{ symbol: item.label, logoUrl: item.logoUrl }} size="inline" />}
          <span className="font-medium text-foreground">{item.label}</span> {item.percent}%
        </span>
      ))}
      {items.length > CHIP_TIERS[0].visible && (
        <span className="@md:hidden">+{items.length - CHIP_TIERS[0].visible} more</span>
      )}
      {items.length > CHIP_TIERS[1].visible && (
        <span className="hidden @md:inline @xl:hidden">+{items.length - CHIP_TIERS[1].visible} more</span>
      )}
    </p>
  );
}

// The row opens the strategy's page.
export function StrategyRow({
  holding,
  history,
  seriesBySymbol,
  range,
  currency,
  loading,
  onSelect,
}: {
  holding: PortfolioStrategy;
  history: AllocationHistory | undefined;
  seriesBySymbol: ReadonlyMap<string, SymbolSeries>;
  range: PortfolioRange;
  currency: string;
  loading: boolean;
  onSelect: (() => void) | undefined;
}): React.JSX.Element {
  const breakdown = majorAllocations(holding.spec);
  // Chip logos come from the market logos, like the owned-strategy rows;
  // synthetic entries ("N others", "Cash") stay plain labels.
  const chipSymbols = useMemo(
    () => new Set(holding.spec.target.weights.map((weight) => weight.instrument.symbol)),
    [holding.spec],
  );
  const logos = useLogos(breakdown.filter((item) => chipSymbols.has(item.label)).map((item) => item.label));
  const chips = breakdown.map((item) => chipSymbols.has(item.label)
    ? { ...item, logoUrl: holding.spec.target.weights.some(w=>w.instrument.symbol===item.label&&w.instrument.venue==='coinbase')?cryptoLogo(item.label):logos.get(item.label) ?? null }
    : item);
  // 1D is intraday and composed from the legs' live series; longer ranges use
  // the daily allocation history, which reflects the holdings of each day.
  const series = holding.requiresReconciliation?undefined:range === '1d' || history === undefined
    ? composeStrategySeries(holding, seriesBySymbol)
    : seriesFromAllocationHistory(history, range, holding.title.toUpperCase());
  const status = holding.status;
  return (
    <SeriesRow
      leading={(
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-sm font-semibold text-background" aria-hidden="true">
          {holding.title.slice(0, 1).toUpperCase()}
        </span>
      )}
      title={(
        <span className="inline-flex items-center gap-1.5">
          {holding.title}
          {(status !== 'active'||holding.requiresReconciliation) && (
            <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {status === 'diverged'||holding.requiresReconciliation ? 'Action required' : status}
            </span>
          )}
        </span>
      )}
      subtitle={holding.description || 'Agentic take'}
      note={chips.length > 0
        // Indented past the logo tile so the chips align under the title.
        ? <div className="pl-[3.25rem]"><AllocationChips items={chips} /></div>
        : undefined}
      series={series}
      fallbackPrice={holding.value}
      currency={currency}
      loading={loading}
      onSelect={onSelect}
      flush
    />
  );
}

export function PositionRows({holdings,strategies=[],historyByAllocation,strategySeriesBySymbol,seriesBySymbol,range,currency,loading}: {
 strategies?:readonly PortfolioStrategy[];
 historyByAllocation?: ReadonlyMap<string,AllocationHistory>;
 /** Per-symbol series the strategy rows compose 1D from. */
 strategySeriesBySymbol?: ReadonlyMap<string,SymbolSeries>;
 holdings: readonly (Position & {markPrice: string | null})[]; seriesBySymbol: ReadonlyMap<string,SymbolSeries>;
 range: PortfolioRange; currency: string; loading: boolean;
}): React.JSX.Element {
 const navigate = useNavigate();
 if (holdings.length === 0 && strategies.length===0) return <p className="p-6 text-center text-sm text-muted-foreground">No positions outstanding</p>;
 return (<ul className="m-0 list-none p-0">
      {sortedStrategyHoldings(strategies).map(holding=>(
        <StrategyRow
          key={holding.allocationId}
          holding={holding}
          history={historyByAllocation?.get(holding.allocationId)}
          seriesBySymbol={strategySeriesBySymbol ?? new Map()}
          range={range}
          currency={currency}
          loading={loading}
          onSelect={() => void navigate({ to: '/strategies/$strategyId', params: { strategyId: holding.strategyId } })}
        />
      ))}
      {holdings.map((holding) => {
        const series = seriesBySymbol.get(holding.marketRef);
        const short = holding.side === 'short';
        return (
          <SeriesRow
            key={holding.marketRef}
            title={holding.symbol}
            subtitle={`${short ? 'Short ' : ''}${quantity(holding.size)} shares`}
            subtitleClassName={short ? 'text-error' : undefined}
            series={series}
            currency={currency}
            loading={loading}
            detail={<PositionDetail holding={holding} series={series} range={range} currency={currency} />}
            // Self-hosted keeps the saved mark when price history is unavailable.
            fallbackPrice={holding.markPrice}
            onSelect={(holding.assetClass ?? 'equity') === 'equity'
              ? () => void navigate({ to: '/rh/$symbol', params: { symbol: holding.symbol } })
              : undefined}
            flush
          />
        );
      })}
    </ul>
  );
}
