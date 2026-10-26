import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { marketHitSchema, marketKey, type MarketHit, type TakeHit } from '../../shared/search';

let open = false;
const listeners = new Set<() => void>();
export function setSearchOpen(value: boolean) { open = value; for (const listener of listeners) listener(); }
export function useSearchOpen() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => open); }

// Home registers its draft saver; search must finish it before changing routes.
let beforeNavigate: (() => Promise<void>) | undefined;
export function registerSearchNavigationGuard(guard: () => Promise<void>) {
  beforeNavigate = guard;
  return () => { if (beforeNavigate === guard) beforeNavigate = undefined; };
}
export async function prepareSearchNavigation() { await beforeNavigate?.(); }

export type SearchRow = { kind: 'market'; hit: MarketHit } | { kind: 'take'; hit: TakeHit };
export function searchRowKey(row: SearchRow) { return row.kind === 'market' ? `market:${marketKey(row.hit)}` : `take:${row.hit.id}`; }
export function moveSearchSelection(rows: SearchRow[], active: string | null, direction: 1 | -1) {
  if (!rows.length) return null;
  const index = rows.findIndex(row => searchRowKey(row) === active);
  return searchRowKey(rows[index < 0 ? direction === 1 ? 0 : rows.length - 1 : (index + direction + rows.length) % rows.length]);
}
const recentSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('market'), hit: marketHitSchema }),
  z.object({ kind: z.literal('take'), hit: z.object({ id: z.uuid(), title: z.string().max(300), strategyId: z.uuid().nullable(), strategyTitle: z.string().max(300).nullable(), archived: z.boolean() }) }),
])).max(12);
const recentStorageKey = 'opentake-search-recents-v1';
function withoutQuote(row: SearchRow): SearchRow {
  if (row.kind !== 'market') return row;
  const { quote: _quote, ...hit } = row.hit;
  return { kind: 'market', hit };
}
export function readSearchRecents(): SearchRow[] {
  try { return recentSchema.parse(JSON.parse(localStorage.getItem(recentStorageKey) ?? '[]')).map(withoutQuote); } catch { return []; }
}
export function writeSearchRecents(rows: SearchRow[]) {
  try { localStorage.setItem(recentStorageKey, JSON.stringify(rows.slice(0, 12).map(withoutQuote))); } catch { /* Search still works without storage. */ }
}
