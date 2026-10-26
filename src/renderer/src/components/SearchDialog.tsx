import { rankMarkets, marketPage } from '../../../shared/search';
import type { SavedSearchSummary } from '../../../shared/saved-search';
import { useSearchAgent } from '../search-agent-state';
import { providerLabels } from './chat/AiPicker';
import type { SearchSettings } from '../../../shared/search-settings';
import { SearchAiPicker } from './SearchAiPicker';
import { useNavigate } from '@tanstack/react-router';
import { Check, LoaderCircle, Search, SlidersHorizontal, Sparkles, Square, Bookmark, Play, Trash2, X } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchSnapshot, SearchSource } from '../../../shared/search';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { useLogos } from './HoldingLogo';
import { cn } from '../lib/utils';
import { money, signedPercent } from '../portfolio/format';
import { displayBinding } from '../shortcuts/registry';
import { useShortcuts } from '../shortcuts/Shortcuts';
import { moveSearchSelection, prepareSearchNavigation, readSearchRecents, searchRowKey, setSearchOpen, useSearchOpen, writeSearchRecents, type SearchRow } from '../search-state';

export function SearchButton() {
  const { bindings } = useShortcuts();
  return <button id="nav-search-button" type="button" aria-label="Search markets and takes" title={`Search (${displayBinding(bindings.search)})`} onClick={() => setSearchOpen(true)}
    className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><Search size={18} aria-hidden="true" /></button>;
}

