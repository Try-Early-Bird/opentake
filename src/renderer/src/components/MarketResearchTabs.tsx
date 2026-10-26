import { Tabs } from '@base-ui/react/tabs';
import { money } from '../portfolio/format';
import type { MarketResearchRequest } from '../../../shared/market-research';
import { useEffect, useState, type ReactNode } from 'react';

const tabs = [
  ['statistics', 'Key statistics'], ['filings', 'Filings'],
  ['analysts', 'Analyst ratings'], ['financials', 'Quarterly financials'],
] as const;
type ResearchKind = 'filings' | 'analysts' | 'financials';
type Row = Record<string, unknown>;
type State = { status: 'idle' | 'loading' | 'ready' | 'error'; data: Row };
const idle: State = { status: 'idle', data: {} };

function object(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || (typeof value !== 'string' && typeof value !== 'number')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function date(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(parsed);
}
async function call(tool: MarketResearchRequest['tool'], arguments_: Row): Promise<Row> {
  const result = await window.portfolio.research({ tool, arguments: arguments_ });
  const data = object(result).data;
  if (!data || typeof data !== 'object') throw new Error('Missing research response');
  return object(data);
}
function Retry({ retry }: { retry: () => void }): React.JSX.Element {
  return <p className="text-sm text-muted-foreground">Data couldn’t be loaded.{' '}
    <button type="button" onClick={retry} className="font-semibold text-brand hover:underline">Try again</button>
  </p>;
}
function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
function Stat({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return <div><dt className="text-sm font-semibold">{label}</dt><dd className="mt-1 text-sm tabular-nums">{children}</dd></div>;
}

function FilingReader({ filingId }: { filingId: string }): React.JSX.Element {
  const [state, setState] = useState<State>(idle);
  const [section, setSection] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: {} });
    void call('get_sec_filing', { filing_id: filingId, ...(section ? { section } : {}) }).then(
      (data) => { if (!cancelled) setState({ status: 'ready', data }); },
      () => { if (!cancelled) setState({ status: 'error', data: {} }); },
    );
    return () => { cancelled = true; };
  }, [filingId, section, attempt]);
  const content = object(state.data.section);
  return <div className="mt-4 space-y-3 rounded-lg border border-border p-4">
    {section && <button type="button" className="text-sm font-semibold text-brand hover:underline" onClick={() => setSection('')}>Back to contents</button>}
    {state.status === 'loading' ? <p role="status" className="text-sm text-muted-foreground">Loading filing…</p> : state.status === 'error' ? <Retry retry={() => setAttempt((value) => value + 1)} /> : section ? (
      <div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap text-sm leading-6">
        {typeof content.content === 'string' ? content.content : 'Section text is not available.'}
      </div>
    ) : <ul className="space-y-2">{rows(object(state.data.table_of_contents).sections).map((item) => (
      typeof item.id === 'string' && <li key={item.id}><button type="button" className="text-left text-sm text-brand hover:underline" onClick={() => setSection(item.id as string)}>{String(item.title ?? item.id)}</button></li>
    ))}</ul>}
  </div>;
}

function Filings({ data }: { data: Row }): React.JSX.Element {
  const filings = rows(data.filings);
  const [selected, setSelected] = useState<string | null>(null);
  return filings.length === 0 ? <Empty>No SEC filings available.</Empty> : <div className="space-y-3">
    <p className="text-xs text-muted-foreground">Recent annual, quarterly, and current reports</p>
    <ul className="divide-y divide-border">{filings.slice(0, 12).map((filing) => {
      const id = typeof filing.filing_id === 'string' ? filing.filing_id : '';
      return <li key={id} className="py-3">
        <button type="button" disabled={!id} aria-expanded={selected === id} className="flex w-full items-start justify-between gap-4 text-left" onClick={() => setSelected(selected === id ? null : id)}>
          <span><span className="text-sm font-semibold text-brand">{String(filing.form_type ?? 'SEC filing')}</span>
            <span className="mt-1 block text-sm text-muted-foreground">{String(filing.description ?? '')}</span></span>
          <span className="shrink-0 text-sm text-muted-foreground">{date(filing.date_filed)}</span>
        </button>
        {selected === id && <FilingReader key={id} filingId={id} />}
      </li>;
    })}</ul>
  </div>;
}

