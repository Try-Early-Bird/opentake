import { useCallback, useEffect, useState } from 'react';
import { WATCHLISTS_CHANGED_EVENT, type Watchlist, type WatchlistItem, type WatchlistMarketItem } from '../../shared/watchlists';
import type { MarketHit } from '../../shared/search';
import { SERIES_RETRY_LIMIT, SERIES_RETRY_MS, type SymbolSeries } from './market-series';

const REFRESH_MS = 60_000;

export function announceWatchlistsChanged(): void {
  window.dispatchEvent(new CustomEvent(WATCHLISTS_CHANGED_EVENT));
}

/** Runs `refresh` after any list edit, on focus, and once a minute while the
 *  window is visible, so open lists keep current prices. */
export function useListRefresh(refresh: () => void): void {
  useEffect(() => {
    const run = (): void => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(run, REFRESH_MS);
    window.addEventListener(WATCHLISTS_CHANGED_EVENT, run);
    window.addEventListener('focus', run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(WATCHLISTS_CHANGED_EVENT, run);
      window.removeEventListener('focus', run);
    };
  }, [refresh]);
}

/** The member's lists, without their items. */
export function useWatchlists(): { lists: Watchlist[] | null; error: string | null; reload: () => Promise<void> } {
  const [lists, setLists] = useState<Watchlist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setLists(await window.watchlists.lists());
      setError(null);
    } catch {
      setError('Could not load your lists.');
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useListRefresh(useCallback(() => void reload(), [reload]));
  return { lists, error, reload };
}

const OPEN_KEY = 'opentake:watchlists-open';
/** Which lists the member has open, remembered on this device. */
export function readOpenLists(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(value) ? new Set(value.filter((id): id is string => typeof id === 'string')) : null;
  } catch {
    return null;
  }
}
export function writeOpenLists(open: Set<string>): void {
  try { window.localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* storage unavailable: open lists reset next time */ }
}

/** The page a market row opens: Robinhood equities by ticker, Coinbase by
 *  product, Robinhood crypto through the search locator. */
export function marketRoute(item: WatchlistMarketItem):
  | { to: '/rh/$symbol'; params: { symbol: string } }
  | { to: '/coinbase/$product'; params: { product: string } }
  | { to: '/markets/$market'; params: { market: string } } {
  if (item.venue === 'robinhood' && item.identity.kind === 'equity') return { to: '/rh/$symbol', params: { symbol: item.symbol } };
  if (item.venue === 'coinbase') return { to: '/coinbase/$product', params: { product: item.identity.reference } };
  const hit: MarketHit = { identity: item.identity, symbol: item.symbol, name: item.name ?? item.symbol, venueLabel: item.venueLabel, typeLabel: 'Crypto' };
  return { to: '/markets/$market', params: { market: JSON.stringify(hit) } };
}

/** A quote price: two decimals in dollars, more for sub-dollar crypto. */
export function formatQuotePrice(price: string, currency: string): string {
  const value = Number(price);
  if (!Number.isFinite(value)) return '—';
  const digits = value !== 0 && Math.abs(value) < 1 ? 6 : 2;
  const amount = Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value);
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

/** Whether a row shows a price: Robinhood stocks and crypto, and Coinbase markets. */
export function showsPrice(item: WatchlistMarketItem): boolean {
  return (item.venue === 'robinhood' && (item.identity.kind === 'equity' || item.identity.kind === 'crypto')) || item.venue === 'coinbase';
}

/** Whether a row can show a 1D sparkline: Robinhood stocks and Coinbase
 *  markets. Robinhood crypto rows show price and change without one. */
export function chartsSeries(item: WatchlistMarketItem): boolean {
  return (item.venue === 'robinhood' && item.identity.kind === 'equity') || item.venue === 'coinbase';
}

const SERIES_SYMBOL_LIMIT = 50;

