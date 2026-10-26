import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../src/main/migrations';
import { createSourceRepository } from '../../../src/main/data-sources/repository';
import { createObservationStorage } from '../../../src/main/data-sources/storage';
import { sourceConfigSchema } from '../../../src/main/data-sources/config';
import { websocketSourceConfig } from '../../../src/main/data-sources/websocket/adapter';
import { applyDestination } from '../../../src/main/data-sources/destinations';
import type { DataObservation } from '../../../src/shared/data-sources';

const identity = { venue: 'robinhood', instance: 'production', kind: 'equity', reference: 'AAPL' };
const priceConfig = () => sourceConfigSchema.parse({ name: 'Fixture price', endpoint: 'https://fixture.example/value', collection: 'when-open', feeds: [{ id: 'price', name: 'Price', unit: 'USD', mapping: { kind: 'metric', valuePath: ['price'] }, eventTimePath: ['time'], storage: { mode: 'latest', fields: ['value'] }, destination: { kind: 'market-price', market: identity, currency: 'USD', policy: 'replace-stale', maxAgeMs: 60000, allowSharedPriceWrites: true } }] });
const metadataConfig = (namespace = 'sentiment') => sourceConfigSchema.parse({ name: 'Fixture metadata', endpoint: 'https://fixture.example/value', feeds: [{ id: 'metadata', name: 'Sentiment', unit: 'record', mapping: { kind: 'event', fields: { score: { path: ['score'], type: 'number' }, extra: { path: ['extra'], type: 'string' } } }, storage: { mode: 'latest', fields: ['score'] }, destination: { kind: 'market-metadata', market: identity, namespace, maxAgeMs: 60000 } }] });
const observed = (id: string, now: number, extra: Partial<DataObservation> = {}): DataObservation => ({ sourceId: id, configVersion: 1, schemaVersion: 1, feedId: 'price', adapterId: 'custom-http', adapterVersion: '1', epoch: 1, unit: 'USD', eventTime: now, receivedAt: now, timeBasis: 'provider', clockSkewMs: 0, origin: 'live', payload: { kind: 'metric', value: '201.25' }, ...extra });

test('price destinations require explicit authority, compatible semantics and retained writes', () => {
  const valid = priceConfig(); expect(valid.feeds[0].destination?.kind).toBe('market-price');
  for (const change of [ { unit: 'EUR' }, { eventTimePath: undefined }, { storage: { mode: 'live', fields: ['value'] } }, { destination: { ...valid.feeds[0].destination, allowSharedPriceWrites: false } }, { destination: { ...valid.feeds[0].destination, market: { ...identity, venue: 'coinbase' } } } ]) expect(() => sourceConfigSchema.parse({ ...valid, feeds: [{ ...valid.feeds[0], ...change }] })).toThrow();
  expect(() => sourceConfigSchema.parse({ ...valid, feeds: [valid.feeds[0], { ...valid.feeds[0], id: 'other' }] })).toThrow('only one');
});

