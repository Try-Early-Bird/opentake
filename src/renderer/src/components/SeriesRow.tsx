import { cn } from '../lib/utils';
import { money, signedPercent } from '../portfolio/format';
import { useState, type ReactNode } from 'react';

import type { SeriesChange, SymbolSeries } from '../market-series';
import { Sparkline } from './Sparkline';

// Robinhood-style list row shared by the dashboard holdings and the markets
// screen: a title over a subtitle, a sparkline in the middle, and price over
// one change on the right. Outside regular hours the latest extended-hours
// trade and its move replace the regular-session pair, as Robinhood's sidebar
// does. Without a series (signed out, or before the first fetch) it falls back
// to a catalog price and change so the row still reads; clicking reveals
// optional detail content.

export type Tone = 'positive' | 'negative' | 'flat';

export function changeTone(change: SeriesChange | null | undefined): Tone {
  const amount = Number(change?.amount ?? Number.NaN);
  if (!Number.isFinite(amount) || amount === 0) return 'flat';
  return amount > 0 ? 'positive' : 'negative';
}

export function toneClass(tone: Tone): string {
  return tone === 'positive' ? 'text-success' : tone === 'negative' ? 'text-error' : 'text-muted-foreground';
}

export function formatPercent(percent: string | number): string {
  return signedPercent(percent);
}

export function SeriesRow({
  leading,
  title,
  subtitle,
  subtitleClassName,
  series,
  fallbackPrice,
  displayValue,
  formatPrice = money,
  fallbackChangePercent,
  currency,
  loading,
  detail,
  note,
  onSelect,
  compact = false,
  flush = false,
  itemProps,
}: {
  /** Icon or logo tile rendered in its own column before the title. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  subtitleClassName?: string;
  series: SymbolSeries | undefined;
  /** Catalog price used when no series is available. */
  fallbackPrice?: string | null;
  /** Portfolio holding value; leaves the price series and its percentage change intact. */
  displayValue?:string;
  formatPrice?:(value:string|number,currency:string)=>string;
  /** Catalog percent change (e.g. "+0.96%") used when no series is available. */
  fallbackChangePercent?: string | null;
  currency: string;
  loading: boolean;
  detail?: ReactNode;
  /** Always-visible line under the row (e.g. the strategy holding a symbol). */
  note?: ReactNode;
  /** Navigates instead of toggling the detail when provided. */
  onSelect?: () => void;
  /** Tighter padding and columns for the narrow sidebar. */
  compact?: boolean;
  /** No horizontal padding: rows sit flush with the page edge (holdings lists). */
  flush?: boolean;
  /** Extra props for the row's <li>, e.g. drag-and-drop handlers. */
  itemProps?: React.LiHTMLAttributes<HTMLLIElement>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const Row = onSelect !== undefined || detail !== undefined ? 'button' : 'div';
  const extended = series?.extendedChange ?? null;
  // The move shown: the extended-hours move when trading is outside the
  // regular session, otherwise the regular-session change.
  const shown = extended ?? series?.change ?? null;
  const tone = series === undefined
    ? changeTone(fallbackChangePercent == null ? null : { amount: fallbackChangePercent, percent: fallbackChangePercent })
    : changeTone(shown);
  // Robinhood colors the line by the regular-session move; when only extended
  // trading has happened so far, fall back to that move.
  const regularTone = changeTone(series?.change ?? null);
  const lineTone = regularTone === 'flat' ? changeTone(extended) : regularTone;
  const displayPrice = displayValue ?? (extended !== null ? series?.extendedPrice : null) ??
    series?.price ?? series?.extendedPrice ?? fallbackPrice ?? null;
  const percentText = shown !== null
    ? formatPercent(shown.percent)
    : fallbackChangePercent != null
      ? formatPercent(fallbackChangePercent.replace('%', ''))
      : null;

  return (
    <li {...itemProps} className={cn('border-b border-border transition-colors last:border-0', !compact && 'has-[button:hover]:bg-muted/50', itemProps?.className)}>
      <Row
        type={Row === 'button' ? 'button' : undefined}
        className={cn(
          'group grid w-full items-center text-left',
          // In the sidebar the title and price columns share the slack equally
          // so the sparkline sits centered in the row. The rail has no card
          // around it, so its rows sit flush and hover underlines the title.
          compact
            ? cn('gap-3 py-2', leading === undefined
              ? 'grid-cols-[minmax(0,1fr)_auto_minmax(4.5rem,1fr)]'
              : 'grid-cols-[auto_minmax(0,1fr)_auto_minmax(4.5rem,1fr)]')
            : cn('gap-4 py-3', !flush && 'px-4', leading === undefined
              ? 'grid-cols-[minmax(0,1fr)_auto_minmax(6.5rem,auto)]'
              : 'grid-cols-[auto_minmax(0,1fr)_auto_minmax(6.5rem,auto)]'),
        )}
        onClick={Row === 'button' ? () => (onSelect === undefined ? setExpanded((open) => !open) : onSelect()) : undefined}
        aria-expanded={detail === undefined || onSelect !== undefined ? undefined : expanded}
      >
        {leading !== undefined && <span className="flex items-center">{leading}</span>}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cn('truncate row-title', compact ? 'text-[13px] group-hover:underline' : 'text-sm')}>{title}</span>
          {subtitle !== undefined && (
            <span className={cn('truncate text-[11px] text-muted-foreground', subtitleClassName)}>{subtitle}</span>
          )}
        </span>
        <span role="img" aria-label={series !== undefined && series.points.length > 1 ? 'Price history' : loading ? 'Loading price history' : 'Price history unavailable'} className={cn('flex h-7 items-center justify-center text-muted-foreground', compact ? 'w-12' : 'w-16')}>
          {series !== undefined && series.points.length > 1 ? (
            <Sparkline series={series} positive={lineTone !== 'negative'} />
          ) : (
            <span className={cn('h-px w-10 bg-border', loading && 'animate-pulse')} aria-hidden="true" />
          )}
        </span>
        <span className="flex flex-col items-end gap-0.5 tabular-nums">
          <span className={compact ? 'text-[13px]' : 'text-sm'}>
            {displayPrice === null
              ? (loading ? <span className="inline-block h-4 w-14 animate-pulse rounded bg-muted" /> : '—')
              : formatPrice(displayPrice, currency)}
          </span>
          <span className={cn('text-[11px] font-medium', toneClass(tone))}>
            {percentText ?? (loading ? '' : '—')}
          </span>
        </span>
      </Row>
      {note !== undefined && <div className={cn('@container pb-3', !flush && 'px-4')}>{note}</div>}
      {expanded && onSelect === undefined && detail}
    </li>
  );
}
