import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/main/migrations';
import { createLocalSearch } from '../../src/main/search/local';
import { createSearchService, type SearchAdapter } from '../../src/main/search/service';
import { normalizeRobinhoodSearch, robinhoodSearchAdapter } from '../../src/main/search/robinhood';
import { marketKey, type MarketHit, type SearchInput } from '../../src/shared/search';
import { moveSearchSelection, prepareSearchNavigation, registerSearchNavigationGuard, searchRowKey, type SearchRow } from '../../src/renderer/src/search-state';

const services: ReturnType<typeof createSearchService>[] = [];
afterEach(() => { for (const service of services.splice(0)) service.clear(); });
const hit = (venue: string, reference = 'btc', kind = 'spot'): MarketHit => ({ identity: { venue, instance: 'test', reference, kind }, symbol: 'BTC', name: 'Bitcoin', venueLabel: venue, typeLabel: kind });
function adapter(id: string, lookup: SearchAdapter['lookup']): SearchAdapter {
  return { id, label: id, owns: value => value.identity.venue === id && value.identity.instance === 'test',
    status: async () => ({ id, label: id, connected: true, capabilities: { lookup: true, details: true, screening: false } }),
    lookup, resolve: async value => value };
}
function service(adapters: SearchAdapter[], timeout = 1000, remoteDelay = 0) {
  const result = createSearchService(adapters, async () => ({ takes: [], truncated: false }), timeout, remoteDelay); services.push(result); return result;
}
function query(sources: string[]): SearchInput { return { id: randomUUID(), query: 'btc', sources, archived: false }; }

test('market ranking puts exact names before partial names while preserving exact ticker priority', async () => {
  const rows = [
    { ...hit('rh', 'bch'), symbol: 'BCH-USD', name: 'Bitcoin Cash' },
    { ...hit('rh', 'btc'), symbol: 'BTC-USD', name: 'Bitcoin' },
    { ...hit('rh', 'fund'), symbol: 'ABTC', name: 'A Bitcoin Fund' },
  ];
  const s = service([adapter('rh', async () => ({ markets: rows, truncated: false }))]);
  for (const [text, expected] of [
    ['  BiTcOiN  ', ['BTC-USD', 'BCH-USD', 'ABTC']],
    ['bitcoin cash', ['BCH-USD', 'ABTC', 'BTC-USD']],
    ['BCH-USD', ['BCH-USD', 'ABTC', 'BTC-USD']],
    ['btc', ['BTC-USD', 'ABTC', 'BCH-USD']],
  ] as const) {
    const input = { ...query(['rh']), query: text }; s.start(input, 'owner');
    await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
    expect(s.snapshot(input.id, 'owner')!.sources[0].markets.map(m => m.symbol)).toEqual(expected);
  }
  rows.push({ ...hit('rh', 'exact'), symbol: 'BITCOIN', name: 'Different asset' });
  const input = { ...query(['rh']), query: 'bitcoin' }; s.start(input, 'owner');
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
  expect(s.snapshot(input.id, 'owner')!.sources[0].markets.map(m => m.symbol)).toEqual(['BITCOIN', 'BTC-USD', 'BCH-USD', 'ABTC']);
});

test('independent sources preserve type, pair, contract and venue identities while late results arrive', async () => {
  let release!: (value: { markets: MarketHit[]; truncated: boolean }) => void;
  const slow = new Promise<{ markets: MarketHit[]; truncated: boolean }>(resolve => { release = resolve; });
  const spot = hit('fast'); const pair = { ...spot, identity: { ...spot.identity, pair: 'BTC-EUR' } };
  const perp = hit('fast', 'btc', 'perpetual'); const contract = { ...perp, identity: { ...perp.identity, contract: 'December' } };
  const s = service([adapter('slow', () => slow), adapter('fast', async () => ({ markets: [spot, spot, pair, perp, contract], truncated: false }))]);
  const input = query(['slow', 'fast']); s.start(input, 'owner');
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.sources[1].state).toBe('complete'));
  const partial = s.snapshot(input.id, 'owner')!;
  expect(partial.done).toBe(false); expect(partial.sources[1].markets).toHaveLength(4);
  const before: SearchRow[] = partial.sources.flatMap(s => s.markets.map(hit => ({ kind: 'market', hit })));
  const active = searchRowKey(before[1]);
  release({ markets: [hit('slow')], truncated: false });
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
  const after: SearchRow[] = s.snapshot(input.id, 'owner')!.sources.flatMap(s => s.markets.map(hit => ({ kind: 'market', hit })));
  expect(after.find(row => searchRowKey(row) === active)).toEqual(before[1]);
  expect(after.findIndex(row => searchRowKey(row) === active)).toBe(2);
  expect(moveSearchSelection(after, active, 1)).toBe(searchRowKey(after[3]));
  expect(new Set(after.map(searchRowKey)).size).toBe(5);
});

