import { expect, test } from 'vitest';
import { parseRead, readTakesAccount } from '../../src/main/opentake-mcp/catalog';

const ref = '11111111-1111-4111-8111-111111111111';

test('chat binds the selected account only to reads that take one', () => {
  expect(readTakesAccount('get_equity_quotes')).toBe(false);
  expect(readTakesAccount('get_option_quotes')).toBe(false);
  expect(readTakesAccount('get_portfolio')).toBe(true);
  expect(readTakesAccount('get_equity_tradability')).toBe(true);
  // Binding one anyway is what made chat's quote lookups fail.
  expect(() => parseRead('get_equity_quotes', { symbols: ['ceg'], accountRef: ref }, true)).toThrow('does not accept an account');
  expect(parseRead('get_equity_quotes', { symbols: ['ceg'] }, true).args).toEqual({ symbols: ['CEG'] });
});
