import type { createConnections } from '../connections';
import { marketKey, type MarketHit } from '../../shared/search';
import { bounded, type SearchAdapter } from './service';
import { normalizeEquityQuoteDetails } from '../market-series/normalization';

const isEquity = (hit: MarketHit) => ['equity', 'stock', 'etf'].includes(hit.identity.kind);
// Equity/stock/ETF are classification labels for the same provider ID space.
// Multiple rows describing one ID do not make a symbol ambiguous.
const equityReferences = (markets: MarketHit[], symbol: string) => new Set(markets
  .filter(hit => isEquity(hit) && hit.symbol === symbol)
  .map(hit => JSON.stringify([hit.identity.venue, hit.identity.instance, hit.identity.reference])));

// Keep currency-pair discovery separate from instrument discovery: a shared
// ticker does not make a coin and a stock the same asset.
export function robinhoodSearchAdapter(connections: Pick<ReturnType<typeof createConnections>, 'status' | 'readTool'>, readTimeoutMs = 10_000): SearchAdapter {
  const owns = (hit: MarketHit) => hit.identity.venue === 'robinhood' && hit.identity.instance === 'production' && (isEquity(hit) || hit.identity.kind === 'crypto');
  async function liveLookup(query: string, signal: AbortSignal) {
    const [equities, crypto] = await Promise.allSettled([
      bounded(readSignal => connections.readTool('search', { query, asset_type: 'instrument', limit: 20 }, undefined, readSignal), signal, readTimeoutMs),
      bounded(readSignal => connections.readTool('search', { query, asset_type: 'currency_pair', limit: 20 }, undefined, readSignal), signal, readTimeoutMs),
    ]);
    signal.throwIfAborted();
    if (equities.status === 'rejected' && crypto.status === 'rejected') throw equities.reason;
    const instruments = equities.status === 'fulfilled' ? normalizeRobinhoodSearch(equities.value) : [];
    const pairs = crypto.status === 'fulfilled' ? normalizeRobinhoodCryptoSearch(crypto.value) : [];
    return { markets: [...instruments, ...pairs], truncated: instruments.length >= 20 || pairs.length >= 20, incomplete: equities.status === 'rejected' || crypto.status === 'rejected' };
  }
  const cache = new Map<string, { expires: number; result: Awaited<ReturnType<typeof liveLookup>> }>();
  let generation = 0;
  async function scope() {
    const status = await connections.status();
    if (status.status !== 'connected') { cache.clear(); throw new Error('Search venue disconnected.'); }
    return JSON.stringify([status.status, status.checkedAt, status.accounts.filter(a => a.selected).map(a => [a.id, a.agenticAllowed]).sort()]);
  }
  async function lookup(query: string, signal: AbortSignal, fresh = false) {
    signal.throwIfAborted();
    const revision = generation, current = await scope();
    signal.throwIfAborted();
    const key = JSON.stringify([current, query.trim().toLowerCase()]);
    const cached = cache.get(key);
    if (!fresh && cached && cached.expires > Date.now() && revision === generation) return structuredClone(cached.result);
    cache.delete(key);
    const result = await liveLookup(query, signal);
    const latest = await scope(); signal.throwIfAborted();
    if (revision !== generation || current !== latest) throw new Error('Search account changed.');
    for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
    while (cache.size >= 100) cache.delete(cache.keys().next().value!);
    // Cache discovery only. Quotes and saved-screen runs always fetch fresh data.
    if (!result.incomplete) cache.set(key, { expires: Date.now() + 30_000, result: structuredClone(result) });
    return result;
  }
  return {
    clear() { generation++; cache.clear(); },
    id: 'robinhood', label: 'Robinhood', owns, lookup,
    async enrich(markets, signal) {
      // The quote API is symbol-scoped. Do not apply a symbol's quote to two
      // different instruments even within the same venue.
      const equities = markets.filter(hit => owns(hit) && isEquity(hit));
      const symbols = [...new Set(equities.filter(hit => equityReferences(equities, hit.symbol).size === 1).map(hit => hit.symbol))].slice(0, 20);
      if (!symbols.length) return markets;
      const quotes = normalizeEquityQuoteDetails(await connections.readTool('get_equity_quotes', { symbols }, undefined, signal));
      signal.throwIfAborted();
      const fetchedAt = new Date().toISOString();
      return markets.map(hit => {
        if (!owns(hit) || !isEquity(hit) || !symbols.includes(hit.symbol)) return hit;
        const quote = quotes.get(hit.symbol);
        const price = quote?.lastTradePrice;
        if (!price || !Number.isFinite(Number(price)) || Number(price) < 0) return hit;
        const previousClose = quote.previousClose && Number.isFinite(Number(quote.previousClose)) && Number(quote.previousClose) > 0 ? quote.previousClose : null;
        return { ...hit, quote: { price, previousClose, currency: 'USD', asOf: quote.lastTradeAt ?? null, fetchedAt } };
      });
    },
    async status() { return { id: 'robinhood', label: 'Robinhood', connected: (await connections.status()).status === 'connected', capabilities: { lookup: true, details: true, screening: true } }; },
    async resolve(hit, signal) {
      if (!owns(hit)) return null;
      const { markets } = await lookup(hit.symbol, signal, true);
      const found = markets.find(m => marketKey(m) === marketKey(hit)
        // Scan results report generic EQUITY; discovery can refine that same
        // provider instrument to stock/ETF. Keep the submitted identity stable.
        || (hit.identity.kind === 'equity' && isEquity(m) && marketKey(m) === marketKey({ identity: { ...hit.identity, kind: m.identity.kind } })));

      // The existing chart/detail service is equity-symbol scoped. Do not route
      // an ambiguous instrument through it even if the requested reference exists.
      if (hit.identity.kind === 'crypto') return found ?? null;
      return found && equityReferences(markets, found.symbol).size === 1 && /^[A-Z][A-Z0-9.-]{0,11}$/.test(found.symbol) ? { ...found, identity: hit.identity, typeLabel: hit.identity.kind === 'equity' ? 'Equity' : found.typeLabel } : null;
    },
  };
}

