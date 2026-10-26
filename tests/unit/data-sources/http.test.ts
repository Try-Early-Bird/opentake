import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { expect, test, vi } from 'vitest';
import { createSourceHttpClient, publicAddress, retryAfter, SourceHttpError } from '../../../src/main/data-sources/http';
import { mapHttpSample, createHttpAdapter, httpFeedDefinitions, exactDecimal } from '../../../src/main/data-sources/http-adapter';
import { sourceConfigSchema, type StoredSource } from '../../../src/main/data-sources/config';
import { createDataSourceRuntime } from '../../../src/main/data-sources/runtime';

function fixture(status = 200, body = '{"value":"1.25"}', headers: Record<string,string> = {'content-type':'application/json'}) {
  let captured: Record<string, unknown> = {};
  const request = vi.fn((_url, options, callback) => {
    captured = options;
    const req = new EventEmitter() as EventEmitter & {end():void;destroy():void}; req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{ const res = new EventEmitter() as EventEmitter & {statusCode:number;headers:unknown;destroy():void};
      res.statusCode=status;res.headers=headers;res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(body));res.emit('end'); });
    return req;
  });
  const resolve = vi.fn(async()=>[{address:'8.8.8.8',family:4}]);
  return { request, resolve, captured:()=>captured, client:createSourceHttpClient({resolve,request:request as unknown as typeof httpsRequest,now:()=>0}) };
}
test('destination policy denies private/reserved/mapped addresses and pins public DNS with TLS verification', async () => {
  for(const address of ['127.0.0.1','10.1.2.3','100.64.0.1','192.168.1.1','169.254.169.254','192.0.2.1','198.19.1.1','224.0.0.1','255.255.255.255','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:0808:0808::1','3fff::1']) expect(publicAddress(address),address).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true);expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  const f=fixture(), signal=new AbortController().signal;
  expect(await f.client.read('a','https://fixture.example/metric',signal)).toEqual({value:'1.25'});
  expect(f.captured()).toMatchObject({agent:false,servername:'fixture.example',rejectUnauthorized:true,method:'GET',headers:{Accept:'application/json','Accept-Encoding':'identity'}});
  const lookup=f.captured().lookup as (host:string,options:unknown,callback:(error:unknown,address:string,family:number)=>void)=>void;
  const callback=vi.fn();lookup('fixture.example',{},callback);expect(callback).toHaveBeenCalledWith(null,'8.8.8.8',4);
  f.resolve.mockResolvedValueOnce([{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);
  await expect(f.client.read('a','https://fixture.example/metric',signal)).rejects.toMatchObject({code:'destination'});
  expect(f.request).toHaveBeenCalledTimes(1);expect(f.resolve).toHaveBeenCalledTimes(2);
  for(const endpoint of ['http://fixture.example/','https://fixture.example:444/','https://user:secret@fixture.example/','https://fixture.example/?key=secret','https://127.0.0.1/']) await expect(f.client.read('a',endpoint,signal)).rejects.toMatchObject({code:'destination'});
});
test('HTTP rejects redirects, auth failures, compressed/oversized/invalid bodies and honors Retry-After',async()=>{
  const signal=new AbortController().signal;
  for(const [status,body,headers,code] of [
    [302,'',{'location':'https://other.example/'},'response'],[401,'provider-secret',{},'authentication'],
    [200,'{}',{'content-type':'application/json','content-encoding':'gzip'},'response'],
    [200,'x'.repeat(1024*1024+1),{'content-type':'application/json'},'response'],
    [200,'invalid',{'content-type':'application/json'},'response'],
    [429,'',{'retry-after':'120'},'rate_limited'],
  ] as const){ const f=fixture(status,body,headers);await expect(f.client.read('a','https://fixture.example/',signal)).rejects.toMatchObject({code});expect(f.request).toHaveBeenCalledTimes(1); }
  expect(retryAfter('120',0)).toBe(120000);expect(retryAfter('Thu, 01 Jan 1970 00:02:00 GMT',0)).toBe(120000);
  const f=fixture(429,'',{'retry-after':'120'});await expect(f.client.read('a','https://fixture.example/',signal)).rejects.toMatchObject({retryAfterMs:120000});
});
test('one shared client bounds previews and collection and rejects cancelled DNS before connecting',async()=>{
  const f=fixture();let finish!: (value:{address:string;family:number}[])=>void;
  f.resolve.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const controller=new AbortController();const read=f.client.read('a','https://fixture.example/',controller.signal);
  await expect(f.client.read('a','https://fixture.example/',controller.signal)).rejects.toMatchObject({code:'capacity'});
  controller.abort();await expect(read).rejects.toMatchObject({code:'cancelled'});
  finish([{address:'8.8.8.8',family:4}]);await Promise.resolve();expect(f.request).not.toHaveBeenCalled();
});
test('global HTTP admission is shared across four independent sources', async()=>{
  const f=fixture();f.resolve.mockImplementation(()=>new Promise(()=>{}));
  const controller=new AbortController();
  const reads=['a','b','c','d'].map(id=>f.client.read(id,'https://fixture.example/',controller.signal).catch(error=>error));
  await expect(f.client.read('e','https://fixture.example/',controller.signal)).rejects.toMatchObject({code:'capacity'});
  controller.abort();expect((await Promise.all(reads)).every(error=>error.code==='cancelled')).toBe(true);
  expect(f.request).not.toHaveBeenCalled();
});
const config=sourceConfigSchema.parse({name:'Synthetic',endpoint:'https://fixture.example/',collection:'automatic',pollIntervalMs:15000,feeds:[{id:'value',name:'Value',unit:'points',mapping:{kind:'metric',valuePath:['value']},storage:{mode:'history',fields:['value'],sampleEveryMs:15000,retentionDays:7}}]});
test('mapping enforces bounded own paths and types; HTTP adapter shares demand and forwards only accepted observations',async()=>{
  expect(mapHttpSample(config,'value',{value:'1.25'})).toEqual({payload:{kind:'metric',value:'1.25'},eventTime:null,origin:'live'});
  expect(()=>mapHttpSample(config,'value',Object.create({value:'1.25'}))).toThrow();
  expect(()=>mapHttpSample(config,'value',{value:'not numeric'})).toThrow();
  const boolean=sourceConfigSchema.parse({...config,feeds:[{...config.feeds[0],mapping:{kind:'boolean',valuePath:['value']}}]});
  expect(()=>mapHttpSample(boolean,'value',{value:'true'})).toThrow();
  const source:StoredSource={id:'11111111-1111-4111-8111-111111111111',ownerId:'22222222-2222-4222-8222-222222222222',revision:1,enabled:true,validated:true,config};
  const f=fixture(),sink=vi.fn(()=>true),adapter=createHttpAdapter(f.client,async()=>source);
  const runtime=createDataSourceRuntime([adapter],{onObservation:sink});
  try {
    const definition=httpFeedDefinitions(source)[0];const a=runtime.acquire(definition,{mode:'latest',demand:'ui'}),b=runtime.acquire(definition,{mode:'latest',demand:'ui'});
    await vi.waitFor(()=>expect(sink).toHaveBeenCalledTimes(1));expect(f.request).toHaveBeenCalledTimes(1);
    expect(a.read().latest?.payload).toEqual({kind:'metric',value:'1.25'});expect(b.read().latest?.payload).toEqual(a.read().latest?.payload);
    a.release();b.release();
  } finally {runtime.close();}
});

test('stored HTTP credentials attach only to their scoped source, rotate, and fail closed after deletion', async () => {
  const { createCredentials } = await import('../../../src/main/credentials');
  const records = new Map<string, string>();
  const store = { available: () => true, get: async (id: string) => records.get(id) ?? null,
    set: async (id: string, value: string) => { records.set(id, value); },
    has: async (id: string) => records.has(id), delete: async (id: string) => { records.delete(id); } };
  const credentials = createCredentials(store);
  const payload = (secret: string, auth = 'Bearer token') => JSON.stringify({ url: 'https://fixture.example/api', auth, secret, header: 'X-API-Key', username: 'fixture-user' });
  const [credential] = await credentials.save({ name: 'Synthetic HTTP', provider: 'Fixture', type: 'http-api', value: payload('synthetic-token') });
  const source: StoredSource = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', revision: 1, enabled: true, validated: true,
    config: sourceConfigSchema.parse({ ...config, endpoint: 'https://fixture.example/api/value', credentialId: credential.id }) };
  const f = fixture();
  const adapter = createHttpAdapter(f.client, async () => source, store);
  if (adapter.transport !== 'http') throw Error('Expected HTTP');
  const context = { feed: httpFeedDefinitions(source)[0], signal: new AbortController().signal, epoch: 1, emit: vi.fn(), connected: vi.fn(), heartbeat: vi.fn(), fail: vi.fn() };
  await adapter.poll(context);
  expect(f.captured().headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
  expect(context.emit).toHaveBeenCalledOnce();
  expect(JSON.stringify(context.emit.mock.calls)).not.toContain('synthetic-token');
  expect(JSON.stringify(source.config)).not.toContain('synthetic-token');
  expect(JSON.stringify(await credentials.list())).not.toContain('synthetic-token');
  for (const [auth, expected] of [['Custom header', { 'X-API-Key': 'rotated-fixture' }], ['Basic auth', { Authorization: `Basic ${Buffer.from('fixture-user:rotated-fixture').toString('base64')}` }]]) {
    await credentials.save({ ...credential, value: payload('rotated-fixture', auth as string) });
    await adapter.poll(context);
    expect(f.captured().headers).toMatchObject(expected);
  }
  for (const endpoint of ['https://other.example/api/value', 'https://fixture.example/api-other', 'https://fixture.example/api/%2felse', 'http://fixture.example/api/value']) {
    await expect(credentials.sourceHttpCredential(credential.id, endpoint)).rejects.toThrow('HTTP source credential unavailable');
  }
  const before = f.request.mock.calls.length;
  await adapter.poll({ ...context, feed: { ...context.feed, authScope: 'public' } });
  await credentials.remove(credential.id);
  await adapter.poll(context);
  expect(f.request).toHaveBeenCalledTimes(before);
  expect(context.fail).toHaveBeenLastCalledWith('invalid_data', { configuration: true });
  const missingStore = createHttpAdapter(f.client, async () => source);
  if (missingStore.transport === 'http') await missingStore.poll(context);
  expect(f.request).toHaveBeenCalledTimes(before);
});

test('HTTP credential resolver rejects unrelated types, unsafe headers and unavailable storage without leaking errors', async () => {
  const { createCredentials } = await import('../../../src/main/credentials');
  let raw: string | null = null;
  const store = { available: () => true, get: async () => raw, set: async (_: string, value: string) => { raw = value; }, has: async () => raw !== null, delete: async () => { raw = null; } };
  const credentials = createCredentials(store);
  const [legacy] = await credentials.save({ name: 'Unscoped', provider: 'Fixture', type: 'bearer-token', value: 'synthetic-secret' });
  await expect(credentials.sourceHttpCredential(legacy.id, 'https://fixture.example/')).rejects.toThrow('HTTP source credential unavailable');
  const items = await credentials.save({ name: 'Unsafe', provider: 'Fixture', type: 'http-api', value: JSON.stringify({ url: 'https://fixture.example', auth: 'Custom header', header: 'Host', secret: 'synthetic-secret' }) });
  await expect(credentials.sourceHttpCredential(items[1].id, 'https://fixture.example/')).rejects.toThrow('HTTP source credential unavailable');
  const locked = createCredentials({ ...store, get: async () => { throw Error('synthetic-secret'); } });
  await expect(locked.sourceHttpCredential(legacy.id, 'https://fixture.example/')).rejects.toThrow('HTTP source credential unavailable or incompatible with endpoint');
  expect(() => sourceConfigSchema.parse({ ...config, credentialId: 'raw-secret' })).toThrow();
});

test('exponent-form numbers normalize to exact decimal strings', () => {
  for (const [raw, expected] of [[1e-7, '0.0000001'], [1e21, '1000000000000000000000'], [1.5e21, '1500000000000000000000'], [-2.5e-8, '-0.000000025'], ['1.25E+3', '1250'], [12.5, '12.5'], [0, '0'], [1.23456789e-10, '0.000000000123456789']] as const) {
    expect(mapHttpSample(config, 'value', { value: raw }).payload, String(raw)).toEqual({ kind: 'metric', value: expected });
  }
  expect(exactDecimal('-0e5')).toBe('0'); expect(() => mapHttpSample(config, 'value', { value: 1e100 })).toThrow();
});
test('previews and inspection use a separate concurrency budget from live polls', async () => {
  const f = fixture(); f.resolve.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const live = ['a', 'b', 'c', 'd'].map(id => f.client.read(id, 'https://fixture.example/', controller.signal).catch(error => error));
  await expect(f.client.read('e', 'https://fixture.example/', controller.signal)).rejects.toMatchObject({ code: 'capacity' });
  // Same source key as a live poll, but in the preview pool: admitted.
  const preview = f.client.read('a', 'https://fixture.example/', controller.signal, undefined, 'preview').catch(error => error);
  const second = f.client.read('inspect:owner', 'https://fixture.example/', controller.signal, undefined, 'preview').catch(error => error);
  await expect(f.client.read('third', 'https://fixture.example/', controller.signal, undefined, 'preview')).rejects.toMatchObject({ code: 'capacity' });
  controller.abort();
  expect((await Promise.all([...live, preview, second])).every(error => error.code === 'cancelled')).toBe(true);
});
test('feeds of one HTTP source share a single request per poll', async () => {
  vi.useFakeTimers();
  try {
    const two = sourceConfigSchema.parse({ ...config, feeds: [config.feeds[0], { ...config.feeds[0], id: 'other', name: 'Other' }, { ...config.feeds[0], id: 'third', name: 'Third' }] });
    const source: StoredSource = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', revision: 1, enabled: true, validated: true, config: two };
    const read = vi.fn(async () => ({ value: '3' }));
    const runtime = createDataSourceRuntime([createHttpAdapter({ read }, async () => source)], { random: () => Math.random() });
    try {
      const leases = httpFeedDefinitions(source).map(feed => runtime.acquire(feed, { mode: 'latest', demand: 'ui' }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(1); for (const lease of leases) expect(lease.read().quality).toBe('fresh');
      await vi.advanceTimersByTimeAsync(10 * 16_500);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(10); expect(read.mock.calls.length).toBeLessThanOrEqual(12);
    } finally { runtime.close(); }
  } finally { vi.useRealTimers(); }
});
test('HTTP: a body missing a field and a resolve error back off and retry; configuration errors block', async () => {
  const source: StoredSource = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', revision: 1, enabled: true, validated: true, config };
  const read = vi.fn(async (): Promise<unknown> => ({ other: 1 }));
  const resolve = vi.fn(async (): Promise<StoredSource | null> => source);
  const adapter = createHttpAdapter({ read }, resolve);
  if (adapter.transport !== 'http') throw Error('Expected HTTP');
  const context = () => ({ feed: httpFeedDefinitions(source)[0], signal: new AbortController().signal, epoch: 1, emit: vi.fn(), connected: vi.fn(), heartbeat: vi.fn(), fail: vi.fn() });
  let ctx = context(); await adapter.poll(ctx); expect(ctx.fail).toHaveBeenCalledWith('invalid_data', { retryAfterMs: 15000 });
  resolve.mockRejectedValueOnce(Error('synthetic database error')); ctx = context(); await adapter.poll(ctx); expect(ctx.fail).toHaveBeenCalledWith('transport');
  resolve.mockResolvedValueOnce({ ...source, enabled: false }); ctx = context(); await adapter.poll(ctx); expect(ctx.fail).toHaveBeenCalledWith('invalid_data', { configuration: true });
});
test('DNS lookup removes its abort listener whether lookup resolves or fails', async () => {
  const f = fixture(), original = AbortSignal.any, added: unknown[] = [], removed: unknown[] = [];
  const spy = vi.spyOn(AbortSignal, 'any').mockImplementation(signals => {
    const combined = original.call(AbortSignal, signals), add = combined.addEventListener.bind(combined), remove = combined.removeEventListener.bind(combined);
    combined.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => { if (type === 'abort') added.push(listener); add(type, listener, options); }) as typeof combined.addEventListener;
    combined.removeEventListener = ((type: string, listener: EventListener) => { if (type === 'abort') removed.push(listener); remove(type, listener); }) as typeof combined.removeEventListener;
    return combined;
  });
  try {
    const signal = new AbortController().signal;
    expect(await f.client.read('a', 'https://fixture.example/', signal)).toEqual({ value: '1.25' });
    f.resolve.mockRejectedValueOnce(Error('synthetic lookup failure'));
    await expect(f.client.read('a', 'https://fixture.example/', signal)).rejects.toMatchObject({ code: 'transport' });
    expect(added).toHaveLength(2); expect(removed).toEqual(added);
  } finally { spy.mockRestore(); }
});
test('only known configuration errors block HTTP polls; credential store and internal failures retry', async () => {
  const { createCredentials } = await import('../../../src/main/credentials');
  const records = new Map<string, string>();
  let locked = false;
  const store = { available: () => true, get: async (id: string) => { if (locked) throw Error('synthetic keychain locked'); return records.get(id) ?? null; },
    set: async (id: string, value: string) => { records.set(id, value); }, has: async (id: string) => records.has(id), delete: async (id: string) => { records.delete(id); } };
  const [credential] = await createCredentials(store).save({ name: 'Synthetic HTTP', provider: 'Fixture', type: 'http-api', value: JSON.stringify({ url: 'https://fixture.example/api', auth: 'Bearer token', secret: 'synthetic-token' }) });
  const source: StoredSource = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', revision: 1, enabled: true, validated: true,
    config: sourceConfigSchema.parse({ ...config, endpoint: 'https://fixture.example/api/value', credentialId: credential.id }) };
  const read = vi.fn(async (): Promise<unknown> => ({ value: '2' }));
  const adapter = createHttpAdapter({ read }, async () => source, store);
  if (adapter.transport !== 'http') throw Error('Expected HTTP');
  const context = () => ({ feed: httpFeedDefinitions(source)[0], signal: new AbortController().signal, epoch: 1, emit: vi.fn(), connected: vi.fn(), heartbeat: vi.fn(), fail: vi.fn() });
  locked = true; let ctx = context(); await adapter.poll(ctx);
  expect(ctx.fail).toHaveBeenCalledWith('transport'); expect(read).not.toHaveBeenCalled();
  locked = false; read.mockRejectedValueOnce(Error('synthetic internal fault')); ctx = context(); await adapter.poll(ctx);
  expect(ctx.fail).toHaveBeenCalledWith('transport');
  ctx = context(); await adapter.poll(ctx); expect(ctx.emit).toHaveBeenCalledOnce(); expect(ctx.fail).not.toHaveBeenCalled();
  // A readable inventory without the credential (or out of scope) is configuration.
  records.clear(); ctx = context(); await adapter.poll(ctx); expect(ctx.fail).toHaveBeenCalledWith('invalid_data', { configuration: true });
  ctx = context(); const other = { ...source, config: { ...source.config, credentialId: undefined } };
  const unscoped = createHttpAdapter({ read }, async () => other, store); if (unscoped.transport === 'http') await unscoped.poll(ctx);
  expect(ctx.fail).toHaveBeenCalledWith('invalid_data', { configuration: true });
});
test('shared HTTP poll survives initiator cancellation and is cancelled only when every joined feed cancels', async () => {
  const three = sourceConfigSchema.parse({ ...config, feeds: ['value', 'other', 'third'].map(id => ({ ...config.feeds[0], id, name: id })) });
  const source: StoredSource = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', revision: 1, enabled: true, validated: true, config: three };
  const pending: Array<{ signal: AbortSignal; finish(value: unknown): void }> = [];
  const read = vi.fn((_key: string, _endpoint: string, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    pending.push({ signal, finish: resolve }); signal.addEventListener('abort', () => reject(new SourceHttpError('cancelled')), { once: true });
  }));
  const adapter = createHttpAdapter({ read }, async () => source);
  if (adapter.transport !== 'http') throw Error('Expected HTTP');
  const feeds = httpFeedDefinitions(source);
  const context = (index: number) => { const controller = new AbortController(); return { controller, feed: feeds[index], signal: controller.signal, epoch: 1, emit: vi.fn(), connected: vi.fn(), heartbeat: vi.fn(), fail: vi.fn() }; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const initiator = context(0), sibling = context(1);
  const polls = [adapter.poll(initiator), adapter.poll(sibling)]; await settle();
  expect(read).toHaveBeenCalledOnce();
  initiator.controller.abort(); await polls[0];
  expect(pending[0].signal.aborted).toBe(false);
  pending[0].finish({ value: '4' }); await polls[1];
  expect(sibling.fail).not.toHaveBeenCalled(); expect(sibling.emit).toHaveBeenCalledWith({ payload: { kind: 'metric', value: '4' }, eventTime: null, origin: 'live' });
  expect(initiator.fail).not.toHaveBeenCalled(); expect(initiator.emit).not.toHaveBeenCalled();
  // Both joiners of a new shared read cancel: the read itself is cancelled, nobody records a failure.
  const a = context(0), b = context(2), next = [adapter.poll(a), adapter.poll(b)]; await settle();
  expect(read).toHaveBeenCalledTimes(2);
  a.controller.abort(); expect(pending[1].signal.aborted).toBe(false);
  b.controller.abort(); await Promise.all(next);
  expect(pending[1].signal.aborted).toBe(true); expect(a.fail).not.toHaveBeenCalled(); expect(b.fail).not.toHaveBeenCalled();
});
