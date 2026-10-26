import { TakeLoading } from '../components/TakeLoading';
import { followData } from '../strategies/follow-data';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isInvested, OwnedTakeRow, TAKE_COLUMNS, type OwnedTakeRowData } from '../strategies/OwnedTakeRow';
import { money, signedMoney } from '../portfolio/format';
import { ownedTakeRow } from '../strategies/owned-takes';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

export function Takes(): React.JSX.Element {
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [takes, setTakes] = useState<OwnedTakeRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([window.strategies.overview(archived), window.portfolio.snapshot().catch(() => null), followData.getStrategyHoldings().catch(() => null)]).then(([rows, portfolio, investments]) => {
      const details = rows.map(({ row, detail, funding }) => ownedTakeRow(row, detail, portfolio, investments?.status === 200 ? investments.holdings : null, funding));
      if (!cancelled) setTakes(details);
    }).catch(() => {
      if (!cancelled) setError('Could not load your takes. Please try again.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [archived, reload]);

  const visible = takes.filter((take) => `${take.title} ${take.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  // Invested Takes default to newest first; unknown ages stay at the end.
  const invested = visible.filter(isInvested).sort((a, b) => (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0));
  const notInvested = visible.filter((take) => !isInvested(take));
  const holding = takes.filter(isInvested);
  const investedTotal = holding.some(take => take.investedValue === null) ? null : holding.reduce((sum, take) => sum + Number(take.investedValue), 0);
  const pnlTotal = holding.every((take) => take.totalPnl !== null) ? holding.reduce((sum, take) => sum + take.totalPnl!, 0) : null;
  const currency = takes[0]?.currency ?? 'USD';
  const createTake = async (): Promise<void> => {
    setCreating(true);
    setCreateError(null);
    try {
      const takeId = await window.takes.create();
      await navigate({ to: '/', search: { takeId } });
    } catch {
      setCreateError('Could not create a take. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] tracking-[-0.02em]">Takes</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your ideas, ready to invest in.</p>
        </div>
        <button type="button" onClick={() => void createTake()} disabled={creating}
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"><Plus size={14} aria-hidden="true" /> New take</button>
      </header>
      {createError && <p role="alert" className="text-sm text-error">{createError}</p>}
      {!archived && !loading && !error && <dl className="flex gap-10">
        <div><dt className="text-xs text-muted-foreground">Invested</dt><dd className="mt-1 text-2xl tabular-nums">{investedTotal === null ? '—' : money(investedTotal, currency)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Total P&amp;L</dt><dd className={cn('mt-1 text-2xl tabular-nums', pnlTotal === null ? 'text-muted-foreground' : pnlTotal >= 0 ? 'text-success' : 'text-error')}>{pnlTotal === null ? '—' : signedMoney(pnlTotal, currency)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Takes</dt><dd className="mt-1 text-2xl tabular-nums">{takes.length}</dd></div>
      </dl>}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1" aria-label="Take filters">
          {[{ value: false, label: 'Your takes' }, { value: true, label: 'Archived' }].map((filter) => (
            <button key={filter.label} type="button" aria-pressed={archived === filter.value}
              className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition-colors', archived === filter.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => setArchived(filter.value)}>{filter.label}</button>
          ))}
        </div>
        <label className="flex w-full items-center gap-2 rounded-full bg-muted/50 px-3 py-2 text-muted-foreground sm:w-64">
          <Search size={14} aria-hidden="true" />
          <input aria-label="Search takes" placeholder="Search takes" value={query} onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      {loading ? (
        <TakeLoading />
      ) : error ? (
        <div role="alert" className="space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>Try again</Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-border px-6 py-14 text-center">
          <h2 className="font-display text-lg">{query.trim() ? 'No matching takes' : archived ? 'No archived takes' : 'Your next idea starts here'}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{query.trim() ? 'Try another name.' : archived ? 'Takes you archive will appear here.' : 'Start a take in chat. Once it has an allocation, it will appear here.'}</p>
        </div>
      ) : (
        <div role="region" aria-label={archived ? 'Archived takes' : 'Your takes'}>
          {[{ label: 'Invested', rows: invested }, { label: 'Not invested yet', rows: notInvested }].filter((group) => group.rows.length > 0).map((group) => (
            <section key={group.label} aria-label={group.label} className="mt-8 first-of-type:mt-5">
              <h2 className="px-3 pb-2 font-display text-[22px] tracking-[-0.01em]">{group.label} <span className="ml-1 text-muted-foreground">{group.rows.length}</span></h2>
              <div className={cn(TAKE_COLUMNS, 'border-b border-border px-3 pb-2 text-[11px] text-muted-foreground')} aria-hidden="true">
                <span>Take</span><span className="text-right">Value</span><span className="text-right">P&amp;L</span><span className="text-right">Age</span>
              </div>
              <ul>{group.rows.map((take) => <OwnedTakeRow key={take.strategyId} take={take} />)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
