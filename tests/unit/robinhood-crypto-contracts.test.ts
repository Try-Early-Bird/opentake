import { expect, test } from 'vitest';
import Ajv from 'ajv';
import definitions from '../fixtures/robinhood-crypto-tool-schemas-2026-10-14.json';
import { parseRead, toolCatalog } from '../../src/main/opentake-mcp/catalog';

test('catalog and quote read arguments conform to captured provider schemas', () => {
  const ajv = new Ajv({ strict: false });
  for (const [name, input] of [
    ['get_currency_pairs', {}],
    ['get_currency_pairs', { limit: 700, cursor: 'opaque-next' }],
    ['get_crypto_quotes', { symbols: ['btc-usd', 'ETH-USD'], timezone: 'America/New_York' }],
  ] as const) {
    const parsed = parseRead(name, input, true);
    const schema = definitions.tools.find(t => t.name === name)!.inputSchema;
    const validate = ajv.compile(schema);
    expect(validate(parsed.args), JSON.stringify(validate.errors)).toBe(true);
    expect(parsed.tool.account).toBe(false);
    expect(toolCatalog().find(t => t.name === `robinhood_${name}`)?.annotations.readOnlyHint).toBe(true);
  }
  expect(parseRead('get_crypto_quotes', { symbols: ['btc-usd'] }, true).args).toEqual({ symbols: ['BTC-USD'] });
});

test('crypto reads bound inputs and reject injected provider account identifiers', () => {
  for (const input of [{ limit: 701 }, { limit: 0 }, { cursor: '' }, { rhs_account_number: '1234' }]) {
    expect(() => parseRead('get_currency_pairs', input, true)).toThrow();
  }
  for (const input of [
    { symbols: [] }, { symbols: Array(21).fill('BTC-USD') },
    { symbols: ['BTC-USD'], timezone: 'not-a-zone' },
    { symbols: ['BTC-USD'], timezone: 'PST' },
    { symbols: ['BTC-USD'], rhs_account_number: '1234' },
    { symbols: ['BTC-USD'], account_number: 'synthetic' },
    { symbols: ['BTC-USD'], accountRef: '11111111-1111-4111-8111-111111111111' },
  ]) expect(() => parseRead('get_crypto_quotes', input, true)).toThrow();
});

test('crypto order write tools remain unavailable through the read gateway', () => {
  for (const name of ['place_crypto_order', 'cancel_crypto_order', 'decline_trade_approval']) {
    expect(() => parseRead(name, {}, true)).toThrow('Tool unavailable');
    expect(toolCatalog().find(t => t.name === `robinhood_${name}`)).toBeUndefined();
  }
});
