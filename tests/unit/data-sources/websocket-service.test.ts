import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, test, vi } from 'vitest';
import { migrate } from '../../../src/main/migrations';
import { createCredentials } from '../../../src/main/credentials';
import { createCustomDataSources } from '../../../src/main/data-sources/service';
import { createSourceWebsocketTransport } from '../../../src/main/data-sources/websocket/transport';
import type { WebsocketSource } from '../../../src/main/data-sources/websocket/adapter';
import type { DataFeedInfo, DataLease, DataLeaseRead } from '../../../src/shared/data-sources';
const clientId = '11111111-1111-4111-8111-111111111111';
const endpoint = 'wss://fixture.example.test/prices';
const config = { name: 'Fixture prices', transport: 'websocket', collection: 'when-open',
  connection: { endpoint, auth: { mode: 'none' }, subscription: { body: { op: 'subscribe' } }, acknowledgement: { success: { path: ['op'], equals: 'subscribed' }, failure: { path: ['op'], equals: 'denied' } } },
  feeds: [{ id: 'price', name: 'Price', unit: 'USD', mapping: { kind: 'metric', valuePath: ['price'] }, storage: { mode: 'latest', fields: ['value'] } }],
};
async function fixture(frame=()=>'{"price":"123.45","private":"not-retained"}') {
  const db = new PGlite(); await migrate(db);
  const values = new Map<string, string>();
  const secrets = { available: () => true, get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, has: async (key: string) => values.has(key), delete: async (key: string) => { values.delete(key); } };
  const credentials = createCredentials(secrets);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); if (typeof address === 'string') throw Error();
  let messages = true;
  server.on('connection', socket => socket.on('message', () => {
    socket.send('{"op":"subscribed"}');
    const timer = setInterval(() => { if (messages && socket.readyState === WebSocket.OPEN) socket.send(frame()); }, 30);
    socket.once('close', () => clearInterval(timer));
  }));
  const transport = createSourceWebsocketTransport({ credential: credentials.sourceWebsocketCredential,
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    makeSocket: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, { ...options, agent: undefined }),
  });
  const service = createCustomDataSources({ use: work => work(db) }, secrets, { read: async () => { throw Error('HTTP not expected'); } }, transport);
  return { db, service, credentials, server, silence() { messages = false; }, configure: (request: unknown) => service.dispatch('dataSources:configure', [request], clientId), async close() {
    await service.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); await db.close();
  } };
}
test('saved WSS source previews, enables, exposes live lease data and retains selected fields', async () => {
  const f = await fixture();
  try {
    const inspected = await f.configure({ action: 'websocket-inspect', connection: config.connection });
    expect(inspected).toMatchObject({ fields: expect.arrayContaining([{ path: ['price'], type: 'string', sample: '123.45', selectable: true }]) });
    expect((await f.db.query('SELECT * FROM data_sources')).rows).toHaveLength(0);
    const saved = await f.configure({ action: 'save', config }) as WebsocketSource;
    await expect(f.configure({ action: 'enable', id: saved.id, revision: 1, enabled: true })).rejects.toThrow();
    const preview = await f.configure({ action: 'preview', id: saved.id, revision: 1 });
    expect(preview).toMatchObject({ samples: [{ payload: { kind: 'metric', value: '123.45' } }] });
    expect((await f.db.query('SELECT * FROM data_source_latest')).rows).toHaveLength(0);
    await f.configure({ action: 'enable', id: saved.id, revision: 1, enabled: true });
    expect(await f.configure({ action: 'list' })).toEqual([]);
    expect(await f.configure({ action: 'websocket-list' })).toHaveLength(1);
    const [feed] = await f.service.dispatch('dataSources:list', [], clientId) as DataFeedInfo[];
    const { sourceId, feedId, configVersion, schemaVersion } = feed;
    const lease = await f.service.dispatch('dataSources:acquire', [{ sourceId, feedId, configVersion, schemaVersion }], clientId) as DataLease;
    await vi.waitFor(async () => {
      const rows = (await f.db.query<{data: unknown}>('SELECT data FROM data_source_latest')).rows;
      expect(rows).toHaveLength(1); expect(rows[0].data).toMatchObject({ adapterId: 'custom-websocket', fields: { value: '123.45' } });
      expect(JSON.stringify(rows)).not.toContain('not-retained');
    }, { timeout: 4000 });
    const [read] = await f.service.dispatch('dataSources:read', [[lease.leaseId]], clientId) as DataLeaseRead[];
    expect(read.snapshot).toMatchObject({ quality: 'fresh', latest: { payload: { value: '123.45' } } });
    const revised = await f.configure({ action: 'save', config, existing: { id: saved.id, revision: 1 } });
    expect(revised).toMatchObject({ revision: 2, enabled: false, validated: false });
    expect(await f.service.dispatch('dataSources:list', [], clientId)).toEqual([]);
    expect((await f.db.query('SELECT * FROM data_source_latest')).rows).toHaveLength(0);
    await vi.waitFor(() => expect(f.server.clients.size).toBe(0));
  } finally { await f.close(); }
});
test('WSS credentials are endpoint scoped, rotate, and cannot be replaced by HTTP credentials', async () => {
  const f = await fixture();
  try {
    const [credential] = await f.credentials.save({ name: 'Fixture WS', provider: 'Fixture', type: 'websocket-api', value: JSON.stringify({ endpoint, kind: 'bearer', value: 'synthetic-one' }) });
    const first = await f.credentials.sourceWebsocketCredential(credential.id, endpoint);
    await expect(f.credentials.sourceWebsocketCredential(credential.id, endpoint + '/other')).rejects.toThrow('incompatible');
    await expect(f.credentials.sourceHttpCredential(credential.id, endpoint.replace('wss:', 'https:'))).rejects.toThrow('incompatible');
    await f.credentials.save({ ...credential, value: JSON.stringify({ endpoint, kind: 'bearer', value: 'synthetic-two' }) });
    const second = await f.credentials.sourceWebsocketCredential(credential.id, endpoint);
    expect(second.generation).not.toBe(first.generation);
    const source = await f.configure({ action: 'save', config: { ...config, connection: { ...config.connection, auth: { mode: 'header', credentialId: credential.id } } } }) as WebsocketSource;
    await f.configure({ action: 'preview', id: source.id, revision: 1 });
    const serialized = JSON.stringify((await f.db.query('SELECT config FROM data_source_revisions')).rows);
    expect(serialized).not.toContain('synthetic-two');
    await f.credentials.remove(credential.id); f.service.invalidateCredentials();
    await expect(f.configure({ action: 'preview', id: source.id, revision: 1 })).rejects.toThrow('preview failed');
  } finally { await f.close(); }
});
test('suspension cancels an awaiting WSS preview without validating its revision', async () => {
  const f = await fixture();
  try {
    f.silence(); const source = await f.configure({ action: 'save', config }) as WebsocketSource;
    const preview = f.configure({ action: 'preview', id: source.id, revision: 1 });
    const rejected = expect(preview).rejects.toThrow('preview failed');
    await vi.waitFor(() => expect(f.server.clients.size).toBe(1)); f.service.suspend(); await rejected;
    expect(await f.configure({ action: 'websocket-list' })).toMatchObject([{ validated: false }]);
    await vi.waitFor(() => expect(f.server.clients.size).toBe(0));
  } finally { await f.close(); }
});
test('raw strings persist unchanged and Always owns demand without a renderer lease', async () => {
 const f=await fixture();
 try {
  // This fixture sends JSON text; raw mode must preserve that exact string.
  const rawConfig={...config,connection:{...config.connection,dataMode:'text'},collection:'automatic',feeds:[{id:'messages',name:'Messages',unit:'text',mapping:{kind:'text'},storage:{mode:'history',fields:['value'],sampleEveryMs:1000,retentionDays:7}}]};
  const source=await f.configure({action:'save',config:rawConfig}) as WebsocketSource;
  await f.configure({action:'preview',id:source.id,revision:1});
  await f.configure({action:'enable',id:source.id,revision:1,enabled:true});
  await vi.waitFor(async()=>expect((await f.db.query('SELECT * FROM data_source_history')).rows).toHaveLength(1),{timeout:4000});
  const rows=(await f.db.query<{data:{fields:{value:string}}}>('SELECT data FROM data_source_latest')).rows;
  expect(rows[0].data.fields.value).toBe('{"price":"123.45","private":"not-retained"}');
  const messages=await f.configure({action:'websocket-messages',id:source.id,revision:1}) as {messages:Array<{type:string;text:string}>;total:number};
  expect(messages.total).toBeGreaterThan(0);expect(messages.messages.some(row=>row.type==='json'&&row.text===rows[0].data.fields.value)).toBe(true);
  expect(messages.messages.some(row=>row.text.includes('"op":"subscribed"'))).toBe(false);
  const next=await f.configure({action:'websocket-policy',id:source.id,revision:1,collection:'when-open',storage:'live'}) as WebsocketSource;
  expect(next).toMatchObject({revision:2,enabled:true,validated:true,config:{collection:'when-open'}});
  await vi.waitFor(()=>expect(f.server.clients.size).toBe(0));
  await expect(f.configure({action:'websocket-messages',id:source.id,revision:1})).rejects.toThrow('Source changed');
 }finally{await f.close();}
});

