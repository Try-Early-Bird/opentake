import { expect, test, vi } from 'vitest';
import { normalizeRobinhoodCryptoSearch, normalizeRobinhoodSearch, robinhoodSearchAdapter } from '../../src/main/search/robinhood';
import { marketKey } from '../../src/shared/search';
import { parseRead } from '../../src/main/opentake-mcp/catalog';
import Ajv from 'ajv';
import definitions from '../fixtures/robinhood-crypto-tool-schemas-2026-10-14-followup.json';

// Synthetic discovery responses; not a captured live-account contract.
const pair = { currency_pair_id: '00000000-0000-4000-8000-000000000101', symbol: 'BTC', name: 'Bitcoin' };
const stock = { instrument_id: 'stock-btc', symbol: 'BTC', name: 'Same-ticker equity', type: 'stock' };
const signal = new AbortController().signal;
const status = async () => ({ status: 'connected' as const, accounts: [], checkedAt: null });

test('documented currency_pairs response resolves crypto by its provider id', async () => {
  const response = { data: { currency_pairs: [{ id: pair.currency_pair_id, symbol: 'BTC-USD', name: 'Bitcoin' }] }, guide: '' };
  const schema = definitions.tools.find(t => t.name === 'search')!.outputSchema;
  const validate = new Ajv({ strict: false }).compile(schema);
  expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
  const adapter = robinhoodSearchAdapter({ status, readTool: async (_name, input) => input.asset_type === 'currency_pair' ? response : { data: { results: [] } } });
  const result = await adapter.lookup('Bitcoin', signal);
  expect(result.markets).toHaveLength(1);
  expect(result.markets[0]).toMatchObject({ symbol: 'BTC-USD', identity: { kind: 'crypto', reference: pair.currency_pair_id } });
  expect(await adapter.resolve(result.markets[0], signal)).toEqual(result.markets[0]);
  expect(normalizeRobinhoodSearch(response)).toEqual([]);
});

test('generic index IDs and nested metadata cannot become crypto search identities', () => {
  const generic = { id: 'unrelated', symbol: 'BTC-USD', name: 'Not a pair' };
  expect(normalizeRobinhoodCryptoSearch({ data: { results: [generic], market_indexes: [generic] } })).toEqual([]);
  expect(normalizeRobinhoodCryptoSearch({ data: { currency_pairs: [{ ...generic, id: '', metadata: generic }] } })).toEqual([]);
  expect(normalizeRobinhoodCryptoSearch({ data: { currency_pairs: [generic, generic] } })).toHaveLength(1);
});

test('same-ticker crypto pairs resolve by opaque provider ID without UUID assumptions', async () => {
  const rows = [{ ...pair, currency_pair_id: 'provider-btc-usd' }, { ...pair, currency_pair_id: 'provider-btc-eur' }];
  const adapter = robinhoodSearchAdapter({ status, readTool: async (_name, input) => ({ results: input.asset_type === 'currency_pair' ? rows : [stock] }) });
  const { markets } = await adapter.lookup('BTC', signal);
  expect(markets).toHaveLength(3);
  for (const hit of markets) expect(await adapter.resolve(hit, signal)).toEqual(hit);
  expect(normalizeRobinhoodCryptoSearch([{ ...pair, currency_pair_id: 'x'.repeat(257) }])).toEqual([]);
});

test('multiple classifications of one equity ID do not block its detail route', async () => {
  const adapter = robinhoodSearchAdapter({ status, readTool: async (_name, input) => ({ results: input.asset_type === 'instrument' ? [stock, { ...stock, type: 'equity' }] : [] }) });
  const hit = normalizeRobinhoodSearch([stock])[0];
  expect(await adapter.resolve(hit, signal)).toEqual(hit);
});

test('crypto requires a provider currency-pair reference and never masquerades as equity', () => {
  const raw = { results: [pair, pair, stock, { symbol: 'ETH', id: pair.currency_pair_id },
    { ...pair, currency_pair_id: '' }, { instrument_id: 'crypto', symbol: 'ETH', type: 'crypto' }] };
  expect(normalizeRobinhoodCryptoSearch(raw)).toHaveLength(1);
  expect(normalizeRobinhoodCryptoSearch(raw)[0]).toMatchObject({ symbol: 'BTC', typeLabel: 'Crypto', identity: { reference: pair.currency_pair_id, kind: 'crypto' } });
  expect(normalizeRobinhoodSearch(raw)).toHaveLength(1);
  expect(normalizeRobinhoodSearch(raw)[0].identity.reference).toBe(stock.instrument_id);
});