test('a timed-out source and a provider error do not erase successful results or expose errors', async () => {
  const s = service([adapter('stuck', () => new Promise(() => {})), adapter('bad', async () => { throw new Error('synthetic-private-error'); }),
    adapter('good', async () => ({ markets: [hit('good')], truncated: false }))], 30);
  const input = query(['stuck', 'bad', 'good']); s.start(input, 'owner');
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
  const result = s.snapshot(input.id, 'owner')!;
  expect(result.sources.map(s => s.state)).toEqual(['failed', 'failed', 'complete']);
  expect(result.sources[2].markets).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('synthetic-private-error');
});

test('queries are client-scoped, cancellable, replaced, and fenced from late provider responses', async () => {
  let signal: AbortSignal | undefined; let release!: () => void;
  const s = service([adapter('slow', async (_, value) => { signal = value; await new Promise<void>(resolve => { release = resolve; }); return { markets: [hit('slow')], truncated: false }; })]);
  const first = query(['slow']); s.start(first, 'a');
  await vi.waitFor(() => expect(signal).toBeDefined());
  expect(s.snapshot(first.id, 'b')).toBeNull(); s.cancel(first.id, 'b');
  expect(signal?.aborted).toBe(false);
  const next = query([]); s.start(next, 'a');
  expect(signal?.aborted).toBe(true); release(); await delay(0);
  expect(s.snapshot(first.id, 'a')).toBeNull();
  expect(s.snapshot(next.id, 'a')?.sources).toEqual([]);
  expect(() => s.start(query(['unknown']), 'a')).toThrow('Unknown');
});

test('local results precede remote debounce and cancelled typing never calls lookup', async () => {
  const lookup = vi.fn(async () => ({ markets: [], truncated: false }));
  const s = service([adapter('a', lookup)], 500, 100);
  const input = query(['a']); s.start(input, 'owner');
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.localState).toBe('complete'));
  s.cancel(input.id, 'owner'); await delay(120);
  expect(lookup).not.toHaveBeenCalled();
});

test('disconnected and unsupported venues are explicit without calling their lookup', async () => {
  const lookup = vi.fn(async () => ({ markets: [], truncated: false }));
  const a = adapter('offline', lookup); a.status = async () => ({ id: a.id, label: a.label, connected: false, capabilities: { lookup: true, details: true, screening: false } });
  const b = adapter('unsupported', lookup); b.status = async () => ({ id: b.id, label: b.label, connected: true, capabilities: { lookup: false, details: false, screening: false } });
  const s = service([a, b]); const input = query([a.id, b.id]); s.start(input, 'owner');
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
  expect(s.snapshot(input.id, 'owner')?.sources.map(s => s.state)).toEqual(['disconnected', 'unsupported']);
  expect(lookup).not.toHaveBeenCalled();
});

test('Robinhood preserves references and fails closed for ambiguous or foreign detail destinations', async () => {
  const raw = { data: { results: [{ symbol: 'BTC', instrument_id: 'a', simple_name: 'Synthetic stock', type: 'stock' },
    { symbol: 'BTC', instrument_id: 'b', type: 'etf' }, { symbol: 'NOREF', name: 'Not an instrument' }] } };
  const hits = normalizeRobinhoodSearch(raw); expect(hits).toHaveLength(2);
  expect(hits.map(h => h.typeLabel)).toEqual(['Stock', 'ETF']); expect(marketKey(hits[0])).not.toBe(marketKey(hits[1]));
  const rh = robinhoodSearchAdapter({ status: async () => ({ status: 'connected', accounts: [], checkedAt: null }), readTool: async () => raw });
  expect(await rh.resolve(hits[0], new AbortController().signal)).toBeNull();
  raw.data.results.splice(1, 1);
  expect(await rh.resolve(hits[0], new AbortController().signal)).toEqual(hits[0]);
  const s = service([rh]); expect(await s.resolve(hit('other'))).toBeNull();
  const malicious = adapter('a', async () => ({ markets: [], truncated: false })); malicious.resolve = async () => hit('b');
  expect(await service([malicious]).resolve(hit('a'))).toBeNull();
});

