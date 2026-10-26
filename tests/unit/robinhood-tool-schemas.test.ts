import { expect, test, vi } from 'vitest';
import { listCryptoToolSchemas } from '../../src/main/robinhood-tool-schemas';

const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const, properties: { pair_id: { type: 'string' } }, required: ['pair_id'] } });

test('lists paginated crypto metadata without invoking tools or returning server extras', async () => {
  const callTool = vi.fn();
  const listTools = vi.fn()
    .mockResolvedValueOnce({ tools: [tool('get_equity_orders'), { ...tool('get_currency_pairs'), _meta: { private: 'omit' } }], nextCursor: 'page2', _meta: { private: 'omit' } })
    .mockResolvedValueOnce({ tools: [{ ...tool('place_crypto_order'), description: 'Place', outputSchema: { type: 'object' } }] });
  const signal = new AbortController().signal;
  const result = await listCryptoToolSchemas({ listTools, callTool } as Parameters<typeof listCryptoToolSchemas>[0], signal);
  expect(result).toEqual([tool('get_currency_pairs'), { ...tool('place_crypto_order'), description: 'Place', outputSchema: { type: 'object' } }]);
  expect(listTools).toHaveBeenNthCalledWith(2, { cursor: 'page2' }, { signal, timeout: 20_000 });
  expect(callTool).not.toHaveBeenCalled();
});

test('fails on repeated cursors, duplicate definitions and oversized metadata', async () => {
  const signal = new AbortController().signal;
  await expect(listCryptoToolSchemas({ listTools: vi.fn().mockResolvedValue({ tools: [], nextCursor: 'same' }) }, signal)).rejects.toThrow('Repeated');
  await expect(listCryptoToolSchemas({ listTools: vi.fn().mockResolvedValue({ tools: [tool('get_crypto_quotes'), tool('get_crypto_quotes')] }) }, signal)).rejects.toThrow('Duplicate');
  await expect(listCryptoToolSchemas({ listTools: vi.fn().mockResolvedValue({ tools: [], padding: 'x'.repeat(4 * 1024 * 1024) }) }, signal)).rejects.toThrow('too large');
});

test('cancellation rejects results even when transport ignores abort', async () => {
  const controller = new AbortController();
  const listTools = vi.fn(async () => { controller.abort(); return { tools: [tool('get_crypto_quotes')] }; });
  await expect(listCryptoToolSchemas({ listTools }, controller.signal)).rejects.toThrow();
  const untouched = vi.fn();
  await expect(listCryptoToolSchemas({ listTools: untouched }, controller.signal)).rejects.toThrow();
  expect(untouched).not.toHaveBeenCalled();
});

test('bounds pagination and propagates provider errors without partial success', async () => {
  let page = 0;
  const listTools = vi.fn(async () => ({ tools: [], nextCursor: String(++page) }));
  await expect(listCryptoToolSchemas({ listTools }, new AbortController().signal)).rejects.toThrow('Too many');
  expect(listTools).toHaveBeenCalledTimes(20);
  await expect(listCryptoToolSchemas({ listTools: vi.fn().mockRejectedValue(new Error('offline')) }, new AbortController().signal)).rejects.toThrow('offline');
});


test('includes account binding and approval contracts without invoking their tools', async () => {
  const names = ['get_accounts', 'get_trade_approvals', 'decline_trade_approval', 'search'];
  const listTools = vi.fn().mockResolvedValue({ tools: names.map(tool) });
  expect((await listCryptoToolSchemas({ listTools }, new AbortController().signal)).map(t => t.name))
    .toEqual([...names].sort());
});


test('keeps newly advertised crypto read definitions without assuming their contracts', async () => {
  const callTool=vi.fn();
  // Synthetic future names test discovery, not a claim that the server has them.
  const names=['get_crypto_future_history','list_crypto_future_bars'];
  const listTools=vi.fn().mockResolvedValue({tools:[...names.map(tool),tool('delete_crypto_future_data'),tool('get_equity_historicals')]});
  const result=await listCryptoToolSchemas({listTools,callTool} as Parameters<typeof listCryptoToolSchemas>[0],new AbortController().signal);
  expect(result.map(row=>row.name)).toEqual(names);
  expect(callTool).not.toHaveBeenCalled();
});
