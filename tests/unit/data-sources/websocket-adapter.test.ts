import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDataSourceRuntime } from '../../../src/main/data-sources/runtime';
import { createWebsocketAdapter, websocketFeedDefinitions, websocketSourceConfig, type WebsocketSource } from '../../../src/main/data-sources/websocket/adapter';
import type { createSourceWebsocketTransport } from '../../../src/main/data-sources/websocket/transport';
type Transport = ReturnType<typeof createSourceWebsocketTransport>;
const runtimes: ReturnType<typeof createDataSourceRuntime>[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T12:00:00Z')); });
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
const ui = { mode: 'latest', demand: 'ui' } as const;
const flush = () => vi.advanceTimersByTimeAsync(0);
function fixture() {
  const source: WebsocketSource = { id: 'source', ownerId: 'owner', revision: 1, enabled: true, validated: true, config: websocketSourceConfig.parse({
    transport: 'websocket', name: 'Fixture', collection: 'when-open', freshnessMs: 15000,
    connection: { endpoint: 'wss://fixture.example.test', auth: { mode: 'none' }, subscription: { body: { op: 'subscribe' } }, acknowledgement: { success: { path: ['op'], equals: 'ok' }, failure: { path: ['op'], equals: 'error' } } },
    feeds: ['price', 'volume'].map(id => ({ id, name: id, unit: 'score', mapping: { kind: 'metric', valuePath: [id] }, storage: { mode: 'live', fields: ['value'] } })),
  }) };
  const sockets: Array<{ callbacks: Parameters<Transport['connect']>[3]; close: ReturnType<typeof vi.fn>; signal: AbortSignal }> = [];
  const transport: Transport = { connect(_key, _config, signal, callbacks) { const socket = { callbacks, close: vi.fn(), signal }; sockets.push(socket); return socket; } };
  const resolve = vi.fn(async () => source);
  const observed = vi.fn(() => true);
  const runtime = createDataSourceRuntime([createWebsocketAdapter(transport, resolve)], { clock: { wall: Date.now, monotonic: Date.now }, random: () => 0.5, onObservation: observed });
  runtimes.push(runtime);
  const definitions = websocketFeedDefinitions(source);
  return { source, sockets, runtime, definitions, observed, resolve };
}
test('two feeds and repeated consumers share one subscription and receive normalized observations', async () => {
  const f = fixture(); const price = f.runtime.acquire(f.definitions[0], ui), volume = f.runtime.acquire(f.definitions[1], ui), second = f.runtime.acquire(f.definitions[0], ui);
  await flush(); expect(f.sockets).toHaveLength(1);
  f.sockets[0].callbacks.ready(); f.sockets[0].callbacks.data({ price: 12.5, volume: '30' });
  expect(price.read()).toMatchObject({ connection: 'live', quality: 'fresh', latest: { payload: { kind: 'metric', value: '12.5' }, adapterId: 'custom-websocket' } });
  expect(volume.read().latest?.payload).toEqual({ kind: 'metric', value: '30' });
  expect(second.read().latest?.payload).toEqual(price.read().latest?.payload);
  expect(f.observed).toHaveBeenCalledTimes(2);
  price.release(); second.release(); await vi.advanceTimersByTimeAsync(5100); expect(f.sockets[0].close).not.toHaveBeenCalled();
  volume.release(); await vi.advanceTimersByTimeAsync(5100); expect(f.sockets[0].close).toHaveBeenCalledOnce();
});
test('transport failure retries with a fresh shared connection and fences old callbacks', async () => {
  const f = fixture(); const a = f.runtime.acquire(f.definitions[0], ui); f.runtime.acquire(f.definitions[1], ui); await flush();
  f.sockets[0].callbacks.ready(); f.sockets[0].callbacks.data({ price: '1', volume: '2' });
  f.sockets[0].callbacks.failed('transport'); expect(a.read().connection).toBe('retrying');
  await vi.advanceTimersByTimeAsync(1100); expect(f.sockets).toHaveLength(2);
  f.sockets[0].callbacks.data({ price: '999', volume: '999' }); expect(a.read().latest?.payload).not.toEqual({ kind: 'metric', value: '999' });
  f.sockets[1].callbacks.ready(); f.sockets[1].callbacks.data({ price: '3', volume: '4' }); expect(a.read().latest?.payload).toEqual({ kind: 'metric', value: '3' });
  expect(f.resolve).toHaveBeenCalledTimes(4);
});
test('heartbeats keep the connection alive without refreshing observations', async () => {
  const f = fixture(); const a = f.runtime.acquire(f.definitions[0], ui); await flush();
  f.sockets[0].callbacks.ready(); f.sockets[0].callbacks.data({ price: '1' });
  for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(14000); f.sockets[0].callbacks.heartbeat?.(); }
  expect(a.read()).toMatchObject({ connection: 'live', quality: 'stale' }); expect(f.observed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(46000); expect(f.sockets[0].signal.aborted).toBe(true);
});
test('malformed matched data fails every feed without a partial message, then backs off and retries', async () => {
  const f = fixture(); const a = f.runtime.acquire(f.definitions[0], ui); f.runtime.acquire(f.definitions[1], ui); await flush();
  f.sockets[0].callbacks.ready(); f.sockets[0].callbacks.data({ price: '1', volume: false });
  expect(f.observed).not.toHaveBeenCalled(); expect(f.sockets[0].signal.aborted).toBe(true);
  expect(a.read()).toMatchObject({ connection: 'retrying', issue: 'invalid_data' });
  await vi.advanceTimersByTimeAsync(1100); expect(f.sockets).toHaveLength(2);
  f.sockets[1].callbacks.ready(); f.sockets[1].callbacks.data({ price: '2', volume: '3' }); expect(a.read()).toMatchObject({ connection: 'live', quality: 'fresh' });
});
test('unmatched frames (heartbeats, acks) are ignored and counted; partial matches emit only matching feeds', async () => {
  const transport: Transport = { connect(_key, _config, signal, callbacks) { sockets.push({ callbacks, close: vi.fn(), signal }); return { close: vi.fn() }; } };
  const sockets: Array<{ callbacks: Parameters<Transport['connect']>[3]; close: ReturnType<typeof vi.fn>; signal: AbortSignal }> = [];
  const f = fixture(), adapter = createWebsocketAdapter(transport, async () => f.source);
  const runtime = createDataSourceRuntime([adapter], { clock: { wall: Date.now, monotonic: Date.now }, random: () => 0.5 }); runtimes.push(runtime);
  const price = runtime.acquire(f.definitions[0], ui), volume = runtime.acquire(f.definitions[1], ui); await flush();
  sockets[0].callbacks.ready();
  sockets[0].callbacks.data({ type: 'heartbeat' }); sockets[0].callbacks.data({ op: 'ok' });
  expect(sockets[0].signal.aborted).toBe(false); expect(price.read().issue).toBeNull();
  sockets[0].callbacks.data({ price: '5' });
  expect(price.read()).toMatchObject({ connection: 'live', quality: 'fresh', latest: { payload: { value: '5' } } });
  expect(volume.read()).toMatchObject({ connection: 'live', latest: null, issue: null });
});
test('resolve errors back off and retry; disabled sources are configuration and block', async () => {
  const f = fixture(); f.resolve.mockRejectedValueOnce(Error('synthetic database outage'));
  const a = f.runtime.acquire(f.definitions[0], ui); await flush();
  expect(a.read()).toMatchObject({ connection: 'retrying', issue: 'transport' }); expect(f.sockets).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1100); expect(f.sockets).toHaveLength(1);
  f.sockets[0].callbacks.failed('authentication'); expect(a.read().connection).toBe('blocked');
  await vi.advanceTimersByTimeAsync(600_000); expect(f.sockets).toHaveLength(1);
});
test('suspend closes the socket and stale source revisions cannot reconnect', async () => {
  const f = fixture(); f.runtime.acquire(f.definitions[0], ui); await flush(); f.runtime.suspend();
  expect(f.sockets[0].signal.aborted).toBe(true);
  f.source.revision = 2; f.runtime.resume(); await flush(); expect(f.sockets).toHaveLength(1);
});
test('invalid destination and storage policies remain rejected for WS sources', () => {
  const f = fixture();
  expect(() => websocketSourceConfig.parse({ ...f.source.config, feeds: [{ ...f.source.config.feeds[0], storage: { mode: 'latest', fields: ['unknown'] } }] })).toThrow();
});

