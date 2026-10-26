import { expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../src/main/migrations';
import { createCustomDataSources } from '../../../src/main/data-sources/service';
import type { StoredSource } from '../../../src/main/data-sources/config';
import type { DataFeedInfo, DataLease } from '../../../src/shared/data-sources';

const clientId = '11111111-1111-4111-8111-111111111111';
const config = { name: 'Fixture', endpoint: 'https://fixture.example/value', collection: 'when-open', feeds: [
  { id: 'value', name: 'Value', unit: 'points', mapping: { kind: 'metric', valuePath: ['value'] }, storage: { mode: 'latest', fields: ['value'] } },
] };
const secrets = { available: () => false, get: async () => { throw Error('No real secrets'); }, set: async () => { throw Error(); }, has: async () => false, delete: async () => { throw Error(); } };

test('host lifecycle saves, previews without writes, enables leased collection, drains writes and disables on revision', async () => {
  const db = new PGlite(); await migrate(db);
  const read = vi.fn(async () => ({ value: '1.5', private: 'do-not-retain' }));
  const service = createCustomDataSources({ use: work => work(db) }, secrets, { read });
  const configure = (input: unknown) => service.dispatch('dataSources:configure', [input], clientId);
  try {
    const source = await configure({ action: 'save', config }) as StoredSource;
    expect(source).toMatchObject({ enabled: false, validated: false });
    await expect(configure({ action: 'enable', id: source.id, revision: 1, enabled: true })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await configure({ action: 'preview', id: source.id, revision: 1 });
    expect(read).toHaveBeenCalledOnce();
    expect((await db.query('SELECT * FROM data_source_latest')).rows).toHaveLength(0);
    await configure({ action: 'enable', id: source.id, revision: 1, enabled: true });
    const [feed] = await service.dispatch('dataSources:list', [], clientId) as DataFeedInfo[];
    const ref = { sourceId: feed.sourceId, feedId: feed.feedId, configVersion: feed.configVersion, schemaVersion: feed.schemaVersion };
    const lease = await service.dispatch('dataSources:acquire', [ref], clientId) as DataLease;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      const rows = (await db.query('SELECT data FROM data_source_latest')).rows;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('do-not-retain');
    }, { timeout: 3000 });
    service.suspend();
    await expect(service.dispatch('dataSources:acquire', [ref], clientId)).rejects.toThrow('suspended');
    service.resume();
    expect(await service.dispatch('dataSources:renew', [[lease.leaseId]], clientId)).toEqual([]);
    const edited = await configure({ action: 'save', config, existing: { id: source.id, revision: 1 } }) as StoredSource;
    expect(edited).toMatchObject({ revision: 2, enabled: false, validated: false });
    expect(await service.dispatch('dataSources:list', [], clientId)).toEqual([]);
    await expect(configure({ action: 'preview', id: source.id, revision: 1 })).rejects.toThrow('changed');
  } finally { await service.close(); await db.close(); }
});

test('preview failure does not validate; suspension cancels preview; closed host rejects new work', async () => {
  const db = new PGlite(); await migrate(db);
  const read = vi.fn(async (_key: string, _endpoint: string, _signal: AbortSignal): Promise<unknown> => ({ unexpected: true }));
  const service = createCustomDataSources({ use: work => work(db) }, secrets, { read });
  const configure = (input: unknown) => service.dispatch('dataSources:configure', [input], clientId);
  try {
    const source = await configure({ action: 'save', config }) as StoredSource;
    await expect(configure({ action: 'preview', id: source.id, revision: 1 })).rejects.toThrow('preview failed');
    expect((await configure({ action: 'list' }) as StoredSource[])[0].validated).toBe(false);
    service.suspend();
    await expect(configure({ action: 'preview', id: source.id, revision: 1 })).rejects.toThrow('suspended');
    service.resume();
    read.mockImplementationOnce(async (_key, _endpoint, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('Cancelled fixture')), { once: true });
    }));
    const pending = configure({ action: 'preview', id: source.id, revision: 1 });
    const rejected = expect(pending).rejects.toThrow('preview failed');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    service.suspend();
    await rejected;
    await service.close();
    await expect(configure({ action: 'list' })).rejects.toThrow();
  } finally { await service.close(); await db.close(); }
});