test('WSS mapped price preview is read-only and enabled frames reach the shared market reader', async () => {
 const f=await fixture(()=>JSON.stringify({price:'123.45',time:Date.now()}));
 try {
  const market={venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'};
  await f.db.query("INSERT INTO market_quotes(symbol,price,observed_at) VALUES('AAPL',100,$1)",[new Date(Date.now()-120000)]);
  const priceConfig={...config,collection:'automatic',feeds:[{...config.feeds[0],eventTimePath:['time'],destination:{kind:'market-price',market,currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true}}]};
  const source=await f.configure({action:'save',config:priceConfig}) as WebsocketSource;
  const preview=await f.configure({action:'preview',id:source.id,revision:1});
  expect(preview).toMatchObject({destinations:[{outcome:'would-write',proposed:{price:'123.45',provider:'custom-websocket'}}]});
  expect((await f.db.query('SELECT price_provider FROM market_quotes')).rows).toEqual([{price_provider:'robinhood'}]);
  await f.configure({action:'enable',id:source.id,revision:1,enabled:true});
  await vi.waitFor(async()=>{
   expect(await f.configure({action:'market-price',market})).toMatchObject({quality:'fresh',quote:{payload:{price:'123.450000000000000000'},provider:'custom-websocket',sourceId:source.id,revision:1}});
  },{timeout:4000});
  expect(await f.configure({action:'destination-status',id:source.id})).toMatchObject([{outcome:'written',target:'market_quotes:AAPL'}]);
  await f.configure({action:'enable',id:source.id,revision:1,enabled:false});
  await vi.waitFor(()=>expect(f.server.clients.size).toBe(0));
 }finally{await f.close();}
});

test('one WSS feed routes interleaved markets and filters selected rows through the full runtime',async()=>{
 let index=0;const at=Date.now();
 const f=await fixture(()=>{const symbol=['AAPL','MSFT','TSLA'][index++%3];return JSON.stringify({symbol,price:symbol==='AAPL'?'120':'130',time:at-(symbol==='MSFT'?1000:0)});});
 try{
  for(const symbol of ['AAPL','MSFT','TSLA'])await f.db.query('INSERT INTO market_quotes(symbol,price,observed_at) VALUES($1,100,$2)',[symbol,new Date(at-120000)]);
  const routed={...config,collection:'automatic',feeds:[{id:'prices',name:'Prices',unit:'USD',eventTimePath:['time'],mapping:{kind:'event',fields:{symbol:{path:['symbol'],type:'string'},price:{path:['price'],type:'string'}}},storage:{mode:'latest',fields:['symbol','price']},destination:{kind:'market-prices',market:{venue:'robinhood',instance:'production',kind:'equity'},symbolField:'symbol',priceField:'price',conditions:[{field:'symbol',op:'in',values:['AAPL','MSFT']}],currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true}}]};
  const source=await f.configure({action:'save',config:routed}) as WebsocketSource;
  await f.configure({action:'preview',id:source.id,revision:1});
  await f.configure({action:'enable',id:source.id,revision:1,enabled:true});
  await vi.waitFor(async()=>{
   const rows=(await f.db.query<{symbol:string;price:string;price_provider:string}>('SELECT symbol,price::text,price_provider FROM market_quotes ORDER BY symbol')).rows;
   expect(rows.map(r=>[r.symbol,Number(r.price),r.price_provider])).toEqual([['AAPL',120,'custom-websocket'],['MSFT',130,'custom-websocket'],['TSLA',100,'robinhood']]);
  },{timeout:4000});
 }finally{await f.close();}
});

test('WSS metadata preview stays read-only and enabled frames store field timestamps',async()=>{
 let partial=false;const f=await fixture(()=>JSON.stringify(partial?{score:null,note:'updated',time:Date.now()}:{score:72,note:'initial',time:Date.now()}));
 try{
  const market={venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'};
  const metadataConfig={...config,collection:'automatic',feeds:[{id:'metadata',name:'Sentiment',unit:'points',eventTimePath:['time'],mapping:{kind:'event',fields:{score:{path:['score'],type:'number'},note:{path:['note'],type:'string'}}},storage:{mode:'latest',fields:['score','note']},destination:{kind:'market-metadata',market,namespace:'sentiment',maxAgeMs:60000}}]};
  const source=await f.configure({action:'save',config:metadataConfig}) as WebsocketSource;
  expect(await f.configure({action:'preview',id:source.id,revision:1})).toMatchObject({destinations:[{outcome:'would-write'}]});
  expect((await f.db.query('SELECT * FROM market_source_metadata')).rows).toHaveLength(0);
  await f.configure({action:'enable',id:source.id,revision:1,enabled:true});
  await vi.waitFor(async()=>expect(await f.configure({action:'market-metadata',market})).toMatchObject({namespaces:[{sourceId:source.id,fields:{score:72},fieldUpdates:{score:{updatedAt:expect.any(Number),eventTime:expect.any(Number),quality:'fresh'}}}]}),{timeout:4000});
  partial=true;
  await vi.waitFor(async()=>expect(await f.configure({action:'market-metadata',market})).toMatchObject({namespaces:[{fields:{score:72,note:'updated'},fieldUpdates:{score:{updatedAt:expect.any(Number)},note:{updatedAt:expect.any(Number)}}}]}),{timeout:4000});
  await f.configure({action:'enable',id:source.id,revision:1,enabled:false});
  expect(await f.configure({action:'market-metadata',market})).toMatchObject({namespaces:[]});
 }finally{await f.close();}
});

test('conditional websocket metadata fetch waits for a committed update of the selected field',async()=>{
 let frame={score:7};const f=await fixture(()=>JSON.stringify(frame));
 try{
  const saved=await f.configure({action:'save',config:{...config,feeds:[{id:'metadata',name:'Score',unit:'points',mapping:{kind:'event',fields:{score:{path:['score'],type:'number'}}},storage:{mode:'latest',fields:['score']},destination:{kind:'market-metadata',market:{venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'},namespace:'sentiment',maxAgeMs:60000}}]}}) as WebsocketSource;
  await f.configure({action:'preview',id:saved.id,revision:1});await f.configure({action:'enable',id:saved.id,revision:1,enabled:true});
  const binding={key:'score',sourceId:saved.id,sourceRevision:1,feedId:'metadata',field:'score',kind:'event' as const,unit:'points',maxAgeMs:15000};
  const first=await f.service.ruleFetch(binding,'latest',5000,new AbortController().signal);expect(first.value).toBe(7);
  frame={score:9};const next=await f.service.ruleFetch(binding,'next',5000,new AbortController().signal);
  expect(next.value).toBe(9);expect(next.observation!.receivedAt).toBeGreaterThan(first.observation!.receivedAt);
 }finally{await f.close();}
});
