// Trading section
// (TradingSettings, BlockedTickers, SettingRow, Switch). Self-hosted: the
// preferences live in the local database (allocations bridge), market search is
// the local Robinhood search, and logos come from the local logo cache.
// Confirmations are available in the Jobs queue and on the strategy page.
import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';

import { cn } from '../lib/utils';
import { HoldingLogo, useLogos } from '../components/HoldingLogo';

type TradingPreferences = { confirmTrades: boolean; blockedSymbols: string[] };
type Market = { symbol: string; displayName: string };
type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

function SettingRow({ label, description, control }: {
  label: string;
  description?: string;
  control: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description !== undefined && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{description}</p>}
      </div>
      {control}
    </div>
  );
}

function Switch({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'bg-brand' : 'bg-muted-foreground/30',
      )}
    >
      <span className={cn('inline-block size-4 rounded-full bg-background shadow-sm transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

/** Market search over the local Robinhood search, debounced. */
function useMarketSearch(query: string): { markets: Market[]; status: SearchStatus } {
  const [state, setState] = useState<{ markets: Market[]; status: SearchStatus }>({ markets: [], status: 'idle' });
  useEffect(() => {
    const needle = query.trim();
    if (needle === '') { setState({ markets: [], status: 'idle' }); return; }
    let active = true;
    setState((current) => ({ ...current, status: 'loading' }));
    const timer = setTimeout(() => {
      void window.portfolio.search(needle)
        .then((markets) => { if (active) setState({ markets, status: 'ready' }); })
        .catch(() => { if (active) setState({ markets: [], status: 'error' }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  return state;
}

/**
 * Picks markets to block through the app's own market search: type, then
 * Block on a result (or Enter for the first). Blocked markets are chips below.
 */
function BlockedTickers({ blocked, onChange }: {
  blocked: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const { markets, status } = useMarketSearch(query);
  const results = markets.slice(0, 6);
  const logos = useLogos(results.map((hit) => hit.symbol));
  const blockedSet = new Set(blocked);

  useEffect(() => setActiveIndex(0), [markets]);

  const block = (symbol: string): void => {
    const upper = symbol.toUpperCase();
    if (!blockedSet.has(upper)) onChange([...blocked, upper].sort());
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && results[activeIndex] !== undefined) {
      event.preventDefault();
      block(results[activeIndex].symbol);
    } else if (event.key === 'Escape') {
      setQuery('');
    }
  };

  return (
    <div className="py-3">
      <p className="text-sm font-medium">Blocked markets</p>
      <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
        Opentake never buys these for you. A take holding one can’t be invested in or added to; one you already
        follow leaves it alone and keeps what you hold.
      </p>
      <div className="relative mt-3 max-w-xl">
        <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search a stock, ETF, or market to block"
            aria-label="Search a market to block"
            role="combobox"
            aria-expanded={query.trim() !== ''}
            aria-controls="blocked-market-results"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {status === 'loading' && <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />}
        </label>
        {query.trim() !== '' && (
          <div id="blocked-market-results" role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            {results.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {status === 'loading' || status === 'idle' ? 'Searching…' : status === 'error' ? 'Search is unavailable right now.' : 'No matching markets.'}
              </p>
            ) : (
              results.map((hit, index) => {
                const already = blockedSet.has(hit.symbol.toUpperCase());
                return (
                  <button
                    key={hit.symbol}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    disabled={already}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => block(hit.symbol)}
                    className={cn('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm', index === activeIndex && 'bg-muted')}
                  >
                    <HoldingLogo weight={{ symbol: hit.symbol, logoUrl: logos.get(hit.symbol) ?? null }} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{hit.symbol}</span>
                      <span className="truncate text-xs text-muted-foreground">{hit.displayName}</span>
                    </span>
                    <span className={cn('shrink-0 text-xs', already ? 'text-muted-foreground' : 'font-medium text-error')}>{already ? 'Blocked' : 'Block'}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      {blocked.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No blocked markets.</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Blocked markets">
          {blocked.map((symbol) => (
            <li key={symbol} className="flex h-7 items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 text-xs font-medium tabular-nums">
              {symbol}
              <button
                type="button"
                aria-label={`Unblock ${symbol}`}
                title="Unblock"
                onClick={() => onChange(blocked.filter((item) => item !== symbol))}
                className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TradingSettings(): React.JSX.Element {
  const [preferences, setPreferences] = useState<TradingPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Saves go out one at a time; a later edit waits for the one before it.
  const pending = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void window.allocations.tradingPreferences().then((result) => {
      if (cancelled) return;
      if (result.ok) setPreferences(result.preferences);
      else setLoadError(result.message);
    }).catch(() => { if (!cancelled) setLoadError('Trading settings are unavailable right now.'); });
    return () => { cancelled = true; };
  }, []);

  // Shown at once, stored after; a refused save puts back what is stored.
  const save = (change: Partial<TradingPreferences>): void => {
    if (preferences === null) return;
    const previous = preferences;
    setPreferences({ ...preferences, ...change });
    setSaveError(null);
    setSaving(true);
    pending.current = pending.current.then(async () => {
      const result = await window.allocations.setTradingPreferences(change).catch(() => null);
      setSaving(false);
      if (result?.ok) setPreferences(result.preferences);
      else { setPreferences(previous); setSaveError(result?.message ?? 'The background service is unreachable. Try again.'); }
    });
  };

  return (
    <section aria-labelledby="trading-settings" className="space-y-2">
      <h2 id="trading-settings" className="text-lg font-medium">Trading</h2>
      <p className="text-sm text-muted-foreground">What Opentake may trade for you, across every take you follow.</p>
      {preferences === null ? (
        loadError !== null
          ? <p role="alert" className="py-4 text-sm text-error">{loadError}</p>
          : <div className="my-3 h-24 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="divide-y divide-border">
          <SettingRow
            label="Confirm every trade"
            description="Take orders wait in Jobs or on the take's page until you confirm them. Nothing is placed without your say-so."
            control={<Switch label="Confirm every trade" checked={preferences.confirmTrades} onChange={(confirmTrades) => save({ confirmTrades })} />}
          />
          <BlockedTickers blocked={preferences.blockedSymbols} onChange={(blockedSymbols) => save({ blockedSymbols })} />
          {(saveError !== null || saving) && (
            <p className={cn('pb-3 text-xs', saveError !== null ? 'text-error' : 'text-muted-foreground')}>{saveError ?? 'Saving…'}</p>
          )}
        </div>
      )}
    </section>
  );
}
