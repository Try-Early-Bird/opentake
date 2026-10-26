import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { robinhoodSearchAdapter, normalizeRobinhoodSearch } from '../../src/main/search/robinhood';
import { createSearchService } from '../../src/main/search/service';
import { readSearchRecents, writeSearchRecents } from '../../src/renderer/src/search-state';
import type { MarketHit } from '../../src/shared/search';

const hits = normalizeRobinhoodSearch({ results: [
  { symbol: 'AAA', instrument_id: 'aaa', name: 'Alpha', type: 'stock' },
  { symbol: 'BBB', instrument_id: 'bbb', name: 'Beta', type: 'etf' },
] });
const quote = { price: '105', previousClose: '100', currency: 'USD', asOf: '2026-10-09T14:00:00.000Z', fetchedAt: '2026-10-09T14:00:01.000Z' };
const status = async () => ({ status: 'connected' as const, checkedAt: null, accounts: [] });

test('one provider ID may repeat while quotes never cross venue or asset boundaries', async () => {
  const readTool = vi.fn(async () => ({ results: [{ symbol: 'AAA', last_trade_price: '105' }] }));
  const adapter = robinhoodSearchAdapter({ status, readTool });
  const stock = hits[0];
  const generic = { ...stock, identity: { ...stock.identity, kind: 'equity' } };
  const foreign = { ...stock, identity: { ...stock.identity, venue: 'other' } };
  const crypto = { ...stock, identity: { ...stock.identity, kind: 'crypto', reference: 'pair' } };
  const result = await adapter.enrich!([stock, stock, generic, foreign, crypto], new AbortController().signal);
  expect(readTool).toHaveBeenCalledWith('get_equity_quotes', { symbols: ['AAA'] }, undefined, expect.any(AbortSignal));
  expect(result.slice(0, 3).every(hit => hit.quote?.price === '105')).toBe(true);
  expect(result.slice(3).every(hit => hit.quote === undefined)).toBe(true);
});

test('search quotes are batched, retain provider times, and skip ambiguous instruments', async () => {
  const readTool = vi.fn(async () => ({ results: [
    { quote: { symbol: 'AAA', last_trade_price: '105', updated_at: quote.asOf }, close: { price: '100' } },
    { quote: { symbol: 'BBB', last_trade_price: '20', previous_close: '0' } },
    { quote: { symbol: 'OTHER', last_trade_price: '99' } },
  ] }));
  const adapter = robinhoodSearchAdapter({ status, readTool });
  const enriched = await adapter.enrich!(hits, new AbortController().signal);
  expect(readTool).toHaveBeenCalledTimes(1);
  expect(readTool).toHaveBeenCalledWith('get_equity_quotes', { symbols: ['AAA', 'BBB'] }, undefined, expect.any(AbortSignal));
  expect(enriched[0].quote).toMatchObject({ price: '105', previousClose: '100', currency: 'USD', asOf: quote.asOf });
  expect(enriched[1].quote).toMatchObject({ price: '20', previousClose: null, asOf: null });
  readTool.mockClear();
  const duplicate: MarketHit = { ...hits[0], identity: { ...hits[0].identity, reference: 'another-aaa' } };
  const ambiguous = await adapter.enrich!([hits[0], duplicate], new AbortController().signal);
  expect(ambiguous.every(hit => hit.quote === undefined)).toBe(true);
  expect(readTool).not.toHaveBeenCalled();
});

test('search publishes matches before quotes and preserves them when quote enrichment fails', async () => {
  for (const failure of [false, true]) {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const adapter = robinhoodSearchAdapter({ status, readTool: async () => ({}) });
    adapter.lookup = async () => ({ markets: hits, truncated: false });
    adapter.enrich = async markets => { await ready; if (failure) throw new Error('synthetic quote failure'); return markets.map(hit => ({ ...hit, quote })); };
    const service = createSearchService([adapter], async () => ({ takes: [], truncated: false }), 1000, 0);
    try {
      const id = randomUUID(); service.start({ id, query: 'AAA', sources: ['robinhood'], archived: false }, 'owner');
      await vi.waitFor(() => expect(service.snapshot(id, 'owner')?.sources[0].markets).toHaveLength(2));
      expect(service.snapshot(id, 'owner')?.done).toBe(false);
      expect(service.snapshot(id, 'owner')?.sources[0].markets[0].quote).toBeUndefined();
      release();
      await vi.waitFor(() => expect(service.snapshot(id, 'owner')?.done).toBe(true));
      const source = service.snapshot(id, 'owner')!.sources[0];
      expect(source.state).toBe('complete'); expect(source.markets).toHaveLength(2);
      expect(source.markets[0].quote).toEqual(failure ? undefined : quote);
    } finally { service.clear(); }
  }
});

test('recents never persist or restore stale quotes', () => {
  const rows = [{ kind: 'market' as const, hit: { ...hits[0], quote } }];
  let saved = '';
  vi.stubGlobal('localStorage', { setItem: (_: string, value: string) => { saved = value; }, getItem: () => saved });
  try {
    writeSearchRecents(rows);
    expect(JSON.parse(saved)[0].hit.quote).toBeUndefined();
    saved = JSON.stringify(rows);
    expect(readSearchRecents()).toEqual([{ kind: 'market', hit: hits[0] }]);
  } finally { vi.unstubAllGlobals(); }
});