for (const transport of ['http','websocket'] as const)test(`price writes preserve fresh broker quotes, preview without mutation, reject stale data and fence disabled sources (${transport})`, async () => {
  const db = new PGlite(); let now = Date.parse('2026-10-16T12:00:00Z');
  const database = { use: <T>(work: (db: PGlite) => Promise<T>) => work(db) };
  const storage = createObservationStorage(database, { automatic: false, now: () => now });
  try {
    await migrate(db); const owner = (await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
    const repo = createSourceRepository(database), httpConfig = priceConfig();
    const config = transport === 'http' ? httpConfig : websocketSourceConfig.parse({
      name:httpConfig.name,transport:'websocket',collection:httpConfig.collection,feeds:httpConfig.feeds,
      connection:{endpoint:'wss://fixture.example/prices',auth:{mode:'none'},subscription:{body:{market:'AAPL'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},
    });
    const source = await repo.save(owner, config), adapterId=transport==='http'?'custom-http':'custom-websocket';
    await repo.validate(owner, source.id, 1); await repo.enable(owner, source.id, 1, true);
    await db.query('INSERT INTO market_quotes(symbol,price,previous_close,extended_price,last_trade_at,observed_at) VALUES($1,200,198,202,$2,$2)', ['AAPL', new Date(now - 1000).toISOString()]);
    const write = async (extra: Partial<DataObservation> = {}) => { expect(storage.enqueue(owner, observed(source.id, now, {adapterId,...extra}))).toBe(true); await storage.flush(); };
    storage.enqueue(owner, observed(source.id, now, {adapterId:transport==='http'?'custom-websocket':'custom-http'}));
    await storage.flush();
    expect((await db.query('SELECT * FROM data_source_latest')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM data_source_destination_status')).rows).toHaveLength(0);
    await write(); expect((await db.query<{price:string}>('SELECT price::text FROM market_quotes')).rows[0].price).toBe('200.000000000000000000');
    expect((await db.query('SELECT outcome FROM data_source_destination_status')).rows[0].outcome).toBe('preserved');
    now += 61000;
    const preview = await db.transaction(tx => applyDestination(tx, owner, config.feeds[0], observed(source.id, now, {adapterId}), now, true));
    expect(preview?.outcome).toBe('would-write'); expect((await db.query('SELECT price_provider FROM market_quotes')).rows[0].price_provider).toBe('robinhood');
    await write();
    expect((await db.query('SELECT price_provider,price_source_id,previous_close::text,extended_price::text FROM market_quotes')).rows[0]).toEqual({price_provider:adapterId,price_source_id:source.id,previous_close:'198.000000000000000000',extended_price:'202.000000000000000000'});
    expect((await db.query('SELECT outcome FROM data_source_destination_status')).rows[0].outcome).toBe('written');
    expect((await db.transaction(tx => applyDestination(tx, owner, config.feeds[0], observed(source.id, now, { eventTime: now-120000 }), now, true)))?.outcome).toBe('stale');
    expect((await db.transaction(tx => applyDestination(tx, owner, config.feeds[0], observed(source.id, now, { payload: {kind:'metric',value:'0'} }), now, true)))?.outcome).toBe('invalid');
    now += 15000; storage.enqueue(owner, observed(source.id, now, { adapterId, payload: {kind:'metric',value:'999'} })); await repo.enable(owner, source.id, 1, false); await storage.flush();
    expect((await db.query<{price:string}>('SELECT price::text FROM market_quotes')).rows[0].price).toBe('201.250000000000000000');
    const missing = { ...config.feeds[0], destination: { ...config.feeds[0].destination!, market: {...identity, reference:'MISSING'} } } as typeof config.feeds[0];
    expect((await db.transaction(tx => applyDestination(tx, owner, missing, observed(source.id, now, {adapterId}), now, true)))?.outcome).toBe('missing-market');
  } finally { await storage.close(); await db.close(); }
});

test('metadata updates are selected-field-only, namespaced and preserve null/missing data without source collisions', async () => {
  const db = new PGlite(); let now = Date.parse('2026-10-16T12:00:00Z');
  const database = { use: <T>(work: (db: PGlite) => Promise<T>) => work(db) };
  const storage = createObservationStorage(database, { automatic: false, now: () => now });
  try {
    await migrate(db); const owner = (await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
    const repo = createSourceRepository(database), config = metadataConfig(), source = await repo.save(owner, config);
    await repo.validate(owner, source.id, 1); await repo.enable(owner, source.id, 1, true);
    const observation = observed(source.id, now, { feedId:'metadata',unit:'record',payload:{kind:'event',fields:{score:62,extra:'not selected'}} });
    expect(storage.enqueue(owner, observation)).toBe(true); await storage.flush();
    expect((await db.query('SELECT fields FROM market_source_metadata')).rows).toEqual([{fields:{score:62}}]);
    const other = await repo.save(owner, config);
    expect((await db.transaction(tx => applyDestination(tx, owner, config.feeds[0], {...observation,sourceId:other.id}, now+1000, true)))?.outcome).toBe('namespace-conflict');
    const nullConfig = sourceConfigSchema.parse({...config,feeds:[{...config.feeds[0],mapping:{kind:'event',fields:{score:{path:['score'],type:'null'}}}}]});
    now += 15000;
    await db.transaction(tx => applyDestination(tx, owner, nullConfig.feeds[0], {...observation,eventTime:now,receivedAt:now,payload:{kind:'event',fields:{score:null}}}, now));
    expect((await db.query('SELECT fields FROM market_source_metadata')).rows).toEqual([{fields:{score:62}}]);
    await db.transaction(tx => applyDestination(tx, owner, metadataConfig('other').feeds[0], {...observation,eventTime:now,receivedAt:now}, now));
    expect((await db.query('SELECT namespace FROM market_source_metadata ORDER BY namespace')).rows).toEqual([{namespace:'other'},{namespace:'sentiment'}]);
  } finally { await storage.close(); await db.close(); }
});
