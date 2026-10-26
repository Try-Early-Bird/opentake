import { Link, useNavigate } from '@tanstack/react-router';
import { Menu } from '@base-ui/react/menu';
import { ArrowDown, ArrowUp, ChevronUp, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { WATCHLIST_PAGE_SIZE, type Watchlist, type WatchlistItem, type WatchlistMarketItem, type WatchlistTakeItem } from '../../../shared/watchlists';
import type { SymbolSeries } from '../market-series';
import { cn } from '../lib/utils';
import { announceWatchlistsChanged, chartsSeries, formatQuotePrice, marketRoute, readOpenLists, showsPrice, useDragOrder, useListRefresh, useListSeries, useWatchlists, writeOpenLists } from '../watchlists';
import { CreateListDialog } from './CreateListDialog';
import { SeriesRow } from './SeriesRow';
import { Skeleton } from './ui/skeleton';

// The Portfolio side panel, styled after Earlybird's desktop app's
// Lists card: every list, collapsible, with 1D sparkline rows for Robinhood
// stocks and Coinbase markets, price rows for Robinhood crypto (no history
// source there), and plain rows for takes and markets without a price source. A list mixes
// venues freely; most of it lives only in the app. Lists do not depend on the selected account.
// Markets and takes are added and removed from their own pages. Only open
// lists load items, a page at a time; a mirrored list reads its entries from
// Robinhood when it is opened and they are stale. Lists and app items reorder
// by drag or Alt+↑/↓; mirrored entries keep Robinhood's order.

const objectTypeLabels: Record<string, string> = {
  index: 'Index',
};
const menuItemClass = 'flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-xs outline-none data-[highlighted]:bg-muted disabled:opacity-50';

function NameInput({ initial, label, onSubmit, onCancel }: { initial: string; label: string; onSubmit: (name: string) => Promise<void>; onCancel: () => void }): React.JSX.Element {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || name.trim() === '') return;
        setBusy(true);
        void onSubmit(name.trim()).finally(() => setBusy(false));
      }}
    >
      <input
        autoFocus
        aria-label={label}
        value={name}
        maxLength={64}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
        onBlur={() => { if (name.trim() === initial.trim()) onCancel(); }}
        placeholder="List name"
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </form>
  );
}

/** The list's emoji, or the hosted app's fallback: 👀 for app lists, ⭐️ for
 *  Robinhood's curated lists, 💡 for the member's Robinhood lists. */
function ListIcon({ list }: { list: Watchlist }): React.JSX.Element {
  const fallback = list.mirror === null ? '👀' : list.mirror.ownerType === 'curated' ? '⭐️' : '💡';
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-[15px] leading-none" aria-hidden="true">
      {list.iconEmoji ?? fallback}
    </span>
  );
}

const dropTarget = 'bg-muted/60';

/** List headers while the lists load: emoji tile and name. */
function ListsSkeleton(): React.JSX.Element {
  return (
    <ul role="status" aria-label="Loading lists" className="m-0 mt-2 list-none divide-y divide-border p-0">
      {['w-28', 'w-20', 'w-24'].map((width) => (
        <li key={width} className="flex items-center gap-3 py-2.5">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <Skeleton className={cn('h-3.5', width)} />
        </li>
      ))}
    </ul>
  );
}

