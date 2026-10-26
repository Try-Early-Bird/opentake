import { z } from 'zod';

// Symbols are labels. Source + instance + provider reference + kind identify a market.
export const marketIdentitySchema = z.object({
  venue: z.string().min(1).max(80), instance: z.string().min(1).max(80),
  reference: z.string().min(1).max(256), kind: z.string().min(1).max(80),
  pair: z.string().max(80).optional(), contract: z.string().max(256).optional(),
}).strict();
export const marketHitSchema = z.object({
  identity: marketIdentitySchema, symbol: z.string().min(1).max(80),
  name: z.string().min(1).max(300), venueLabel: z.string().min(1).max(100),
  typeLabel: z.string().min(1).max(80),
  quote: z.object({
    price: z.string().max(80).regex(/^\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value))),
    previousClose: z.string().max(80).regex(/^\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value)) && Number(value) > 0).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/), asOf: z.iso.datetime().nullable(), fetchedAt: z.iso.datetime(),
  }).strict().optional(),
}).strict();
export type MarketHit = z.infer<typeof marketHitSchema>;
export function marketKey(hit: Pick<MarketHit, 'identity'>): string {
  const m = hit.identity;
  return JSON.stringify([m.venue, m.instance, m.reference, m.kind, m.pair ?? null, m.contract ?? null]);
}
export interface SearchSource {
  id: string; label: string; connected: boolean;
  capabilities: { lookup: boolean; details: boolean; screening: boolean };
}
export interface TakeHit { id: string; title: string; strategyId: string | null; strategyTitle: string | null; archived: boolean }
export type SourceState = 'pending' | 'complete' | 'partial' | 'failed' | 'disconnected' | 'unsupported' | 'cancelled';
export interface SearchSourceResult { id: string; label: string; state: SourceState; markets: MarketHit[]; message?: string; truncated: boolean }
export const searchInputSchema = z.object({
  id: z.uuid(), query: z.string().trim().min(1).max(64),
  sources: z.array(z.string().min(1).max(100)).max(20), archived: z.boolean(),
}).strict();
export type SearchInput = z.infer<typeof searchInputSchema>;
export interface SearchSnapshot {
  id: string; query: string; sources: SearchSourceResult[];
  takes: TakeHit[]; localState: SourceState; localTruncated: boolean; done: boolean;
}
export interface SearchAPI {
  sources(): Promise<SearchSource[]>;
  start(input: SearchInput): Promise<SearchSnapshot>;
  snapshot(id: string): Promise<SearchSnapshot | null>;
  cancel(id: string): Promise<void>;
  resolve(hit: MarketHit): Promise<MarketHit | null>;
}

/** Rank across venues without conflating same-symbol provider identities. */
export function rankMarkets(markets: MarketHit[], query: string): MarketHit[] {
  const q = query.trim().toLowerCase();
  const rank = (hit: MarketHit) => {
    const symbol = hit.symbol.toLowerCase(), name = hit.name.trim().toLowerCase();
    return symbol === q ? 0 : name === q ? 1 : symbol.startsWith(q) ? 2 : name.startsWith(q) ? 3 : 4;
  };
  return [...new Map(markets.map(hit => [marketKey(hit), hit])).values()]
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol) || marketKey(a).localeCompare(marketKey(b)));
}
export function marketPage(markets: MarketHit[], page: number) {
  const pages = Math.max(1, Math.ceil(markets.length / 20));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  return { markets: markets.slice(current * 20, (current + 1) * 20), page: current, pages, total: markets.length };
}