// The search palette; local search owns the data and navigation.
function Avatar({ src, fallback, round = false }: { src: string | null; fallback: string; round?: boolean }): React.JSX.Element {
  const shape = round ? 'rounded-full' : 'rounded-md';
  // Fall back to the initial when the image is missing or fails to load.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className={cn('size-7 shrink-0 object-cover', shape)} />;
  }
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center bg-muted text-[11px] font-medium uppercase text-muted-foreground', shape)}>
      {fallback.slice(0, 1)}
    </span>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div role="group" aria-label={title} className="py-1">
      <p role="presentation" className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function SearchPanel() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<SavedSearchSummary[]>([]);
  const [savedError, setSavedError] = useState('');
  const [saving, setSaving] = useState(false), [saveTitle, setSaveTitle] = useState<string | null>(null);
  const [saveVenues, setSaveVenues] = useState<string[]>([]);
  const [savedRun, setSavedRun] = useState<string | null>(null);
  const [pendingReplay, setPendingReplay] = useState<SavedSearchSummary | null>(null);
  useEffect(() => {
    let live = true;
    void window.searchAgent.saved().then(value => { if (live) setSaved(value); }).catch(() => { if (live) setSavedError('Saved screens could not be loaded.'); });
    return () => { live = false; };
  }, []);
  const [preferences, setPreferences] = useState<SearchSettings | null>(null);
  useEffect(() => { let live = true; void window.settings.search().then(value => { if (live) setPreferences(value); }).catch(() => {}); return () => { live = false; }; }, []);
  const [sources, setSources] = useState<SearchSource[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [sourceError, setSourceError] = useState(false);
  const [archived, setArchived] = useState(false);
  const [snapshot, setSnapshot] = useState<SearchSnapshot | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [recents, setRecents] = useState(readSearchRecents);
  const [navigating, setNavigating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  const scopeKey = JSON.stringify([checked, archived]);
  const agent = useSearchAgent(trimmed, checked);
  useEffect(() => {
    if (!pendingReplay) return;
    setPendingReplay(null);
    void agent.start(pendingReplay.id);
  }, [pendingReplay, trimmed, scopeKey]);
  useEffect(() => { setSaveTitle(null); setSavedRun(null); }, [trimmed, scopeKey]);
  async function saveScreen() {
    if (!agent.snapshot?.canSave || !saveTitle?.trim() || !saveVenues.length || saving) return;
    const id = agent.snapshot.id;
    setSaving(true); setSavedError('');
    try {
      await window.searchAgent.save(id, saveTitle.trim(), saveVenues);
      setSaved(await window.searchAgent.saved()); setSavedRun(id); setSaveTitle(null);
    } catch { setSavedError('Could not save this screen. Finish a successful screen and try again.'); }
    finally { setSaving(false); }
  }
  async function removeScreen(id: string) {
    setSavedError('');
    try { await window.searchAgent.removeSaved(id); setSaved(previous => previous.filter(screen => screen.id !== id)); }
    catch { setSavedError('Could not remove the saved screen.'); }
  }
  function replayScreen(screen: SavedSearchSummary) {
    if (agent.busy || !sources) return;
    setQuery(screen.question); setChecked(screen.venues); setActive(null); setError(''); setSavedError('');
    setPendingReplay(screen);
  }
  const canAsk = !!preferences?.selection && trimmed.length >= 3 && checked.length > 0 && !agent.busy;
  const [resultScope, setResultScope] = useState('');
  useEffect(() => {
    let live = true;
    void window.dataSources.marketSearch.sources().then(value => {
      if (!live) return;
      setSources(value); setChecked(value.filter(s => s.connected && s.capabilities.lookup).map(s => s.id));
    }).catch(() => { if (live) { setSourceError(true); setSources([]); } });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!trimmed || trimmed.length > 64) return;
    let live = true;
    const id = crypto.randomUUID();
    let poll: ReturnType<typeof setTimeout> | undefined;
    const accept = (value: SearchSnapshot | null) => {
      if (!live) return;
      if (!value) { setError('Search expired. Try again.'); return; }
      setSnapshot(value); setResultScope(scopeKey);
      if (!value.done) poll = setTimeout(() => { void window.dataSources.marketSearch.snapshot(id).then(accept).catch(failed); }, 150);
    };
    const failed = () => { if (live) setError('Search is unavailable. Try again.'); };
    const timer = setTimeout(() => {
      setError('');
      void window.dataSources.marketSearch.start({ id, query: trimmed, sources: checked, archived }).then(value => {
        if (!live) { void window.dataSources.marketSearch.cancel(id).catch(() => {}); return; }
        accept(value);
      }).catch(failed);
    }, 250);
    return () => {
      live = false; clearTimeout(timer); clearTimeout(poll);
      // Also cancel after start settles: cleanup may race its IPC dispatch.
      void window.dataSources.marketSearch.cancel(id).catch(() => {});
    };
  }, [trimmed, scopeKey, sources, retry]);
  const current = snapshot?.query === trimmed && resultScope === scopeKey ? snapshot : null;
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => { setPageIndex(0); list.current?.scrollTo(0, 0); }, [trimmed, scopeKey, retry, agent.snapshot?.screening]);
  const allRows = useMemo<SearchRow[]>(() => {
    if (!trimmed) return recents;
    const found: SearchRow[] = [
      ...(agent.snapshot?.markets ?? []).map(hit => ({ kind: 'market' as const, hit })),
      ...(agent.snapshot?.screening ? [] : current?.sources ?? []).flatMap(source => source.markets.map(hit => ({ kind: 'market' as const, hit }))),
      ...(current?.takes ?? []).map(hit => ({ kind: 'take' as const, hit })),
    ];
    return [...new Map(found.map(row => [searchRowKey(row), row])).values()];
  }, [trimmed, recents, current, agent.snapshot]);
  const mergedMarkets = useMemo(() => {
    const markets = allRows.flatMap(row => row.kind === 'market' ? [row.hit] : []);
    return agent.snapshot?.screening ? markets : rankMarkets(markets, trimmed);
  }, [allRows, trimmed, agent.snapshot?.screening]);
  const page = marketPage(mergedMarkets, pageIndex);
  const rows: SearchRow[] = !trimmed ? allRows : [
    ...page.markets.map(hit => ({ kind: 'market' as const, hit })),
    ...allRows.filter(row => row.kind === 'take'),
  ];
  // The existing logo source covers Robinhood equities only. A matching ticker
  // from another venue must not inherit its logo through the symbol cache.
  const logoSymbols = useMemo(() => rows.flatMap(row => row.kind === 'market' && row.hit.identity.venue === 'robinhood'
    && row.hit.identity.instance === 'production' && ['equity', 'stock', 'etf'].includes(row.hit.identity.kind) && /^[A-Z][A-Z0-9.-]{0,11}$/.test(row.hit.symbol) ? [row.hit.symbol] : []), [rows]);
  const logos = useLogos(logoSymbols);
  // Selection follows identity as asynchronous sources arrive, never the row index.
  const activeIndex = rows.findIndex(row => searchRowKey(row) === active);
  useEffect(() => { if (active !== null && activeIndex < 0) setActive(null); }, [active, activeIndex]);
  useEffect(() => {
    const container=list.current,row=container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if(!container||!row)return;
    // Scroll only the results, never the document behind this modal.
    const bounds=container.getBoundingClientRect(),item=row.getBoundingClientRect();
    if(item.top<bounds.top)container.scrollTop+=item.top-bounds.top;
    else if(item.bottom>bounds.bottom)container.scrollTop+=item.bottom-bounds.bottom;
  }, [active, rows]);
  const busy = !!trimmed && trimmed.length <= 64 && !agent.snapshot?.screening && !error && (!current || !current.done);
  async function configureSearch() {
    try { await prepareSearchNavigation(); await navigate({ to: '/settings', search: { section: 'search' } }); setSearchOpen(false); }
    catch { setError('Save your current draft before opening Settings.'); }
  }
  async function manageConnections() {
    try { await prepareSearchNavigation(); await navigate({ to: '/settings', search: { section: 'connections' } }); setSearchOpen(false); }
    catch { setError('Save your current draft before opening Settings.'); }
  }
  async function choose(row: SearchRow) {
    if (navigating) return;
    setNavigating(true); setError('');
    try {
      await prepareSearchNavigation();
      if (row.kind === 'market') await navigate({ to: '/markets/$market', params: { market: JSON.stringify(row.hit) } });
      else if (row.hit.strategyId) await navigate({ to: '/strategies/$strategyId', params: { strategyId: row.hit.strategyId } });
      else await navigate({ to: '/', search: { takeId: row.hit.id } });
      writeSearchRecents([row, ...recents.filter(r => searchRowKey(r) !== searchRowKey(row))]);
      setSearchOpen(false);
    } catch { setError('Could not open this result. Your draft has been kept; try again.'); }
    finally { setNavigating(false); }
  }
  function renderRow(row: SearchRow) {
    const key = searchRowKey(row); const index = rows.indexOf(row);
    if (row.kind === 'market') {
      const hit = row.hit; const quote = hit.quote;
      const change = quote?.previousClose ? (Number(quote.price) / Number(quote.previousClose) - 1) * 100 : null;
      const subtitle = [hit.name, hit.identity.pair, hit.identity.contract].filter(Boolean).join(' · ');
      const logo = hit.identity.venue === 'robinhood' && hit.identity.instance === 'production' && ['equity', 'stock', 'etf'].includes(hit.identity.kind) ? logos.get(hit.symbol) ?? null : null;
      return <button type="button" tabIndex={-1} key={key} id={`search-option-${index}`} role="option" aria-selected={active === key}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(key)} onClick={() => void choose(row)}
        className={`grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_4.5rem_6rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm sm:grid-cols-[minmax(0,1fr)_5.5rem_7rem] ${active === key ? 'bg-muted text-foreground' : 'text-foreground/90'}`}>
        <div data-search-column="instrument" className="flex min-w-0 items-center gap-3">
          <Avatar src={logo} fallback={hit.symbol} />
          <div className="min-w-0"><div className="truncate font-medium">{hit.symbol}</div><div title={subtitle} className="truncate text-xs text-muted-foreground">{subtitle}</div></div>
        </div>
        <div data-search-column="venue" className="min-w-0 text-xs text-muted-foreground"><div title={hit.typeLabel} className="truncate">{hit.typeLabel}</div><div title={hit.venueLabel} className="truncate">{hit.venueLabel}</div></div>
        <div data-search-column="quote" className="min-w-0 text-right tabular-nums" title={quote ? `Quote${quote.asOf ? ` as of ${new Date(quote.asOf).toLocaleString()}` : ''} · fetched ${new Date(quote.fetchedAt).toLocaleString()}` : 'Price unavailable'}>
          {quote ? <><div className="truncate text-sm">{money(quote.price, quote.currency)}</div>
            {change !== null && Number.isFinite(change) && <div className={`truncate text-xs font-medium ${change > 0 ? 'text-success' : change < 0 ? 'text-error' : 'text-muted-foreground'}`}>{signedPercent(change)}</div>}
          </> : <span className="text-muted-foreground" aria-label="Price unavailable">—</span>}
        </div>
      </button>;
    }
    return <button type="button" tabIndex={-1} key={key} id={`search-option-${index}`} role="option" aria-selected={active === key}
      onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(key)} onClick={() => void choose(row)}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm ${active === key ? 'bg-muted text-foreground' : 'text-foreground/90'}`}>
      <Avatar src={null} fallback={row.hit.title} />
      <div className="min-w-0 flex-1"><div className="truncate font-medium">{row.hit.title}</div>
        <div className="truncate text-xs text-muted-foreground">{[row.hit.strategyTitle, row.hit.archived ? 'Archived' : null].filter(Boolean).join(' · ') || 'Take'}</div></div>
      <span className="shrink-0 text-right text-xs text-muted-foreground">{row.hit.strategyId ? 'Strategy' : 'Take'}</span>
    </button>;
  }
  return <div className="flex min-h-0 min-w-0 flex-col">
    <DialogTitle className="sr-only">Search</DialogTitle>
    <DialogDescription className="sr-only">Find markets across connected venues and your local takes.</DialogDescription>
    <div className="flex items-center gap-2 border-b border-border px-3">
      {(busy || navigating) ? <LoaderCircle size={16} className="shrink-0 animate-spin text-muted-foreground" aria-label="Searching" /> : <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
      <input ref={input} autoFocus role="combobox" aria-label="Search markets and takes" aria-autocomplete="list" aria-expanded="true"
        aria-controls="global-search-results" aria-activedescendant={activeIndex >= 0 ? `search-option-${activeIndex}` : undefined}
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        maxLength={2000} value={query} placeholder="Search markets or takes" className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onChange={event => { setQuery(event.target.value); setActive(null); setError(''); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(moveSearchSelection(rows, active, event.key === 'ArrowDown' ? 1 : -1)); }
          if (event.key === 'Enter') { event.preventDefault(); if ((event.metaKey || event.ctrlKey) && canAsk) { void agent.start(); return; } if (activeIndex >= 0) void choose(rows[activeIndex]); }
        }} />
      {agent.busy ? <button type="button" aria-label="Stop agent search" onClick={() => void agent.stop()} className="rounded-md p-1.5 hover:bg-muted"><Square size={14} /></button>
        : <button type="button" disabled={!canAsk} onClick={() => void agent.start()} title={preferences?.selection ? `Ask ${providerLabels[preferences.selection.provider]} · ${preferences.selection.model} on ${checked.join(', ')} (⌘/Ctrl+Enter)` : 'Choose search AI using the gear menu'}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-40"><Sparkles size={12} />Ask Agent</button>}
    </div>
    {(agent.snapshot || agent.starting || agent.error) && <div className="max-h-48 overflow-y-auto border-b border-border px-3 py-2 text-xs">
      <p className="text-muted-foreground">{agent.snapshot?.replay ? `Saved screen · ${agent.snapshot.replay.title} · no AI call` : <>AI market search · {agent.snapshot ? `${providerLabels[agent.snapshot.selection.provider]} · ${agent.snapshot.selection.model} · ${agent.snapshot.sources.join(', ')}` : 'Starting…'}</>}</p>
      <p className="mt-1 text-muted-foreground">Ask Agent can look up markets or screen Robinhood using your search permissions.</p>
      {agent.snapshot?.screening && <p className="mt-1 text-muted-foreground">Robinhood screen: {agent.snapshot.screening.returned} of {agent.snapshot.screening.total} matches · {agent.snapshot.screening.sortedBy}{agent.snapshot.screening.truncated ? ' · result limit reached' : ''}{agent.snapshot.screening.omitted ? ` · ${agent.snapshot.screening.omitted} rows unavailable` : ''}</p>}
      {agent.snapshot?.canSave && savedRun !== agent.snapshot.id && (saveTitle === null
        ? <button type="button" onClick={() => { setSaveTitle(trimmed.slice(0, 120)); setSaveVenues(agent.snapshot!.sources); }} className="mt-2 inline-flex items-center gap-1 underline"><Bookmark size={12} />Save screen</button>
        : <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void saveScreen(); }}>
          <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 text-muted-foreground">Save results from</legend>
            {agent.snapshot.sources.map(venue => <label key={venue} className="flex items-center gap-1.5"><input type="checkbox" aria-label={`Save venue ${venue}`} checked={saveVenues.includes(venue)} disabled={saving}
              onChange={event => setSaveVenues(event.target.checked ? [...saveVenues, venue] : saveVenues.filter(v => v !== venue))} />{sources?.find(source => source.id === venue)?.label ?? venue}</label>)}
          </fieldset>
          <div className="flex items-center gap-2"><input aria-label="Saved screen name" maxLength={120} value={saveTitle} onChange={event => setSaveTitle(event.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1" />
          <button type="submit" disabled={saving || !saveTitle.trim() || !saveVenues.length} className="underline disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => setSaveTitle(null)} className="underline">Cancel</button></div>
        </form>)}
      {savedRun === agent.snapshot?.id && <p role="status" className="mt-2">Screen saved with its current venue and account.</p>}
      {agent.snapshot?.text && <p className="mt-2 whitespace-pre-wrap">{agent.snapshot.text}</p>}
      {agent.busy && <p role="status" className="mt-2">Agent search in progress…</p>}
      {agent.snapshot?.approvals.map(approval => <div key={approval.id} className="mt-2 rounded-md border border-border p-2">
        <p className="font-medium">{approval.title}</p><p className="mt-1">{approval.detail}</p>
        <div className="mt-2 flex gap-3"><button type="button" onClick={() => void agent.decide(approval.id, true)} className="underline">Allow once</button><button type="button" onClick={() => void agent.decide(approval.id, false)} className="underline">Decline</button></div>
      </div>)}
      {(agent.error || agent.snapshot?.error) && <p role="alert" className="mt-2 text-error">{agent.error || agent.snapshot?.error}</p>}
      {agent.snapshot?.state === 'cancelled' && <p className="mt-2">Agent search stopped.</p>}
    </div>}
    {savedError && <p role="alert" className="px-3 py-2 text-xs text-error">{savedError}</p>}
    {sourceError && <p className="px-3 py-2 text-xs text-muted-foreground">Venue status unavailable. Local Take search is still available.</p>}
    {sources !== null && !checked.length && <p className="px-3 py-2 text-xs text-muted-foreground">Searching local takes only. <button type="button" onClick={() => void manageConnections()} className="underline">Manage connections</button></p>}
    {!trimmed && saved.length > 0 && <section aria-label="Saved screens" className="max-h-48 overflow-y-auto border-b border-border px-3 py-2 text-xs">
      <p className="mb-2 font-semibold text-muted-foreground">Saved screens</p>
      {saved.map(screen => <div key={screen.id} className="flex items-center gap-2 rounded-md py-1.5">
        <button type="button" disabled={agent.busy || !sources} onClick={() => replayScreen(screen)} title={screen.conditions.join('\n')}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40" aria-label={`Run saved screen ${screen.title}`}>
          <Play size={12} className="shrink-0" /><span className="min-w-0"><span className="block truncate font-medium">{screen.title}</span><span className="text-muted-foreground">{screen.venues.join(', ')} · saved venue scope</span></span>
        </button>
        <button type="button" aria-label={`Remove saved screen ${screen.title}`} title="Remove this local saved screen" onClick={() => void removeScreen(screen.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><Trash2 size={13} /></button>
      </div>)}
    </section>}
    <div ref={list} id="global-search-results" role="listbox" aria-label="Search results" aria-busy={busy} className="min-h-0 max-h-80 overflow-y-auto p-1.5">
      {!trimmed && <div className="px-2 pb-3 pt-4 text-left text-xs text-muted-foreground"><p>Try a ticker like <span className="font-medium text-foreground">AAPL</span>, a take title, or a strategy description.</p></div>}
      {!trimmed ? rows.length ? <Group title="Recent searches">{rows.map(renderRow)}</Group> : null : <>
        {rows.some(row => row.kind === 'market') && <Group title="Markets">{rows.filter(row => row.kind === 'market').map(renderRow)}</Group>}
        {rows.some(row => row.kind === 'take') && <Group title="Takes">{rows.filter(row => row.kind === 'take').map(renderRow)}</Group>}
      </>}
    {trimmed && page.pages > 1 && <nav aria-label="Market result pages" className="flex items-center justify-between px-2 py-3 text-xs">
      <button type="button" disabled={page.page === 0} onClick={() => { setPageIndex(page.page - 1); setActive(null); list.current?.scrollTo(0, 0); }} className="underline disabled:opacity-40">Previous</button>
      <span>Page {page.page + 1} of {page.pages} · {page.total} markets</span>
      <button type="button" disabled={page.page + 1 >= page.pages || busy} onClick={() => { setPageIndex(page.page + 1); setActive(null); list.current?.scrollTo(0, 0); }} className="underline disabled:opacity-40">Next</button>
    </nav>}
    <div role="status" className="space-y-1 text-xs text-muted-foreground [&>p]:px-2 [&>p]:py-2">
      {trimmed.length > 64 && !agent.snapshot && <p>Choose Ask Agent to search with this longer request.</p>}
      {busy && <p>Searching… {rows.length} results so far.</p>}
      {!agent.snapshot?.screening && current?.sources.filter(source => source.state !== 'complete' || source.truncated).map(source => <p key={source.id}>{source.label}: {source.state === 'complete' ? `${source.markets.length} matches${source.truncated ? ' · result limit reached; refine your search' : ''}` : source.state === 'pending' ? 'searching…' : source.state === 'disconnected' ? 'connection needs attention' : source.state === 'unsupported' ? 'lookup unavailable' : source.message ?? source.state}</p>)}
      {current?.localState === 'failed' && <p>Local Take search is unavailable.</p>}
      {current?.localTruncated && <p>Showing the first 20 takes. Refine your search for more.</p>}
      {current?.done && !rows.length && current.localState === 'complete' && current.sources.every(s => s.state === 'complete') && <p className="py-6 text-center text-sm">No results for “{trimmed}”.</p>}
    </div>
    {(error || current?.sources.some(s => s.state === 'failed') || current?.localState === 'failed') && <div className="px-2 py-2 text-center text-xs text-error"><p role="alert">{error}</p><button type="button" className="underline" onClick={() => { setError(''); setSnapshot(null); setRetry(value => value + 1); }}>Retry search</button></div>}
    </div>
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      <span><kbd className="rounded border border-border px-1">↑↓</kbd> navigate</span>
      <span><kbd className="rounded border border-border px-1">↵</kbd> open</span>
      <span><kbd className="rounded border border-border px-1">esc</kbd> close</span>
      <div className="ml-auto flex items-center gap-1">
      {(!!query || !!recents.length) && <button type="button" aria-label={query ? 'Clear search' : 'Clear recent searches'} title={query ? 'Clear search' : 'Clear recent searches'}
        className="rounded-md p-1.5 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        onClick={() => { if (query) { setQuery(''); setActive(null); setError(''); input.current?.focus(); } else { setRecents([]); writeSearchRecents([]); } }}><X size={14} aria-hidden="true" /></button>}
      <Menu.Root>
        <Menu.Trigger aria-label="Search filters" title="Venues and archived takes" className="relative flex items-center rounded-md p-1.5 hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <SlidersHorizontal size={14} aria-hidden="true" />
          {(archived || sources?.some(source => source.connected && source.capabilities.lookup && !checked.includes(source.id))) && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" aria-label="Filters active" />}
        </Menu.Trigger>
        <Menu.Portal><Menu.Positioner side="top" align="end" sideOffset={8} collisionPadding={12} className="z-[100]">
          <Menu.Popup aria-label="Search filters" className="max-h-[min(20rem,var(--available-height))] w-60 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none">
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1.5 text-xs text-muted-foreground">Venues</Menu.GroupLabel>
              {sources === null && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading venues…</p>}
              {sources?.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No venues available</p>}
              {sources?.map(source => <Menu.CheckboxItem key={source.id} checked={checked.includes(source.id)} disabled={!source.connected || !source.capabilities.lookup} closeOnClick={false}
                onCheckedChange={value => { setActive(null); setError(''); setChecked(old => value ? [...old, source.id] : old.filter(id => id !== source.id)); }}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50">
                <span className="flex size-4 shrink-0 items-center justify-center"><Menu.CheckboxItemIndicator><Check size={14} aria-hidden="true" /></Menu.CheckboxItemIndicator></span>
                <span>{source.label}{!source.connected && <span className="ml-1 text-xs text-muted-foreground">(disconnected)</span>}</span>
              </Menu.CheckboxItem>)}
              {!!sources?.some(source => source.connected && source.capabilities.lookup) && <Menu.Item closeOnClick={false} className="cursor-default rounded-md py-2 pr-2 pl-8 text-xs outline-none data-[highlighted]:bg-muted"
                onClick={() => { setActive(null); setError(''); setChecked(sources.filter(source => source.connected && source.capabilities.lookup).map(source => source.id)); }}>Select all venues</Menu.Item>}
            </Menu.Group>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.CheckboxItem checked={archived} closeOnClick={false} onCheckedChange={value => { setActive(null); setArchived(value); setError(''); }}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 outline-none data-[highlighted]:bg-muted">
              <span className="flex size-4 items-center justify-center"><Menu.CheckboxItemIndicator><Check size={14} aria-hidden="true" /></Menu.CheckboxItemIndicator></span>Archived takes
            </Menu.CheckboxItem>
          </Menu.Popup>
        </Menu.Positioner></Menu.Portal>
      </Menu.Root>
      <SearchAiPicker preferences={preferences} onSaved={setPreferences} onSettings={() => void configureSearch()} onError={setError} />
      </div>
    </div>
  </div>;
}

export function SearchDialog() {
  const open = useSearchOpen();
  return <Dialog open={open} onOpenChange={setSearchOpen}><DialogContent finalFocus={() => document.getElementById('nav-search-button')} showCloseButton={false} backdropClassName="bg-black/10" className="top-[18%] max-h-[min(32rem,80dvh)] translate-y-0 gap-0 overflow-hidden p-0 shadow-none ring-foreground/10 sm:max-w-2xl">{open && <SearchPanel />}</DialogContent></Dialog>;
}
