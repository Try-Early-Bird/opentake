import {marketKey} from '../../../shared/search';
import {useEffect, useState} from 'react';
import {cryptoLogo} from '../crypto-logos';
// : the holdings list
// the strategy page shows (logo, name, 24h change, allocation). HoldingLogo
// lives in components/HoldingLogo; logos resolve through the local cache.
import { Link } from '@tanstack/react-router';

import { cn } from '../lib/utils';
import { money, signedPercent } from '../portfolio/format';
import { HoldingLogo } from '../components/HoldingLogo';
import { RollingNumber } from '../components/RollingNumber';
import type { StrategyCardData, StrategyCardWeight } from './preview-data';

export function formatWeightBps(value: number): string {
  return `${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/** 24h change from the last two prices; null when either is missing. */
export function dayChangePercent(weight: Pick<StrategyCardWeight, 'currentPrice' | 'previousClose'>): number | null {
  const price = Number(weight.currentPrice);
  const previous = Number(weight.previousClose);
  if (!Number.isFinite(price) || !Number.isFinite(previous) || previous === 0) return null;
  return ((price - previous) / previous) * 100;
}

function DayChange({ change }: { change: number | null }): React.JSX.Element {
  if (change === null) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[11px] font-medium tabular-nums',
      change > 0 ? 'text-success' : change < 0 ? 'text-error' : 'text-muted-foreground',
    )}>
      {signedPercent(change)}
    </span>
  );
}

/** Coinbase reports a rolling 24h percentage directly, unlike equity previous-close data. */
function useCoinbaseChanges(productsKey: string): Record<string, number | null> {
  const [changes, setChanges] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setChanges({});
    const products = JSON.parse(productsKey) as string[];
    if (!products.length) return;
    async function refresh(): Promise<void> {
      try {
        const snapshot = await window.portfolio.snapshot();
        const accountId = snapshot.accounts.find(account => account.venue === 'coinbase')?.id;
        const entries = await Promise.all(products.map(async product => {
          try {
            // Any connected Coinbase account can supply market data; this does not select funding.
            const detail = await window.dataSources.coinbaseMarket(product, accountId)
              .catch(error => {
                if (!accountId) throw error;
                return window.dataSources.coinbaseMarket(product);
              });
            const raw = detail.market.change24h;
            const value = raw == null || raw.trim() === '' ? NaN : Number(raw);
            return [product, detail.stale || !Number.isFinite(value) ? null : value] as const;
          } catch {
            return [product, null] as const;
          }
        }));
        if (!cancelled) setChanges(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setChanges({});
      } finally {
        if (!cancelled) timer = setTimeout(() => { void refresh(); }, 60_000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [productsKey]);
  return changes;
}

function coinbaseProduct(symbol: string): string {
  return symbol.includes('-') ? symbol : `${symbol}-USD`;
}

/** Holdings as rows: logo, name, 24h change (or a hovered chart point's price), allocation. */
export function StrategyHoldingsList({ strategy, maxRows, small = false, roomy = false, className, onWeightChange, pricesAt }: {
  strategy: StrategyCardData;
  /** Rows shown before "+N more"; omit to show all. */
  maxRows?: number;
  small?: boolean;
  /** Under a page-level "Holdings" heading: taller rows, no repeated label, no inner scroll. */
  roomy?: boolean;
  className?: string;
  /** When set, the allocation cell is an input (whole percents) instead of text. */
  onWeightChange?: (symbol: string, weightPercent: string) => void;
  /** While a chart point is hovered: the 24h column shows each holding's price then, under this label. */
  pricesAt?: { label: string; prices: Record<string, number> } | null;
}): React.JSX.Element {
  const positive = strategy.targets.weights.filter((weight) => weight.weightBps > 0);
  const visible = maxRows === undefined ? positive : positive.slice(0, maxRows);
  const hidden = positive.length - visible.length;
  const coinbaseChanges = useCoinbaseChanges(JSON.stringify([...new Set(visible.filter(weight => weight.venue === 'coinbase').map(weight => coinbaseProduct(weight.symbol)))].sort()));
  // Read-only lists show the model's current weights (what new money buys;
  // they drift with the market) with the author's target as the secondary
  // figure. Until the model has been valued, and in the editor, the target
  // is the only figure.
  const showCurrent = onWeightChange === undefined && strategy.targets.currentAsOf != null;
  const cash = showCurrent ? (strategy.targets.currentCashBps ?? strategy.targets.cashReserveBps) : strategy.targets.cashReserveBps;
  // One column template for header and rows so the 24h and allocation cells line up;
  // the allocation column widens when it holds an input plus the percent sign.
  // A list that can show hovered prices keeps the wider middle column throughout, so hovering never shifts it.
  const columns = onWeightChange !== undefined ? 'grid-cols-[minmax(0,1fr)_4.25rem_4.75rem]' : pricesAt !== undefined ? 'grid-cols-[minmax(0,1fr)_5.5rem_3.5rem]' : 'grid-cols-[minmax(0,1fr)_4.25rem_3.5rem]';
  return (
    <div className={className}>
      <div className={cn('grid gap-2 text-muted-foreground', columns, roomy ? 'px-3' : 'px-2', small ? 'text-[10px]' : 'text-[11px]')}>
        <span>{roomy ? 'Name' : 'Holdings'}</span>
        <span className="text-right">{pricesAt ? <RollingNumber value={pricesAt.label} /> : '24h'}</span>
        <span className="text-right">{showCurrent ? 'Weight' : 'Allocation'}</span>
      </div>
      <ul className={cn('mt-1 divide-y divide-border', maxRows === undefined && !roomy && 'max-h-72 overflow-y-auto pr-0.5')}>
        {visible.map((weight) => {
          const venue = weight.venue ?? 'robinhood';
          const identity = (
            <>
              <HoldingLogo weight={{ symbol: weight.symbol, logoUrl: venue === 'coinbase' ? cryptoLogo(weight.symbol.split('-')[0]) : weight.logoUrl ?? null }} size={small ? 'small' : 'regular'} />
              <span className="min-w-0">
                <span className={cn('block truncate row-title', small ? 'text-xs' : 'text-sm')}>
                  {weight.displayName ?? weight.symbol}
                  {weight.delistedOn != null && (
                    <span className="ml-1.5 rounded-sm bg-muted px-1 py-px align-middle text-[10px] font-medium text-muted-foreground" title={`No longer trades since ${weight.delistedOn}; held at its last price until the author republishes`}>Delisted</span>
                  )}
                </span>
                {(weight.market||positive.some(item => item.venue && item.venue !== 'robinhood')) && <span className="block text-[11px] capitalize text-muted-foreground">{venue}{weight.market?' · Crypto':''}</span>}
                {weight.displayName && <span className={cn('block truncate text-muted-foreground', small ? 'text-[10px]' : 'text-[11px]')}>{weight.symbol}</span>}
              </span>
            </>
          );
          // A read-only row is one link to the instrument page; an editable row
          // links only its name so the weight input keeps the rest of the row.
          const rowClass = cn('grid items-center gap-2', columns, roomy ? 'px-3 py-3' : 'px-2', !roomy && (small ? 'py-1.5' : 'py-2'));
          const hoveredPrice = pricesAt?.prices[weight.symbol.toUpperCase()];
          const change = pricesAt
            ? <span className={cn('text-right tabular-nums', small ? 'text-[11px]' : 'text-xs', hoveredPrice === undefined && 'text-muted-foreground')}><RollingNumber value={hoveredPrice === undefined ? '—' : money(hoveredPrice)} /></span>
            : <span className="text-right"><DayChange change={venue === 'coinbase' ? coinbaseChanges[coinbaseProduct(weight.symbol)] ?? null : dayChangePercent(weight)} /></span>;
          if (weight.market) return <li key={marketKey({identity:weight.market})} className={rowClass}>
            <Link to="/markets/$market" params={{market:JSON.stringify({identity:weight.market,symbol:weight.symbol,name:weight.displayName??weight.symbol,venueLabel:'Robinhood',typeLabel:'Crypto'})}} className="flex min-w-0 items-center gap-2 hover:underline">{identity}</Link>
            {pricesAt ? change : <span className="text-right text-muted-foreground">—</span>}<span className="text-right text-sm font-semibold tabular-nums">{formatWeightBps(weight.weightBps)}</span>
          </li>;
          if (venue !== 'robinhood') return <li key={`${venue}:${weight.symbol}`} className={rowClass}>
            <span className="flex min-w-0 items-center gap-2">{venue === "coinbase" ? <Link to="/coinbase/$product" params={{product:weight.symbol.includes("-")?weight.symbol:`${weight.symbol}-USD`}} className="flex min-w-0 items-center gap-2 hover:underline" aria-label={`${weight.symbol} instrument page`}>{identity}</Link> : identity}</span>{change}
            <span className="text-right text-sm font-semibold tabular-nums">{formatWeightBps(weight.weightBps)}</span>
          </li>;
          if (onWeightChange === undefined) {
            return (
              <li key={`${venue}:${weight.symbol}`}>
                <Link
                  to="/rh/$symbol"
                  params={{ symbol: weight.symbol }}
                  className={cn(rowClass, 'rounded-md transition-colors hover:bg-muted/60')}
                  aria-label={`${weight.displayName ?? weight.symbol} instrument page`}
                >
                  <span className="flex min-w-0 items-center gap-2">{identity}</span>
                  {change}
                  <span className="text-right">
                    <span className={cn('block font-semibold tabular-nums', small ? 'text-xs' : 'text-sm')}>{formatWeightBps(showCurrent ? (weight.currentWeightBps ?? weight.weightBps) : weight.weightBps)}</span>
                    {showCurrent && weight.currentWeightBps != null && weight.currentWeightBps !== weight.weightBps && (
                      <span className={cn('block tabular-nums text-muted-foreground', small ? 'text-[10px]' : 'text-[11px]')} title="The author's published target">{formatWeightBps(weight.weightBps)} target</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          }
          return (
          <li
            key={`${venue}:${weight.symbol}`}
            className={rowClass}
          >
            <Link to="/rh/$symbol" params={{ symbol: weight.symbol }} className="flex min-w-0 items-center gap-2 hover:underline">
              {identity}
            </Link>
            {change}
            {(
              <span className="flex items-center justify-end gap-1">
                <input
                  value={(weight.weightBps / 100).toFixed(2).replace(/\.?0+$/u, '')}
                  onChange={(event) => onWeightChange(weight.symbol, event.target.value.replace(/[^0-9.]/gu, '').replace(/(\..*)\./gu, '$1').slice(0, 6))}
                  inputMode="decimal"
                  aria-label={`${weight.symbol} weight percent`}
                  className="h-7 w-14 rounded-md border border-border bg-background px-1.5 text-right text-sm font-semibold tabular-nums outline-none focus:border-foreground/40"
                />
                <span className="w-2.5 text-[11px] text-muted-foreground">%</span>
              </span>
            )}
          </li>
          );
        })}
        {cash > 0 && (hidden === 0 || maxRows === undefined) && (
          <li className={cn('grid items-center gap-2', columns, roomy ? 'px-3 py-3' : 'px-2', !roomy && (small ? 'py-1.5' : 'py-2'))}>
            <span className={cn('flex items-center gap-2 font-medium', small ? 'text-xs' : 'text-sm')}>
              <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground ring-1 ring-border', small ? 'size-6 text-[9px]' : 'size-8 text-[11px]')} aria-hidden="true">$</span>
              Cash
            </span>
            <span />
            <span className={cn('text-right font-semibold tabular-nums text-muted-foreground', small ? 'text-xs' : 'text-sm')}>{formatWeightBps(cash)}</span>
          </li>
        )}
      </ul>
      {hidden > 0 && (
        <p className={cn('mt-1 px-1 text-muted-foreground', small ? 'text-[10px]' : 'text-[11px]')}>
          +{hidden} more{cash > 0 ? ` · ${formatWeightBps(cash)} cash` : ''}
        </p>
      )}
      {showCurrent && roomy && (
        <p className="mt-3 px-3 text-[11px] leading-5 text-muted-foreground">
          Weights are the take&apos;s model portfolio as of the {formatValuedOn(strategy.targets.currentAsOf!)} {describePriceSource(strategy.targets.currentPricedFrom)}, which is what a new investment buys. They drift with the market; the target is what the author published.
        </p>
      )}
    </div>
  );
}

/**
 * What the model was marked to. Robinhood settles the session's close itself
 * and treats the newest daily bar as provisional, so a settled mark is named
 * plainly and anything else says it is provisional.
 */
function describePriceSource(pricedFrom: StrategyCardData['targets']['currentPricedFrom']): string {
  if (pricedFrom === 'settled_close') return "close, Robinhood's settled prices";
  if (pricedFrom === 'day_bar') return 'close, from provisional daily prices';
  if (pricedFrom === 'mixed') return "close, Robinhood's settled prices where available";
  return 'close';
}

/** "Sep 15" for an Eastern trading date, without a timezone shift. */
function formatValuedOn(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
