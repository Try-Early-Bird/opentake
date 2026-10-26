import { afterEach, expect, test, vi } from 'vitest';
import { robinhoodSearchAdapter } from '../../src/main/search/robinhood';
import { createSearchService } from '../../src/main/search/service';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  let account = 'one', connected = true;
  const readTool = vi.fn(async () => ({ results: [{ symbol: 'ABC', instrument_id: 'abc', type: 'stock', name: 'Alpha' }] }));
  const adapter = robinhoodSearchAdapter({ readTool, status: async () => ({ status: connected ? 'connected' : 'disconnected', checkedAt: null, accounts: [{ id: account, selected: true, agenticAllowed: true }] } as any) });
  return { adapter, readTool, signal: new AbortController().signal, account: (value: string) => { account = value; }, disconnect: () => { connected = false; } };
}

test('discovery cache expires and isolates returned objects, while quotes and navigation stay live', async () => {
  const f = fixture(), now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const first = await f.adapter.lookup('ABC', f.signal);
  first.markets[0].name = 'Mutated';
  const cached = await f.adapter.lookup('abc', f.signal);
  expect(cached.markets[0].name).toBe('Alpha'); expect(f.readTool).toHaveBeenCalledTimes(2);
  await f.adapter.enrich!(cached.markets, f.signal); await f.adapter.enrich!(cached.markets, f.signal);
  expect(f.readTool).toHaveBeenCalledTimes(4);
  await f.adapter.resolve(cached.markets[0], f.signal); expect(f.readTool).toHaveBeenCalledTimes(6);
  now.mockReturnValue(31_001); await f.adapter.lookup('ABC', f.signal); expect(f.readTool).toHaveBeenCalledTimes(8);
});

test('scope changes, disconnect and service clear cannot reuse cached discovery', async () => {
  const f = fixture(); await f.adapter.lookup('ABC', f.signal);
  f.account('two'); await f.adapter.lookup('ABC', f.signal); expect(f.readTool).toHaveBeenCalledTimes(4);
  const service = createSearchService([f.adapter], async () => ({ takes: [], truncated: false }));
  service.clear(); await f.adapter.lookup('ABC', f.signal); expect(f.readTool).toHaveBeenCalledTimes(6);
  f.disconnect(); await expect(f.adapter.lookup('ABC', f.signal)).rejects.toThrow('disconnected');
});

test('late cancelled or invalidated requests never populate cache', async () => {
  for (const mode of ['abort', 'clear', 'account']) {
    const f = fixture(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.readTool.mockImplementationOnce(async () => { await pending; return { results: [] }; });
    const controller = new AbortController();
    const work = f.adapter.lookup('ABC', controller.signal);
    await vi.waitFor(() => expect(f.readTool).toHaveBeenCalledTimes(2));
    if (mode === 'abort') controller.abort(); else if (mode === 'clear') f.adapter.clear!(); else f.account('two');
    release(); await expect(work).rejects.toThrow();
    await f.adapter.lookup('ABC', f.signal); expect(f.readTool).toHaveBeenCalledTimes(4);
  }
});

test('cache is bounded and failed lookups are retried', async () => {
  const f = fixture();
  f.readTool.mockRejectedValueOnce(new Error('Unavailable'));
  expect(await f.adapter.lookup('ABC', f.signal)).toMatchObject({ incomplete: true });
  await f.adapter.lookup('ABC', f.signal);
  for (let i = 0; i < 100; i++) await f.adapter.lookup(`Q${i}`, f.signal);
  await f.adapter.lookup('ABC', f.signal); expect(f.readTool).toHaveBeenCalledTimes(206);
});
