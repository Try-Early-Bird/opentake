import { money } from '../portfolio/format';
import { useState } from 'react';
import { Skeleton } from './ui/skeleton';

// Robinhood-style "About" and "Key statistics" for an instrument page, built
// from the get_equity_fundamentals snapshot stored on the catalog market. The
// snapshot is the provider's raw record (decimal strings, snake_case), so every
// value is parsed defensively and a missing field renders as an em dash.
// Short inventory and borrow rate are currently absent from Robinhood MCP
// snapshots; leave them unavailable unless the provider supplies those values.

const DESCRIPTION_PREVIEW_CHARS = 220;

function text(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numeric(record: Record<string, unknown>, ...keys: string[]): number | null {
  const raw = text(record, ...keys);
  if (raw === null) return null;
  const value = Number(raw.replaceAll(',', ''));
  return Number.isFinite(value) ? value : null;
}

/** 5.66T, 151.43M, 42,000 — matches Robinhood's compact statistics. */
function compact(value: number | null, fractionDigits = 2): string {
  if (value === null) return '—';
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${(value / size).toFixed(fractionDigits)}${suffix}`;
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function price(value: number | null, currency: string): string {
  return value === null ? '—' : money(value, currency);
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

function shortInventory(record: Record<string, unknown>): string {
  const value = record.short_inventory;
  if (value === true) return 'Available';
  if (value === false) return 'Unavailable';
  const inventory = text(record, 'short_inventory');
  if (inventory?.toLowerCase() === 'available') return 'Available';
  if (inventory?.toLowerCase() === 'unavailable') return 'Unavailable';
  return inventory ?? '—';
}

function ratio(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums text-foreground/90">{value}</dd>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2 className="font-display border-b border-border pb-4 text-[22px] tracking-[-0.02em]">{children}</h2>
  );
}

function Description({ description }: { description: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const needsToggle = description.length > DESCRIPTION_PREVIEW_CHARS;
  const shown = expanded || !needsToggle
    ? description
    : `${description.slice(0, DESCRIPTION_PREVIEW_CHARS).replace(/\s+\S*$/u, '')}…`;
  return (
    <p className="text-sm leading-6 text-foreground/90">
      {shown}
      {needsToggle && (
        <>
          {' '}
          <button
            type="button"
            className="font-semibold text-brand hover:underline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </>
      )}
    </p>
  );
}

export function MarketFundamentals({ fundamentals, loading = false, currency = 'USD', earnings, renderStatistics }: {
  fundamentals: Record<string, unknown> | undefined;
  /** Facts are still on their way: placeholders, not "not available". */
  loading?: boolean;
  currency?: string;
  earnings?: React.ReactNode;
  renderStatistics?: (statistics: React.ReactNode) => React.ReactNode;
}): React.JSX.Element | null {
  const record = fundamentals ?? {};

  const description = text(record, 'description');
  const ceo = text(record, 'ceo');
  const employees = numeric(record, 'num_employees');
  const city = text(record, 'headquarters_city');
  const state = text(record, 'headquarters_state');
  const headquarters = [city, state].filter((part) => part !== null).join(', ');
  const founded = text(record, 'year_founded');
  const hasAbout = description !== null || ceo !== null || employees !== null || headquarters !== '' || founded !== null;

  const stats: Array<{ label: string; value: string }> = [
    { label: 'Market cap', value: compact(numeric(record, 'market_cap', 'marketCap')) },
    { label: 'Price-Earnings ratio', value: ratio(numeric(record, 'pe_ratio')) },
    { label: 'Dividend yield', value: percent(numeric(record, 'dividend_yield')) },
    { label: 'Average volume', value: compact(numeric(record, 'average_volume', 'average_volume_30_days', 'average_volume_2_weeks')) },
    { label: 'High today', value: price(numeric(record, 'high'), currency) },
    { label: 'Low today', value: price(numeric(record, 'low'), currency) },
    { label: 'Open price', value: price(numeric(record, 'open'), currency) },
    { label: 'Volume', value: compact(numeric(record, 'volume')) },
    { label: '52 Week high', value: price(numeric(record, 'high_52_weeks'), currency) },
    { label: '52 Week low', value: price(numeric(record, 'low_52_weeks'), currency) },
    { label: 'Short inventory', value: shortInventory(record) },
    { label: 'Borrow rate', value: percent(numeric(record, 'borrow_rate')) },
    { label: 'Float', value: compact(numeric(record, 'float')) },
    { label: 'Shares outstanding', value: compact(numeric(record, 'shares_outstanding')) },
  ];
  const hasStats = stats.some((stat) => stat.value !== '—');
  if (!loading && !hasAbout && !hasStats && !renderStatistics) return <>{earnings}</>;
  const statistics = loading ? (
    <dl role="status" aria-label="Loading key statistics" className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
      {stats.map((stat) => <Stat key={stat.label} label={stat.label} value={<Skeleton className="mt-1.5 h-3.5 w-16" />} />)}
    </dl>
  ) : hasStats ? (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
      {stats.map((stat) => <Stat key={stat.label} label={stat.label} value={stat.value} />)}
    </dl>
  ) : <p className="text-sm text-muted-foreground">Key statistics are not available.</p>;

  return (
    <>
      {loading ? (
        <section role="status" aria-label="Loading company details" className="space-y-5">
          <SectionHeading>About</SectionHeading>
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
            {['CEO', 'Employees', 'Headquarters', 'Founded'].map((label) => <Stat key={label} label={label} value={<Skeleton className="mt-1.5 h-3.5 w-20" />} />)}
          </dl>
        </section>
      ) : hasAbout && (
        <section aria-labelledby="market-about" className="space-y-5">
          <SectionHeading>
            <span id="market-about">About</span>
          </SectionHeading>
          {description !== null && <Description description={description} />}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
            <Stat label="CEO" value={ceo ?? '—'} />
            <Stat label="Employees" value={compact(employees, 0)} />
            <Stat label="Headquarters" value={headquarters === '' ? '—' : headquarters} />
            <Stat label="Founded" value={founded ?? '—'} />
          </dl>
        </section>
      )}
      {earnings}
      {renderStatistics ? renderStatistics(statistics) : (hasStats || loading) && (
        <section aria-labelledby="market-stats" className="space-y-5">
          <SectionHeading>
            <span id="market-stats">Key statistics</span>
          </SectionHeading>
          {statistics}
        </section>
      )}
    </>
  );
}