test('search navigation waits for draft persistence and refuses navigation on failure', async () => {
  let saved = false;
  const unregister = registerSearchNavigationGuard(async () => { await delay(1); saved = true; });
  await prepareSearchNavigation(); expect(saved).toBe(true); unregister();
  const failure = registerSearchNavigationGuard(async () => { throw new Error('synthetic save failure'); });
  await expect(prepareSearchNavigation()).rejects.toThrow('save failure'); failure();
  await expect(prepareSearchNavigation()).resolves.toBeUndefined();
});

test('local search covers the database beyond loaded pages, matches strategy symbols, and treats wildcard text literally', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const owner = (await db.query<{ id: string }>('SELECT id FROM local_owners')).rows[0].id;
    for (let i = 0; i < 35; i++) await db.query("INSERT INTO takes(id,owner_id,title,selection) VALUES($1,$2,$3,'{}')", [randomUUID(), owner, i === 0 ? 'Needle 100%_literal' : `Other ${i}`]);
    const archived = randomUUID(); await db.query("INSERT INTO takes(id,owner_id,title,selection,archived_at) VALUES($1,$2,'Needle archived','{}',now())", [archived, owner]);
    const strategy = randomUUID(), version = randomUUID(), take = randomUUID();
    await db.query('INSERT INTO strategies(id,owner_id) VALUES($1,$2)', [strategy, owner]);
    await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) VALUES($1,$2,$3,1,1,$4,$5,'{}','{}')", [version, strategy, owner, JSON.stringify({ title: 'Dividend strategy' }), JSON.stringify({ target: { weights: [{ instrument: { symbol: 'VTI' } }] } })]);
    await db.query("UPDATE strategies SET current_version_id=$2,status='committed' WHERE id=$1", [strategy, version]);
    await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) VALUES($1,$2,'My basket','{}',$3)", [take, owner, strategy]);
    const search = createLocalSearch({ use: work => work(db) });
    expect((await search('100%_', false)).takes.map(t => t.title)).toEqual(['Needle 100%_literal']);
    expect((await search('Needle', true)).takes.map(t => t.id)).toEqual([archived]);
    expect((await search('Other', false)).takes).toHaveLength(20); expect((await search('Other', false)).truncated).toBe(true);
    expect((await search('VTI', false)).takes[0]).toMatchObject({ id: take, strategyId: strategy, strategyTitle: 'Dividend strategy' });
    expect((await search('Dividend', false)).takes[0].id).toBe(take);
  } finally { await db.close(); }
});

test('partial matches stay visible after quote enrichment without exposing provider failures', async () => {
  for (const enrich of [false, true]) {
    const a = adapter('partial', async () => ({ markets: [hit('partial')], truncated: false, incomplete: true }));
    if (enrich) a.enrich = async () => { throw new Error('private provider details'); };
    const s = service([a]), input = query(['partial']);
    s.start(input, 'owner');
    await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
    expect(s.snapshot(input.id, 'owner')?.sources[0]).toMatchObject({ state: 'partial', markets: [hit('partial')], message: 'Some results are unavailable. Try again.' });
  }
});


test('search retains more than twenty source matches for shared pagination', async () => {
  const markets = Array.from({ length: 45 }, (_, i) => ({ ...hit('coinbase', String(i)), symbol: `BTC${i}-USD` }));
  const s = service([adapter('coinbase', async () => ({ markets, truncated: false }))]);
  const input = query(['coinbase']); s.start(input, 'owner');
  await vi.waitFor(() => expect(s.snapshot(input.id, 'owner')?.done).toBe(true));
  expect(s.snapshot(input.id, 'owner')!.sources[0].markets).toHaveLength(45);
  expect(s.snapshot(input.id, 'owner')!.sources[0].truncated).toBe(false);
});