function Analysts({ data, currency }: { data: Row; currency: string }): React.JSX.Element {
  const ratings = object(rows(data.results)[0]?.ratings);
  if (Object.keys(ratings).length === 0) return <Empty>No analyst coverage available.</Empty>;
  const count = (key: string) => numeric(ratings[key])?.toLocaleString('en-US') ?? '—';
  const price = (key: string) => { const amount = numeric(ratings[key]); return amount === null ? '—' : money(amount, currency); };
  return <div className="space-y-5">
    <dl className="grid grid-cols-3 gap-6">
      <Stat label="Buy">{count('num_buy_ratings')}</Stat><Stat label="Hold">{count('num_hold_ratings')}</Stat><Stat label="Sell">{count('num_sell_ratings')}</Stat>
      <Stat label="Average price target">{price('mean_price_target')}</Stat><Stat label="Low price target">{price('low_price_target')}</Stat><Stat label="High price target">{price('high_price_target')}</Stat>
    </dl>
    {typeof ratings.updated_at === 'string' && <p className="text-xs text-muted-foreground">Updated {date(ratings.updated_at)}</p>}
  </div>;
}

function Financials({ data, currency }: { data: Row; currency: string }): React.JSX.Element {
  const financials = rows(rows(data.results)[0]?.financials);
  if (financials.length === 0) return <Empty>No quarterly financials available.</Empty>;
  const amount = (value: unknown) => {
    const number = numeric(value);
    return number === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 2 }).format(number);
  };
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm tabular-nums">
    <caption className="sr-only">Quarterly revenue, gross profit, net income, and net margin</caption>
    <thead><tr className="text-muted-foreground">{['Fiscal quarter', 'Revenue', 'Gross profit', 'Net income', 'Net margin'].map((label, i) => <th scope="col" key={label} className={`pb-3 font-medium ${i ? 'pl-5 text-right' : ''}`}>{label}</th>)}</tr></thead>
    <tbody>{financials.map((period) => <tr key={String(period.period_end_date)} className="border-t border-border">
      <th scope="row" className="py-3 font-medium"><span className="whitespace-nowrap">Q{String(period.fiscal_quarter)} {String(period.fiscal_year)}</span><span className="mt-1 block whitespace-nowrap text-xs font-normal text-muted-foreground">{date(period.period_end_date)}</span></th>
      <td className="py-3 pl-5 text-right">{amount(period.revenue)}</td><td className="py-3 pl-5 text-right">{amount(period.gross_profit)}</td><td className="py-3 pl-5 text-right">{amount(period.net_income)}</td>
      <td className="py-3 pl-5 text-right">{numeric(period.net_margin) === null ? '—' : `${numeric(period.net_margin)!.toFixed(2)}%`}</td>
    </tr>)}</tbody>
  </table></div>;
}

function ResearchPanel({ kind, symbol, currency, active }: { kind: ResearchKind; symbol: string; currency: string; active: boolean }): React.JSX.Element {
  const [state, setState] = useState<State>(idle);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState({ status: 'loading', data: {} });
    const tool = kind === 'filings' ? 'get_sec_filing_index' : kind === 'analysts' ? 'get_equity_analyst_ratings' : 'get_financials';
    const args = kind === 'filings' ? { symbol, form_type: ['10-K', '10-Q', '8-K'] } : kind === 'analysts' ? { symbols: [symbol] } : { symbols: [symbol], period: 'quarterly', limit: 8 };
    void call(tool, args).then(
      (data) => { if (!cancelled) setState({ status: 'ready', data }); },
      () => { if (!cancelled) setState({ status: 'error', data: {} }); },
    );
    return () => { cancelled = true; };
  }, [kind, symbol, active, attempt]);
  if (state.status === 'idle' || state.status === 'loading') return <p role="status" className="text-sm text-muted-foreground">Loading…</p>;
  if (state.status === 'error') return <Retry retry={() => setAttempt((value) => value + 1)} />;
  return kind === 'filings' ? <Filings data={state.data} /> : kind === 'analysts' ? <Analysts data={state.data} currency={currency} /> : <Financials data={state.data} currency={currency} />;
}

export function MarketResearchTabs({ symbol, currency, statistics }: { symbol: string; currency: string; statistics: ReactNode }): React.JSX.Element {
  const [active, setActive] = useState('statistics');
  return <Tabs.Root value={active} onValueChange={(value) => setActive(String(value))} className="space-y-5">
    <Tabs.List aria-label="Company research" className="flex gap-6 overflow-x-auto border-b border-border">
      {tabs.map(([value, label]) => <Tabs.Tab key={value} value={value} className="shrink-0 border-b-2 border-transparent pb-4 font-display text-lg tracking-[-0.02em] text-muted-foreground outline-none data-[active]:border-foreground data-[active]:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{label}</Tabs.Tab>)}
    </Tabs.List>
    <Tabs.Panel value="statistics">{statistics}</Tabs.Panel>
    {(['filings', 'analysts', 'financials'] as const).map((kind) => <Tabs.Panel key={kind} value={kind}>
      <ResearchPanel kind={kind} symbol={symbol} currency={currency} active={active === kind} />
    </Tabs.Panel>)}
  </Tabs.Root>;
}