/** Item rows while a list loads, in the compact SeriesRow's columns. */
function RowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }): React.JSX.Element {
  return (
    <ul role="status" aria-label={label} className="m-0 list-none p-0 pb-1">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(4.5rem,1fr)] items-center gap-3 border-b border-border py-2 last:border-0">
          <Skeleton className="h-3.5 w-12" />
          <span className="flex h-7 w-12 items-center"><Skeleton className="h-0.5 w-full" /></span>
          <span className="flex flex-col items-end gap-1.5">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-2.5 w-10" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function MarketRow({ item, mixed, series, loading, itemProps }: { item: WatchlistMarketItem; mixed: boolean; series: SymbolSeries | undefined; loading: boolean; itemProps: React.HTMLAttributes<HTMLElement> }): React.JSX.Element {
  const navigate = useNavigate();
  const route = marketRoute(item);
  const open = (): void => {
    if (route.to === '/rh/$symbol') void navigate({ to: route.to, params: route.params });
    else if (route.to === '/coinbase/$product') void navigate({ to: route.to, params: route.params, search: {} });
    else void navigate({ to: route.to, params: route.params });
  };
  if (!showsPrice(item)) {
    return (
      <li {...itemProps} className={cn('border-b border-border last:border-0', itemProps.className)}>
        <button type="button" onClick={open} className="group flex w-full items-center gap-3 py-2 text-left text-[13px]">
          <span className="min-w-0 flex-1 truncate font-semibold group-hover:underline">{item.symbol}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{objectTypeLabels[item.identity.kind] ?? 'No price yet'}</span>
        </button>
      </li>
    );
  }
  return (
    <SeriesRow
      compact
      title={item.symbol}
      subtitle={mixed ? item.venueLabel : undefined}
      series={series}
      fallbackPrice={item.quote?.price ?? null}
      fallbackChangePercent={item.quote?.changePercent ?? null}
      formatPrice={(value, currency) => formatQuotePrice(String(value), currency)}
      currency={item.quote?.currency ?? 'USD'}
      loading={(chartsSeries(item) && loading) || item.quoteGap === 'pending'}
      onSelect={open}
      itemProps={itemProps}
    />
  );
}