/** 1D series for the shown rows of a list, keyed by item key. Robinhood
 *  stocks come through the selected Robinhood account in one call, re-asked
 *  while symbols are pending; Coinbase markets come from Coinbase's candles
 *  (public when no Coinbase account is connected). */
export function useListSeries(items: readonly WatchlistItem[] | null, refreshCount: number): { series: Map<string, SymbolSeries>; pending: boolean } {
  const [series, setSeries] = useState<Map<string, SymbolSeries>>(new Map());
  const [pending, setPending] = useState(false);
  const markets = (items ?? []).flatMap((item) => (item.kind === 'market' && chartsSeries(item) ? [item] : [])).slice(0, SERIES_SYMBOL_LIMIT);
  const requestKey = markets.map((item) => item.key).join('|');
  useEffect(() => {
    const stocks = markets.filter((item) => item.venue === 'robinhood');
    const products = markets.filter((item) => item.venue === 'coinbase');
    if (markets.length === 0) { setPending(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = new Map<string, SymbolSeries>();
    const publish = (): void => { if (!cancelled) setSeries(new Map(found)); };
    setPending(true);
    const loadStocks = async (attempt: number): Promise<void> => {
      if (stocks.length === 0) return;
      const status = await window.connections.status();
      const accountId = status.ok && status.connection.status === 'connected' ? status.connection.accounts.find((account) => account.selected)?.id ?? null : null;
      if (accountId === null || cancelled) return;
      const response = await window.dataSources.marketSeries(accountId, '1d', stocks.map((item) => item.symbol));
      const bySymbol = new Map(response.series.map((entry) => [entry.symbol.toUpperCase(), entry]));
      for (const item of stocks) { const entry = bySymbol.get(item.symbol.toUpperCase()); if (entry) found.set(item.key, entry); }
      publish();
      if ((response.pendingSymbols.length > 0 || response.refreshingSymbols.length > 0) && attempt < SERIES_RETRY_LIMIT && !cancelled) {
        await new Promise<void>((resolve) => { timer = setTimeout(resolve, SERIES_RETRY_MS); });
        if (!cancelled) await loadStocks(attempt + 1);
      }
    };
    const loadProducts = async (): Promise<void> => {
      await Promise.all(products.map(async (item) => {
        const response = await window.dataSources.coinbaseSeries(item.identity.reference, '1d').catch(() => null);
        if (response?.series) found.set(item.key, response.series);
      }));
      publish();
    };
    void Promise.allSettled([loadStocks(0), loadProducts()]).then(() => { if (!cancelled) setPending(false); });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // Keyed by the shown markets: a price refresh does not refetch history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, refreshCount]);
  return { series, pending };
}

/** Native drag-and-drop and Alt+↑/↓ over one ordered set of rows (lists, or
 *  one list's items). `rowProps` goes on each row's element; `onMove` gets the
 *  moved id and its new index. Drags of another set pass through untouched. */
export function useDragOrder(ids: readonly string[], onMove: (id: string, index: number) => void): {
  rowProps: (id: string, movable: boolean) => React.HTMLAttributes<HTMLElement>;
  over: string | null;
} {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const end = (): void => { setDragging(null); setOver(null); };
  const rowProps = (id: string, movable: boolean): React.HTMLAttributes<HTMLElement> => ({
    draggable: movable || undefined,
    onDragStart: movable ? (event) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      setDragging(id);
    } : undefined,
    onDragEnd: movable ? end : undefined,
    onDragOver: (event) => {
      if (dragging === null || !ids.includes(id)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (over !== id) setOver(id);
    },
    onDrop: (event) => {
      if (dragging === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragging !== id) onMove(dragging, ids.indexOf(id));
      end();
    },
    onKeyDown: movable ? (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      event.stopPropagation();
      const index = ids.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1);
      if (index >= 0 && index < ids.length) onMove(id, index);
    } : undefined,
  });
  return { rowProps, over: dragging === null ? null : over };
}