export function normalizeRobinhoodSearch(value: unknown): MarketHit[] {
  const found = new Map<string, MarketHit>();
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || ++visited > 2000 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const row = value as Record<string, unknown>;
    const text = (...fields: string[]) => fields.map(f => row[f]).find((v): v is string => typeof v === 'string' && !!v.trim())?.trim();
    const symbol = text('symbol', 'ticker', 'chain_symbol')?.toUpperCase();
    const reference = text('instrument_id', 'instrument_ref');
    const subtype = text('type', 'instrument_type')?.toLowerCase();
    if (!text('currency_pair_id') && (!subtype || ['equity', 'instrument', 'stock', 'etf'].includes(subtype)) && symbol && /^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol) && reference && reference.length <= 256) {
      const kind = subtype === 'etf' ? 'etf' : subtype === 'stock' ? 'stock' : 'equity';
      const hit: MarketHit = { identity: { venue: 'robinhood', instance: 'production', reference, kind }, symbol,
        name: (text('simple_name', 'display_name', 'name') ?? symbol).slice(0, 300), venueLabel: 'Robinhood', typeLabel: kind === 'etf' ? 'ETF' : kind === 'stock' ? 'Stock' : 'Equity' };
      found.set(marketKey(hit), hit);
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...found.values()];
}

// Discovery is read-only. A pair reference is required; never turn a ticker,
// an equity instrument ID, or a search result into evidence of tradability.
export function normalizeRobinhoodCryptoSearch(value: unknown): MarketHit[] {
  const found = new Map<string, MarketHit>();
  let visited = 0;
  const visit = (value: unknown, depth: number, pairEntry = false) => {
    if (depth > 8 || ++visited > 2000 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1, pairEntry); return; }
    const row = value as Record<string, unknown>;
    const text = (...fields: string[]) => fields.map(f => row[f]).find((v): v is string => typeof v === 'string' && !!v.trim())?.trim();
    // Generic IDs are valid only in the provider's currency_pairs collection.
    // Never reinterpret an equity/index ID or nested metadata as a crypto pair.
    const reference = pairEntry ? text('id') : text('currency_pair_id');
    const symbol = text('symbol', 'ticker')?.toUpperCase();
    if (reference && reference.length <= 256 && symbol && /^[A-Z0-9][A-Z0-9./-]{0,31}$/.test(symbol)) {
      const hit: MarketHit = { identity: { venue: 'robinhood', instance: 'production', reference, kind: 'crypto' },
        symbol, name: (text('display_name', 'name', 'simple_name') ?? symbol).slice(0, 300), venueLabel: 'Robinhood', typeLabel: 'Crypto' };
      found.set(marketKey(hit), hit);
    }
    for (const [key, child] of Object.entries(row)) visit(child, depth + 1, key === 'currency_pairs' && Array.isArray(child));
  };
  visit(value, 0);
  return [...found.values()];
}