test('search requests both asset classes, preserves identity and never puts an equity price on crypto', async () => {
  const readTool = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'get_equity_quotes') return { results: [{ symbol: 'BTC', last_trade_price: '25' }] };
    expect(name).toBe('search');
    return { results: input.asset_type === 'currency_pair' ? [pair] : [stock] };
  });
  const adapter = robinhoodSearchAdapter({ status, readTool });
  const result = await adapter.lookup('BTC', signal);
  expect(readTool).toHaveBeenCalledWith('search', { query: 'BTC', asset_type: 'currency_pair', limit: 20 }, undefined, expect.any(AbortSignal));
  expect(result.markets.map(hit => hit.typeLabel)).toEqual(['Stock', 'Crypto']);
  expect(new Set(result.markets.map(marketKey)).size).toBe(2);
  const enriched = await adapter.enrich!(result.markets, signal);
  expect(enriched[0].quote?.price).toBe('25');
  expect(enriched[1].quote).toBeUndefined();
  expect(await adapter.resolve(result.markets[0], signal)).toEqual(result.markets[0]);
  expect(await adapter.resolve(result.markets[1], signal)).toEqual(result.markets[1]);
  expect(await adapter.resolve({ ...result.markets[1], identity: { ...result.markets[1].identity, reference: 'unknown' } }, signal)).toBeNull();
});

test('an equity locator cannot resolve to a crypto pair sharing its reference', async () => {
  const adapter = robinhoodSearchAdapter({ status, readTool: async () => ({ results: [pair] }) });
  const crypto = normalizeRobinhoodCryptoSearch([pair])[0];
  expect(await adapter.resolve({ ...crypto, identity: { ...crypto.identity, kind: 'equity' } }, signal)).toBeNull();
  const readTool = vi.fn();
  await robinhoodSearchAdapter({ status, readTool }).enrich!([crypto], signal);
  expect(readTool).not.toHaveBeenCalled();
});

test('a failed crypto query is not presented as a complete equity-only search', async () => {
  const adapter = robinhoodSearchAdapter({ status, readTool: async (_name, input) => {
    if (input.asset_type === 'currency_pair') throw new Error('synthetic unavailable');
    return { results: [stock] };
  } });
  expect(await adapter.lookup('BTC', signal)).toMatchObject({ incomplete: true, markets: [expect.objectContaining({ symbol: 'BTC', typeLabel: 'Stock' })] });
});

test('discovery does not enable order placement through the read tool channel', () => {
  expect(parseRead('search', { query: 'BTC', asset_type: 'currency_pair', limit: 20 }, true).args.asset_type).toBe('currency_pair');
  for (const name of ['place_crypto_order', 'cancel_crypto_order']) {
    expect(() => parseRead(name, {}, true)).toThrow('Tool unavailable');
  }
});

test('equity failure preserves crypto and a retry recovers both asset classes', async () => {
  let fail = true;
  const readTool = vi.fn(async (_name, input) => {
    if (input.asset_type === 'instrument' && fail) throw new Error('synthetic private error');
    return { results: input.asset_type === 'instrument' ? [stock] : [pair] };
  });
  const adapter = robinhoodSearchAdapter({ status, readTool });
  expect(await adapter.lookup('BTC', signal)).toMatchObject({ incomplete: true, markets: [expect.objectContaining({ typeLabel: 'Crypto' })] });
  fail = false;
  expect(await adapter.lookup('BTC', signal)).toMatchObject({ incomplete: false, markets: expect.arrayContaining([expect.objectContaining({ typeLabel: 'Stock' }), expect.objectContaining({ typeLabel: 'Crypto' })]) });
  expect(readTool).toHaveBeenCalledTimes(4);
});

test('a hung crypto read times out without losing equities or accepting its late response', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const adapter = robinhoodSearchAdapter({ status, readTool: async (_name, input) => input.asset_type === 'currency_pair' ? pending : { results: [stock] } }, 10);
  const result = await adapter.lookup('BTC', signal);
  expect(result).toMatchObject({ incomplete: true, markets: [expect.objectContaining({ typeLabel: 'Stock' })] });
  release({ results: [pair] });
  await Promise.resolve();
  expect(result.markets).toHaveLength(1);
});

test('both failed queries still fail and cancellation never becomes partial success', async () => {
  const failed = robinhoodSearchAdapter({ status, readTool: async () => { throw new Error('unavailable'); } });
  await expect(failed.lookup('BTC', signal)).rejects.toThrow();
  const controller = new AbortController();
  const adapter = robinhoodSearchAdapter({ status, readTool: async (_name, input) => {
    if (input.asset_type === 'currency_pair') { controller.abort(); throw new Error('cancelled'); }
    return { results: [stock] };
  } });
  await expect(adapter.lookup('BTC', controller.signal)).rejects.toThrow();
});

test('fresh navigation rejects evidence if the selected account changes during lookup', async () => {
  let revision = 'one';
  const adapter = robinhoodSearchAdapter({ status: async () => ({ status: 'connected', accounts: [], checkedAt: revision }), readTool: async () => {
    revision = 'two'; return { results: [stock] };
  } });
  await expect(adapter.resolve(normalizeRobinhoodSearch([stock])[0], signal)).rejects.toThrow('account changed');
});
