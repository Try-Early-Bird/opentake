import { z } from 'zod';
import { marketIdentitySchema, marketKey, type MarketHit } from './search';

// The member's lists. A list holds markets from any venue and takes.
// Market items key on the canonical identity, so BTC on Coinbase and BTC on
// Robinhood are separate rows. Robinhood equities key on the ticker, the same
// identity holdings and takes use; a search hit's instrument id is converted.

export const watchlistNameSchema = z.string().trim().min(1).max(64);
export const watchlistMarketInputSchema = z.object({
  identity: marketIdentitySchema,
  symbol: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(300).optional(),
}).strict();
export const watchlistItemInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('market'), market: watchlistMarketInputSchema }).strict(),
  z.object({ kind: z.literal('take'), strategyId: z.uuid() }).strict(),
]);
export type WatchlistMarketInput = z.infer<typeof watchlistMarketInputSchema>;
export type WatchlistItemInput = z.infer<typeof watchlistItemInputSchema>;

const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const PAIR = /^[A-Z0-9._]+-[A-Z0-9._]+$/u;

/** The stored identity and key for a market item; throws for markets lists cannot hold. */
export function watchlistMarket(input: WatchlistMarketInput): { identity: MarketHit['identity']; key: string; symbol: string; name: string | null } {
  const { identity } = input, symbol = input.symbol.trim().toUpperCase(), name = input.name?.trim() || null;
  const keyed = (stored: MarketHit['identity'], label: string) => ({ identity: stored, key: marketKey({ identity: stored }), symbol: label, name });
  if (identity.instance !== 'production') throw new Error('Unsupported market');
  if (identity.venue === 'robinhood' && ['equity', 'stock', 'etf'].includes(identity.kind)) {
    // Same normalization as strategy instruments: BRK-B and BRK/B are BRK.B.
    const ticker = symbol.replace(/[-/]([A-Z])$/u, '.$1');
    if (!TICKER.test(ticker)) throw new Error('Invalid symbol');
    return keyed({ venue: 'robinhood', instance: 'production', reference: ticker, kind: 'equity' }, ticker);
  }
  if (identity.venue === 'robinhood' && identity.kind === 'crypto') return keyed({ venue: 'robinhood', instance: 'production', reference: identity.reference, kind: 'crypto' }, symbol);
  if (identity.venue === 'coinbase' && identity.kind === 'crypto') {
    const product = identity.reference.toUpperCase();
    if (!PAIR.test(product)) throw new Error('Invalid product');
    return keyed({ venue: 'coinbase', instance: 'production', reference: product, kind: 'crypto' }, product);
  }
  throw new Error('Unsupported market');
}

/** Why a market row has no price: the venue needs a connection, the first
 *  quote has not landed, or the venue/kind has no quote source here yet. */
export type WatchlistQuoteGap = 'connect' | 'pending' | 'unsupported' | 'unavailable';
export interface WatchlistQuote {
  price: string;
  /** Percent change against the previous close (Robinhood) or 24h (Coinbase). */
  changePercent: string | null;
  basis: 'previous_close' | '24h';
  currency: string;
  observedAt: string;
  stale: boolean;
}

export interface WatchlistMarketItem {
  id: string;
  kind: 'market';
  source: 'app' | 'mirror';
  key: string;
  identity: z.infer<typeof marketIdentitySchema>;
  venue: string;
  venueLabel: string;
  symbol: string;
  name: string | null;
  quote: WatchlistQuote | null;
  quoteGap: WatchlistQuoteGap | null;
  addedAt: string;
}
export interface WatchlistTakeItem {
  id: string;
  kind: 'take';
  source: 'app';
  strategyId: string;
  title: string;
  archived: boolean;
  addedAt: string;
}
export type WatchlistItem = WatchlistMarketItem | WatchlistTakeItem;

/** A list without its items: lists load this way, and a list's items load
 *  a page at a time when it is opened. */
export interface Watchlist {
  id: string;
  name: string;
  iconEmoji: string | null;
  itemCount: number;
  /** Set when the list mirrors one on a venue (Robinhood). */
  mirror: {
    venue: string;
    ownerType: 'custom' | 'curated';
    lastSyncedAt: string | null;
    /** When its items were last read from the venue; null before the first read. */
    itemsSyncedAt: string | null;
  } | null;
}

export interface WatchlistItemsPage {
  items: WatchlistItem[];
  total: number;
  /** Offset of the next page, or null at the end. */
  nextOffset: number | null;
  /** A mirrored list whose items are due a read from the venue (see `syncItems`). */
  itemsStale: boolean;
}

/** Where a target already sits, for the Add to list menu. */
export interface WatchlistMembership {
  listId: string;
  itemId: string;
  source: 'app' | 'mirror';
}

/** A Robinhood mirror pass: `fresh` when the last one is recent enough. */
export interface WatchlistSyncResult {
  state: 'synced' | 'fresh' | 'not_connected';
  syncedAt: string | null;
  /** Some pages of the list were not read; nothing was treated as removed. */
  partial?: true;
}

export const WATCHLIST_PAGE_SIZE = 25;

export interface WatchlistsAPI {
  lists(): Promise<Watchlist[]>;
  /** One page of a list's items, priced. */
  items(listId: string, offset?: number, limit?: number): Promise<WatchlistItemsPage>;
  membership(target: WatchlistItemInput): Promise<WatchlistMembership[]>;
  /** Mirrors the Robinhood lists themselves (names, not items); `force` skips the 15-minute gate. */
  sync(force?: boolean): Promise<WatchlistSyncResult>;
  /** Reads one mirrored list's items from its venue; `force` skips the 15-minute gate. */
  syncItems(listId: string, force?: boolean): Promise<WatchlistSyncResult>;
  create(input: { name: string; iconEmoji?: string }): Promise<Watchlist>;
  rename(listId: string, name: string): Promise<null>;
  remove(listId: string): Promise<null>;
  addItem(listId: string, item: WatchlistItemInput): Promise<null>;
  removeItem(listId: string, itemId: string): Promise<null>;
  /** Moves a list to `index` in the member's order. */
  move(listId: string, index: number): Promise<null>;
  /** Moves an app item to `index` in its list. Mirrored entries keep their
   *  venue's order, so app items move only among themselves, after them. */
  moveItem(listId: string, itemId: string, index: number): Promise<null>;
}

/** Fired on window after any list edit so open list views reload. */
export const WATCHLISTS_CHANGED_EVENT = 'opentake:watchlists-changed';
