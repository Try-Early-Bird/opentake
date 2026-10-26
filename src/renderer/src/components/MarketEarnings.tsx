import { money } from '../portfolio/format';
import { useEffect, useState } from 'react';

type EarningsReport = {
  year: number;
  quarter: number;
  estimate: number | null;
  actual: number | null;
  date: string;
  timing: string;
  verified: boolean;
};

type EarningsState = {
  symbol: string;
  status: 'loading' | 'ready' | 'error';
  reports: EarningsReport[];
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function eps(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function reportsFromResponse(value: unknown, symbol: string): EarningsReport[] {
  const rows = record(record(value).data).results;
  if (!Array.isArray(rows)) throw new Error('Missing earnings results');
  return rows.flatMap((value): EarningsReport[] => {
    const row = record(value);
    const report = record(row.report);
    const values = record(row.eps);
    if (row.symbol !== symbol || typeof row.year !== 'number' || typeof row.quarter !== 'number' ||
      typeof report.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(report.date)) return [];
    return [{
      year: row.year, quarter: row.quarter,
      estimate: eps(values.estimate), actual: eps(values.actual), date: report.date,
      timing: typeof report.timing === 'string' ? report.timing : '', verified: report.verified === true,
    }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function reportDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

export function MarketEarnings({ symbol, currency }: { symbol: string; currency: string }): React.JSX.Element {
  const [state, setState] = useState<EarningsState>({ symbol, status: 'loading', reports: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ symbol, status: 'loading', reports: [] });
    void (async () => {
      try {
        const data = await window.portfolio.research({
          tool: 'get_earnings_results', arguments: { symbol },
        });
        const reports = reportsFromResponse(data, symbol);
        if (!cancelled) setState({ symbol, status: 'ready', reports });
      } catch {
        if (!cancelled) setState({ symbol, status: 'error', reports: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [symbol, attempt]);

  const loading = state.symbol !== symbol || state.status === 'loading';
  const reports = state.symbol === symbol ? state.reports : [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const upcoming = reports.find((report) => report.actual === null && report.date >= today);
  const history = reports.filter((report) => report.actual !== null).slice(-4).reverse();
  const value = (amount: number | null) => amount === null ? '—' : money(amount, currency);

  return (
    <section aria-labelledby="market-earnings" className="space-y-5" aria-busy={loading}>
      <h2 id="market-earnings" className="font-display border-b border-border pb-4 text-[22px] tracking-[-0.02em]">Earnings</h2>
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading earnings…</p> : state.status === 'error' ? (
        <p className="text-sm text-muted-foreground">
          Earnings couldn’t be loaded.{' '}
          <button type="button" className="font-semibold text-brand hover:underline" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </p>
      ) : reports.length === 0 ? <p className="text-sm text-muted-foreground">No earnings data available for {symbol}.</p> : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <dt className="text-sm font-semibold">Next report</dt>
              <dd className="mt-1 text-sm">{upcoming ? reportDate(upcoming.date) : 'Not announced'}</dd>
              {upcoming && <dd className="mt-1 text-xs text-muted-foreground">
                {[
                  upcoming.timing === 'am' ? 'Before market open' : upcoming.timing === 'pm' ? 'After market close' : null,
                  upcoming.verified ? null : 'Estimated date',
                ].filter(Boolean).join(' · ')}
              </dd>}
            </div>
            <div>
              <dt className="text-sm font-semibold">Expected EPS</dt>
              <dd className="mt-1 text-sm tabular-nums">{value(upcoming?.estimate ?? null)}</dd>
            </div>
          </dl>
          {history.length > 0 && <div className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <caption className="sr-only">Recent quarterly earnings per share for {symbol}</caption>
              <thead className="text-muted-foreground"><tr>
                <th scope="col" className="pb-3 font-medium">Fiscal quarter</th>
                <th scope="col" className="pb-3 text-right font-medium">Estimated EPS</th>
                <th scope="col" className="pb-3 text-right font-medium">Actual EPS</th>
              </tr></thead>
              <tbody>{history.map((report) => <tr key={`${report.year}-${report.quarter}`} className="border-t border-border">
                <th scope="row" className="py-3 font-medium">Q{report.quarter} {report.year}</th>
                <td className="py-3 text-right">{value(report.estimate)}</td>
                <td className="py-3 text-right">{value(report.actual)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </>
      )}
    </section>
  );
}
