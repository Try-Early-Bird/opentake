import { z } from 'zod';
import type { createCoinbasePriceCache } from '../coinbase/price-cache';
import type { CoinbaseMarketsAPI } from '../../shared/coinbase-markets';
import type { MarketHit } from '../../shared/search';
import type { SearchAdapter } from './service';

const product = z.object({ product_id: z.string().max(81).regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/),
  product_type: z.string(), base_currency_id: z.string(), quote_currency_id: z.string(), base_name: z.string().max(200).optional() });
const pageSchema = z.object({ products: z.array(z.unknown()).max(1000), pagination: z.object({ has_next: z.boolean(), next_cursor: z.string().max(4096).optional() }).optional() });
export function coinbaseSearchAdapter(prices: Pick<ReturnType<typeof createCoinbasePriceCache>, 'cachedPublic'>,
  markets: Pick<CoinbaseMarketsAPI, 'detail'>, connected: () => Promise<boolean>): SearchAdapter {
  const owns = (hit: MarketHit) => hit.identity.venue === 'coinbase' && hit.identity.instance === 'production' && hit.identity.kind === 'crypto';
  const hit = (id: string, name: string): MarketHit => ({ identity: { venue: 'coinbase', instance: 'production', kind: 'crypto', reference: id }, symbol: id, name, venueLabel: 'Coinbase', typeLabel: 'Crypto' });
  return {
    id: 'coinbase', label: 'Coinbase', owns,
    async status() { return { id: 'coinbase', label: 'Coinbase', connected: await connected(), capabilities: { lookup: true, details: true, screening: false } }; },
    async lookup(query, signal) {
      signal.throwIfAborted();
      const result = await prices.cachedPublic('search-spot-v1', 'catalog', 300_000, async get => {
        const found = new Map<string, MarketHit>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 30; page++) {
          signal.throwIfAborted();
          const params = new URLSearchParams({ product_type: 'SPOT', limit: '100' });
          if (cursor) params.set('cursor', cursor); else if (page) params.set('offset', String(page * 100));
          const data = pageSchema.parse(await get(`/api/v3/brokerage/market/products?${params}`));
          signal.throwIfAborted();
          for (const raw of data.products) {
            const parsed = product.safeParse(raw);
            if (!parsed.success) continue;
            const p = parsed.data;
            if (p.product_type === 'SPOT' && p.product_id === `${p.base_currency_id}-${p.quote_currency_id}`) found.set(p.product_id, hit(p.product_id, p.base_name || p.base_currency_id));
          }
          if (data.pagination ? !data.pagination.has_next : data.products.length < 100) return [...found.values()];
          if (data.pagination) {
            cursor = data.pagination.next_cursor;
            if (!cursor || cursors.has(cursor)) throw Error('Invalid catalog pagination');
            cursors.add(cursor);
          }
        }
        throw Error('Catalog exceeds search limit');
      });
      signal.throwIfAborted();
      const q = query.trim().toLowerCase();
      return { markets: result.data.filter(m => m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)), truncated: false, incomplete: result.stale };
    },
    async resolve(locator, signal) {
      if (!owns(locator)) return null;
      signal.throwIfAborted();
      const result = await markets.detail(locator.identity.reference);
      signal.throwIfAborted();
      if (result.stale || result.market.id !== locator.identity.reference) return null;
      return hit(result.market.id, result.market.name);
    },
  };
}