function TakeRow({ item, itemProps }: { item: WatchlistTakeItem; itemProps: React.HTMLAttributes<HTMLElement> }): React.JSX.Element {
  return (
    <li {...itemProps} className={cn('border-b border-border last:border-0', itemProps.className)}>
      <Link to="/strategies/$strategyId" params={{ strategyId: item.strategyId }} className="group flex items-center gap-3 py-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-semibold group-hover:underline">{item.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{item.archived ? 'Archived take' : 'Take'}</span>
      </Link>
    </li>
  );
}

function ListItems({ list, onError }: { list: Watchlist; onError: (message: string) => void }): React.JSX.Element {
  const [items, setItems] = useState<WatchlistItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const { series, pending } = useListSeries(items, refreshCount);
  const loaded = items?.length ?? 0;
  // Robinhood curates some lists; those are read-only here as there.
  const editable = list.mirror?.ownerType !== 'curated';
  const mirrored = items?.filter((item) => item.source === 'mirror').length ?? 0;
  // App items move among themselves, after the mirrored entries.
  const moveItem = async (itemId: string, index: number): Promise<void> => {
    const at = Math.max(index, mirrored);
    setItems((current) => {
      const moving = current?.find((item) => item.id === itemId);
      if (!current || !moving) return current;
      const rest = current.filter((item) => item.id !== itemId);
      rest.splice(at, 0, moving);
      return rest;
    });
    try {
      await window.watchlists.moveItem(list.id, itemId, at);
      announceWatchlistsChanged();
    } catch {
      onError('Could not move this item.');
      void load(loaded);
    }
  };
  const { rowProps, over } = useDragOrder(items?.map((item) => item.id) ?? [], (id, index) => void moveItem(id, index));
  const propsFor = (item: WatchlistItem): React.HTMLAttributes<HTMLElement> => {
    const props = rowProps(item.id, editable && item.source === 'app');
    return { ...props, className: cn(over === item.id && dropTarget), title: props.draggable ? 'Drag or press Alt+↑/↓ to reorder' : undefined };
  };

  // Reloads what is showing (at least one page), so prices and edits stay current.
  const load = useCallback(async (count: number) => {
    try {
      const page = await window.watchlists.items(list.id, 0, Math.min(Math.max(count, WATCHLIST_PAGE_SIZE), 100));
      setItems(page.items);
      setNext(page.nextOffset);
      return page;
    } catch {
      onError('Could not load this list.');
      return null;
    }
  }, [list.id, onError]);
  const refresh = useCallback(() => { void load(loaded); setRefreshCount((count) => count + 1); }, [load, loaded]);
  useListRefresh(refresh);
  useEffect(() => {
    let live = true;
    void load(0).then(async (page) => {
      if (!live || !page?.itemsStale) return;
      setSyncing(true);
      try {
        const result = await window.watchlists.syncItems(list.id);
        if (live && result.state === 'synced') { await load(0); announceWatchlistsChanged(); }
      } catch {
        if (live) onError('Could not read this list from Robinhood.');
      } finally {
        if (live) setSyncing(false);
      }
    });
    return () => { live = false; };
    // Only on open: later loads keep the member's page count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.id]);

  const more = async (): Promise<void> => {
    if (next === null || loading) return;
    setLoading(true);
    try {
      const page = await window.watchlists.items(list.id, next);
      setItems((current) => [...(current ?? []), ...page.items.filter((item) => !(current ?? []).some((known) => known.id === item.id))]);
      setNext(page.nextOffset);
    } catch {
      onError('Could not load more of this list.');
    } finally {
      setLoading(false);
    }
  };
  if (items === null) return <RowsSkeleton label={`Loading ${list.name}`} rows={Math.min(Math.max(list.itemCount, 1), 3)} />;
  if (items.length === 0 && syncing) {
    return (
      <>
        <p className="pb-1 text-[11px] text-muted-foreground">Reading this list from Robinhood…</p>
        <RowsSkeleton label={`Reading ${list.name} from Robinhood`} />
      </>
    );
  }
  const mixed = new Set(items.flatMap((item) => (item.kind === 'market' ? [item.venue] : []))).size > 1;
  // Without a Robinhood connection, say so once rather than on every row.
  const needsConnect = items.some((item) => item.kind === 'market' && item.quoteGap === 'connect');
  return (
    <>
    {needsConnect && <p className="pb-1 text-[11px] text-muted-foreground">Connect Robinhood to see its prices.</p>}
    <ul id={`list-items-${list.id}`} className="m-0 max-h-[28rem] list-none overflow-y-auto p-0 pb-1">
      {items.length === 0 ? (
        <li className="pb-3 text-[11px] text-muted-foreground">Nothing on this list yet.</li>
      ) : items.map((item) => item.kind === 'take' ? (
        <TakeRow key={item.id} item={item} itemProps={propsFor(item)} />
      ) : (
        <MarketRow key={item.id} item={item} mixed={mixed} series={series.get(item.key)} loading={pending} itemProps={propsFor(item)} />
      ))}
      {next !== null && (
        <li>
          {loading ? <RowsSkeleton label={`Loading more of ${list.name}`} rows={2} /> : (
            <button type="button" onClick={() => void more()} className="w-full rounded-md py-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
              {`Show more (${list.itemCount - items.length})`}
            </button>
          )}
        </li>
      )}
    </ul>
    </>
  );
}

export function ListsPanel(): React.JSX.Element {
  const { lists, error, reload } = useWatchlists();
  // Open lists are remembered; with nothing remembered the first list opens.
  const [open, setOpen] = useState<Set<string> | null>(readOpenLists);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Robinhood lists mirror on open (skipped while fresh) and on refresh.
  const sync = useCallback(async (force: boolean) => {
    setSyncing(true);
    try {
      const result = await window.watchlists.sync(force);
      if (result.state === 'synced') { await reload(); announceWatchlistsChanged(); }
    } catch {
      if (force) setActionError('Could not sync your Robinhood lists.');
    } finally {
      setSyncing(false);
    }
  }, [reload]);
  useEffect(() => { void sync(false); }, [sync]);

  const act = async (work: () => Promise<unknown>, failure: string): Promise<void> => {
    setActionError(null);
    try {
      await work();
      await reload();
      announceWatchlistsChanged();
    } catch {
      setActionError(failure);
    }
  };
  const showError = useCallback((message: string) => setActionError(message), []);
  const moveList = (id: string, index: number): Promise<void> => act(() => window.watchlists.move(id, index), 'Could not move the list.');
  const ids = lists?.map((list) => list.id) ?? [];
  const { rowProps, over } = useDragOrder(ids, (id, index) => void moveList(id, index));
  const openIds = open ?? new Set(lists?.[0] ? [lists[0].id] : []);
  const toggle = (id: string): void => {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next);
    writeOpenLists(next);
  };

  return (
    <section aria-labelledby="lists-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="lists-heading" className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Lists</h2>
        <div className="-mr-1 flex items-center gap-1">
          <button type="button" aria-label="New list" title="New list" className="rounded-md p-1 text-foreground hover:bg-muted" onClick={() => setCreating(true)}>
            <Plus size={16} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Refresh lists" title="Sync from Robinhood" disabled={syncing} className="rounded-md p-1 text-foreground hover:bg-muted disabled:opacity-50" onClick={() => void sync(true)}>
            <RefreshCw size={14} className={cn(syncing && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
          </button>
        </div>
      </div>
      <CreateListDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async () => { await reload(); announceWatchlistsChanged(); }}
      />
      {(error ?? actionError) && <p role="alert" className="mt-2 text-[11px] text-destructive">{actionError ?? error}</p>}
      {lists === null ? (
        error ? null : <ListsSkeleton />
      ) : lists.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted-foreground">{syncing ? 'Syncing your Robinhood lists…' : 'Connect Robinhood to sync your lists, or add a market or take.'}</p>
      ) : (
        <ul className="m-0 mt-2 list-none divide-y divide-border p-0">
          {lists.map((list: Watchlist, index) => {
            const isOpen = openIds.has(list.id);
            return (
              <li key={list.id}>
                {renaming === list.id ? (
                  <NameInput
                    initial={list.name}
                    label={`Rename ${list.name}`}
                    onCancel={() => setRenaming(null)}
                    onSubmit={(name) => act(async () => { await window.watchlists.rename(list.id, name); setRenaming(null); }, 'Could not rename the list.')}
                  />
                ) : (
                  <div {...rowProps(list.id, true)} className={cn('flex items-center gap-1 rounded-md', over === list.id && dropTarget)}>
                    <button
                      type="button"
                      title="Drag or press Alt+↑/↓ to reorder"
                      className="group flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
                      aria-expanded={isOpen}
                      aria-controls={`list-items-${list.id}`}
                      onClick={() => toggle(list.id)}
                    >
                      <ListIcon list={list} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold group-hover:underline">{list.name}</span>
                      <ChevronUp size={18} className={cn('shrink-0 text-muted-foreground transition-transform', !isOpen && 'rotate-180')} aria-hidden="true" />
                    </button>
                    <Menu.Root>
                      <Menu.Trigger aria-label={`Manage ${list.name}`} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted">
                        <MoreHorizontal size={15} aria-hidden="true" />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Positioner align="end" sideOffset={6} collisionPadding={12} className="z-[100]">
                          <Menu.Popup className="min-w-36 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
                            <Menu.Item disabled={index === 0} onClick={() => void moveList(list.id, index - 1)} className={menuItemClass}><ArrowUp size={13} className="text-muted-foreground" aria-hidden="true" />Move up</Menu.Item>
                            <Menu.Item disabled={index === lists.length - 1} onClick={() => void moveList(list.id, index + 1)} className={menuItemClass}><ArrowDown size={13} className="text-muted-foreground" aria-hidden="true" />Move down</Menu.Item>
                            {list.mirror === null && (
                              <>
                                <Menu.Separator className="my-1 h-px bg-border" />
                                <Menu.Item onClick={() => setRenaming(list.id)} className={menuItemClass}><Pencil size={13} className="text-muted-foreground" aria-hidden="true" />Rename</Menu.Item>
                                <Menu.Item
                                  onClick={() => {
                                    if (window.confirm(`Delete “${list.name}”? Its items are removed too.`)) void act(() => window.watchlists.remove(list.id), 'Could not delete the list.');
                                  }}
                                  className={`${menuItemClass} text-destructive`}
                                >
                                  <Trash2 size={13} aria-hidden="true" />Delete
                                </Menu.Item>
                              </>
                            )}
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.Root>
                  </div>
                )}
                {isOpen && <ListItems list={list} onError={showError} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