test('WSS price destinations require retained USD timestamped metrics and explicit authority',()=>{
 const f=fixture(),base=f.source.config;
 const destination={kind:'market-price',market:{venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'},currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true};
 const feed={...base.feeds[0],unit:'USD',eventTimePath:['time'],storage:{mode:'latest',fields:['value']},destination};
 expect(websocketSourceConfig.parse({...base,feeds:[feed]}).feeds[0].destination?.kind).toBe('market-price');
 for(const change of [{unit:'EUR'},{eventTimePath:undefined},{storage:{mode:'live',fields:['value']}},{destination:{...destination,allowSharedPriceWrites:false}}]){
  expect(()=>websocketSourceConfig.parse({...base,feeds:[{...feed,...change}]})).toThrow();
 }
});

test('a feed whose mapping matches none of 20 frames reports a non-blocking issue until a frame matches', async () => {
  const sockets: Array<{ callbacks: Parameters<Transport['connect']>[3] }> = [];
  const transport: Transport = { connect(_key, _config, _signal, callbacks) { sockets.push({ callbacks }); return { close: vi.fn() }; } };
  const f = fixture(), status = vi.fn();
  const runtime = createDataSourceRuntime([createWebsocketAdapter(transport, async () => f.source, { message: vi.fn(), status })], { clock: { wall: Date.now, monotonic: Date.now }, random: () => 0.5 }); runtimes.push(runtime);
  const price = runtime.acquire(f.definitions[0], ui), volume = runtime.acquire(f.definitions[1], ui); await flush();
  sockets[0].callbacks.ready();
  for (let i = 0; i < 19; i++) sockets[0].callbacks.data({ price: String(i) });
  expect(volume.read()).toMatchObject({ connection: 'live', issue: null });
  sockets[0].callbacks.data({ price: '20' });
  expect(volume.read()).toMatchObject({ connection: 'live', quality: 'missing', issue: 'invalid_data' });
  expect(price.read()).toMatchObject({ connection: 'live', quality: 'fresh', issue: null });
  expect(status).toHaveBeenCalledWith(f.source, 'notice', 'volume · no match in 20 messages · check its mapped path'); expect(status).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 30; i++) sockets[0].callbacks.data({ price: '1' });
  expect(status).toHaveBeenCalledTimes(2);
  sockets[0].callbacks.data({ volume: '9' });
  expect(volume.read()).toMatchObject({ connection: 'live', quality: 'fresh', issue: null, latest: { payload: { value: '9' } } });
});
test('host-reported feed issues (quarantined storage) surface on snapshots without overriding runtime issues', async () => {
  const sockets: Array<{ callbacks: Parameters<Transport['connect']>[3] }> = [];
  const transport: Transport = { connect(_key, _config, _signal, callbacks) { sockets.push({ callbacks }); return { close: vi.fn() }; } };
  const f = fixture(); let quarantined = false;
  const runtime = createDataSourceRuntime([createWebsocketAdapter(transport, async () => f.source)], { clock: { wall: Date.now, monotonic: Date.now }, random: () => 0.5, issue: feed => quarantined && feed.feedId === 'price' ? 'invalid_data' : null }); runtimes.push(runtime);
  const price = runtime.acquire(f.definitions[0], ui), volume = runtime.acquire(f.definitions[1], ui); await flush();
  sockets[0].callbacks.ready(); sockets[0].callbacks.data({ price: '1', volume: '2' });
  expect(price.read().issue).toBeNull(); quarantined = true;
  expect(price.read()).toMatchObject({ connection: 'live', quality: 'fresh', issue: 'invalid_data' }); expect(volume.read().issue).toBeNull();
  sockets[0].callbacks.failed('transport'); expect(price.read()).toMatchObject({ connection: 'retrying', issue: 'transport' });
});