test('inspection needs no saved mapping, returns bounded fields and never saves or enables a source', async () => {
  const db = new PGlite(); await migrate(db);
  const read = vi.fn(async () => ({ quote: { price: 12.5 }, token: 'fixture-secret' }));
  const service = createCustomDataSources({ use: work => work(db) }, secrets, { read });
  try {
    const result = await service.dispatch('dataSources:configure', [{ action: 'inspect', endpoint: config.endpoint }], clientId);
    expect(result).toEqual({ inferredFrom: 'single-response', truncated: false, fields: [{ path: ['quote', 'price'], type: 'number', sample: 12.5, selectable: true }] });
    expect(read).toHaveBeenCalledOnce();
    for (const table of ['data_sources', 'data_source_latest', 'data_source_history']) expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    await expect(service.dispatch('dataSources:configure', [{ action: 'inspect', endpoint: config.endpoint, credentialId: clientId }], clientId)).rejects.toThrow('Could not inspect source');
    expect(read).toHaveBeenCalledOnce();
    service.suspend();
    await expect(service.dispatch('dataSources:configure', [{ action: 'inspect', endpoint: config.endpoint }], clientId)).rejects.toThrow('suspended');
    expect(read).toHaveBeenCalledOnce();
  } finally { await service.close(); await db.close(); }
});

test('destination preview reports before/after without writing to shared prices', async () => {
  const db = new PGlite(); await migrate(db);
  const now = Date.now();
  await db.query("INSERT INTO market_quotes(symbol,price,last_trade_at,observed_at) VALUES('AAPL',200,$1,$1)", [new Date(now-120000).toISOString()]);
  const service = createCustomDataSources({ use: work => work(db) }, secrets, { read: async () => ({ value: '201.25', time: Date.now() }) });
  try {
    const source = await service.dispatch('dataSources:configure', [{ action: 'save', config: { ...config, feeds: [{ ...config.feeds[0], unit: 'USD', eventTimePath: ['time'], destination: {
      kind: 'market-price', market: {venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'}, currency:'USD', policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true,
    } }] } }], clientId) as StoredSource;
    const result = await service.dispatch('dataSources:configure', [{ action: 'preview', id: source.id, revision: 1 }], clientId) as { destinations: unknown[] };
    expect(result.destinations).toMatchObject([{feedId:'value',target:'market_quotes:AAPL',outcome:'would-write',current:{price:'200.000000000000000000',provider:'robinhood'},proposed:{price:'201.25',currency:'USD',provider:'custom-http'}}]);
    expect((await db.query('SELECT price_provider FROM market_quotes')).rows[0].price_provider).toBe('robinhood');
    expect((await db.query('SELECT * FROM data_source_destination_status')).rows).toHaveLength(0);
    expect((await db.query('SELECT enabled,validated FROM data_sources')).rows[0]).toEqual({enabled:false,validated:true});
  } finally { await service.close(); await db.close(); }
});

test('failed saves keep the host running; editing one source keeps other sources leased', async () => {
  const db = new PGlite(); await migrate(db);
  const read = vi.fn(async () => ({ value: '2' }));
  const service = createCustomDataSources({ use: work => work(db) }, secrets, { read });
  const configure = (input: unknown) => service.dispatch('dataSources:configure', [input], clientId);
  try {
    const sources: StoredSource[] = [];
    for (const name of ['Fixture A', 'Fixture B']) {
      const source = await configure({ action: 'save', config: { ...config, name } }) as StoredSource;
      await configure({ action: 'preview', id: source.id, revision: 1 });
      await configure({ action: 'enable', id: source.id, revision: 1, enabled: true }); sources.push(source);
    }
    const feeds = await service.dispatch('dataSources:list', [], clientId) as DataFeedInfo[];
    const leaseFor = async (id: string) => { const feed = feeds.find(item => item.sourceId === id)!; return await service.dispatch('dataSources:acquire', [{ sourceId: feed.sourceId, feedId: feed.feedId, configVersion: feed.configVersion, schemaVersion: feed.schemaVersion }], clientId) as DataLease; };
    const a = await leaseFor(sources[0].id), b = await leaseFor(sources[1].id);
    const renew = (lease: DataLease) => service.dispatch('dataSources:renew', [[lease.leaseId]], clientId) as Promise<DataLease[]>;
    // A rejected save (stale revision) leaves the previous configuration collecting.
    await expect(configure({ action: 'save', config: { ...config, name: 'Stale' }, existing: { id: sources[0].id, revision: 9 } })).rejects.toThrow();
    expect(await renew(a)).toHaveLength(1); expect(await renew(b)).toHaveLength(1);
    // Editing A replaces only A's feeds; B's lease and collection continue.
    await configure({ action: 'save', config: { ...config, name: 'Fixture A2' }, existing: { id: sources[0].id, revision: 1 } });
    expect(await renew(a)).toEqual([]); expect(await renew(b)).toHaveLength(1);
    expect((await service.dispatch('dataSources:list', [], clientId) as DataFeedInfo[]).map(feed => feed.sourceId)).toEqual([sources[1].id]);
    // Disabling B stops only its own leases.
    await configure({ action: 'enable', id: sources[1].id, revision: 1, enabled: false });
    expect(await renew(b)).toEqual([]);
  } finally { await service.close(); await db.close(); }
});
