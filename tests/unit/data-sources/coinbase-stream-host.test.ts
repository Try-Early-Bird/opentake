import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCoinbaseStreamHost } from '../../../src/main/data-sources/coinbase-stream/host';
import type { PublicStreamTransport } from '../../../src/main/data-sources/coinbase-stream/session';
import type { DataLease } from '../../../src/shared/data-sources';
import type { CoinbaseStreamRead } from '../../../src/shared/coinbase-stream';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const hosts: ReturnType<typeof createCoinbaseStreamHost>[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:00Z')); });
afterEach(() => { for (const host of hosts.splice(0)) host.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
function fixture() {
  const sockets: Array<{ callbacks: Parameters<PublicStreamTransport['connect']>[1]; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; seq: number }> = [];
  const transport: PublicStreamTransport = { connect(_request, callbacks) { const socket = { callbacks, send: vi.fn(), close: vi.fn(), seq: 0 }; sockets.push(socket); return socket; } };
  const host = createCoinbaseStreamHost({ transport, monotonic: Date.now, random: () => 0.5 }); hosts.push(host);
  function acquire(product = 'BTC-USD', client = a) { return host.dispatch({ action: 'acquire', product, mode:'book' }, client) as DataLease; }
  function read(id: string, client = a) { return (host.dispatch({ action: 'read', ids: [id] }, client) as CoinbaseStreamRead[])[0].snapshot; }
  function send(index: number, channel: string, events: unknown[]) {
    const socket = sockets[index]; socket.callbacks.message(JSON.stringify({ channel, sequence_num: socket.seq++, timestamp: new Date().toISOString(), events }));
  }
  function heartbeat(index: number) { send(index, 'heartbeats', [{ current_time: new Date().toISOString(), heartbeat_counter: String(sockets[index].seq) }]); }
  function ready(index: number, products = ['BTC-USD']) {
    sockets[index].callbacks.open();
    for (const product_id of products) send(index, 'l2_data', [{ type: 'snapshot', product_id, updates: [
      { side: 'bid', price_level: '100', new_quantity: '1', event_time: new Date().toISOString() },
      { side: 'offer', price_level: '101', new_quantity: '2', event_time: new Date().toISOString() },
    ] }]);
    heartbeat(index);
  }
  return { host, acquire, read, sockets, send, heartbeat, ready };
}

test('two clients share one public socket; reads and release remain client scoped', async () => {
  const f = fixture(), one = f.acquire(), two = f.acquire('BTC-USD', b);
  expect(f.sockets).toHaveLength(1); f.ready(0);
  expect(f.read(one.leaseId)?.continuity).toBe('live');
  expect(f.read(one.leaseId, b)).toBeNull();
  const copy = f.read(two.leaseId, b)!; copy.book!.bids[0].price = '999';
  f.host.dispatch({ action: 'release', ids: [one.leaseId] }, b);
  await vi.advanceTimersByTimeAsync(250); expect(f.read(one.leaseId)?.book?.bids[0].price).toBe('100');
  f.host.dispatch({ action: 'release', ids: [one.leaseId] }, a); expect(f.sockets[0].close).not.toHaveBeenCalled();
  f.host.dispatch({ action: 'release', ids: [two.leaseId] }, b); expect(f.sockets[0].close).toHaveBeenCalledTimes(1);
});

test('product changes subscribe incrementally on the live socket without failure or backoff', async () => {
  const f = fixture(), one = f.acquire(); f.ready(0); await vi.advanceTimersByTimeAsync(1000);
  const commands = () => f.sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw));
  expect(commands()).toEqual([{ type: 'subscribe', channel: 'heartbeats' }, { type: 'subscribe', channel: 'level2', product_ids: ['BTC-USD'] }, { type: 'subscribe', channel: 'market_trades', product_ids: ['BTC-USD'] }]);
  const two = f.acquire('ETH-USD'), three = f.acquire('SOL-USD');
  expect(f.read(one.leaseId)).toMatchObject({ continuity: 'live', connection: 'live', issue: null });
  await vi.advanceTimersByTimeAsync(1000);
  // Rapid edits coalesce: one level2 command and one trades command for both additions.
  expect(commands().slice(3)).toEqual([{ type: 'subscribe', channel: 'level2', product_ids: ['ETH-USD', 'SOL-USD'] }, { type: 'subscribe', channel: 'market_trades', product_ids: ['ETH-USD', 'SOL-USD'] }]);
  f.ready(0, []); f.send(0, 'l2_data', [{ type: 'snapshot', product_id: 'ETH-USD', updates: [{ side: 'bid', price_level: '10', new_quantity: '1', event_time: new Date().toISOString() }] }]);
  expect(f.read(two.leaseId)?.book?.product).toBe('ETH-USD');
  f.host.dispatch({ action: 'release', ids: [three.leaseId] }, a); await vi.advanceTimersByTimeAsync(1000);
  expect(commands().slice(5)).toEqual([{ type: 'unsubscribe', channel: 'level2', product_ids: ['SOL-USD'] }, { type: 'unsubscribe', channel: 'market_trades', product_ids: ['SOL-USD'] }]);
  // In-flight frames for a dropped product are skipped rather than poisoning the stream.
  f.send(0, 'l2_data', [{ type: 'update', product_id: 'SOL-USD', updates: [{ side: 'bid', price_level: '5', new_quantity: '1', event_time: new Date().toISOString() }] }]);
  f.send(0, 'market_trades', [{ type: 'update', trades: [{ trade_id: '1', product_id: 'SOL-USD', price: '5', size: '1', side: 'BUY', time: new Date().toISOString() }] }]);
  // Five more product changes inside 30 s never count as failures or trigger a 300 s backoff.
  for (const product of ['ADA-USD', 'ZEC-USD', 'LTC-USD', 'XRP-USD', 'DOGE-USD']) {
    const lease = f.host.dispatch({ action: 'acquire', product, mode: 'prices' }, a) as DataLease;
    await vi.advanceTimersByTimeAsync(500); f.heartbeat(0); f.host.dispatch({ action: 'release', ids: [lease.leaseId] }, a);
  }
  await vi.advanceTimersByTimeAsync(2000); f.heartbeat(0);
  expect(f.sockets).toHaveLength(1); expect(f.sockets[0].close).not.toHaveBeenCalled();
  expect(f.read(one.leaseId)).toMatchObject({ continuity: 'live', connection: 'live', issue: null });
});

test('runtime retries transport failure with escalating delay and fresh snapshot requirements', async () => {
  const f = fixture(), one = f.acquire(); f.ready(0); f.sockets[0].callbacks.error();
  expect(f.read(one.leaseId)).toMatchObject({ connection: 'retrying', book: null });
  await vi.advanceTimersByTimeAsync(900); expect(f.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100); expect(f.sockets).toHaveLength(2);
  f.sockets[1].callbacks.open(); f.heartbeat(1);
  expect(f.read(one.leaseId)?.continuity).toBe('unavailable');
  f.sockets[1].callbacks.close(); await vi.advanceTimersByTimeAsync(1900); expect(f.sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(100); expect(f.sockets).toHaveLength(3);
  f.ready(2); expect(f.read(one.leaseId)?.continuity).toBe('live');
});

test('lease expiry, drop-client and suspend all remove demand; resume needs reacquisition', async () => {
  const f = fixture(), one = f.acquire(); f.ready(0);
  await vi.advanceTimersByTimeAsync(30_000); expect(f.read(one.leaseId)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  const two = f.acquire(); f.host.dropClient(a); expect(f.read(two.leaseId)).toBeNull();
  const three = f.acquire(); f.host.suspend();
  expect(() => f.acquire()).toThrow('suspended'); expect(f.read(three.leaseId)).toBeNull();
  const count = f.sockets.length; f.host.resume(); await vi.advanceTimersByTimeAsync(1000); expect(f.sockets).toHaveLength(count);
  f.acquire(); expect(f.sockets).toHaveLength(count + 1);
});

test('renewal only extends owned leases and read pacing does not extend them', async () => {
  const f = fixture(), one = f.acquire();
  expect(f.host.dispatch({ action: 'renew', ids: [one.leaseId] }, b)).toEqual([]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.host.dispatch({ action: 'renew', ids: [one.leaseId] }, a)).toHaveLength(1);
  f.read(one.leaseId); expect(() => f.read(one.leaseId)).toThrow('rate limited');
  await vi.advanceTimersByTimeAsync(11_000); expect(f.read(one.leaseId)).not.toBeNull();
  await vi.advanceTimersByTimeAsync(19_000); expect(f.read(one.leaseId)).toBeNull();
});

test('invalid messages are transient and retry with backoff; bounded exact products only', async () => {
  const f = fixture(), one = f.acquire(); f.sockets[0].callbacks.open(); f.sockets[0].callbacks.message('{}');
  expect(f.read(one.leaseId)).toMatchObject({ connection: 'retrying', issue: 'invalid_data' });
  await vi.advanceTimersByTimeAsync(900); expect(f.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(200); expect(f.sockets).toHaveLength(2);
  expect(() => f.acquire('BTC-USDC')).toThrow('Aliased');
  for (const product of ['ETH-USD', 'SOL-USD', 'ZEC-USD', 'ADA-USD']) f.acquire(product);
  expect(() => f.acquire('LTC-USD')).toThrow('order-book capacity'); expect(f.sockets).toHaveLength(2);
});

test('quiet heartbeats preserve continuity without changing book observation time', async () => {
  const f = fixture(), one = f.acquire(); f.ready(0);
  const observedAt = f.read(one.leaseId)!.book!.observedAt;
  for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(1000); f.heartbeat(0); }
  expect(f.read(one.leaseId)).toMatchObject({ continuity: 'live', book: { observedAt } });
});

test('unconfigured host is gated and shutdown rejects new admission', () => {
  const host = createCoinbaseStreamHost(); hosts.push(host);
  expect(() => host.dispatch({ action: 'acquire', product: 'BTC-USD' }, a)).toThrow('not activated');
  expect(() => host.dispatch({ action: 'read', ids: [], extra: true }, a)).toThrow();
  expect(() => host.dispatch({ action: 'read', ids: [] }, 'invalid')).toThrow();
  host.close(); expect(() => host.dispatch({ action: 'read', ids: [] }, a)).toThrow('stopping');
});

test('public message viewer is bounded, incremental and lease owned', async () => {
  const f = fixture(), lease = f.acquire(); f.ready(0);
  const messages = (client = a, after = 0) => f.host.dispatch({action:'messages',leaseId:lease.leaseId,after},client) as import('../../../src/shared/websocket-sources').WebsocketMessages;
  expect(messages(b).messages).toEqual([]);
  const first = messages(); expect(first.messages.some(row=>row.type==='json')).toBe(true);
  expect(()=>messages()).toThrow('rate limited');
  await vi.advanceTimersByTimeAsync(250);
  expect(messages(a,first.cursor).messages).toEqual([]);
  for(let i=0;i<220;i++) f.heartbeat(0);
  await vi.advanceTimersByTimeAsync(250);
  expect(messages().messages).toHaveLength(200);
  f.host.dispatch({action:'release',ids:[lease.leaseId]},a);
  expect(messages().messages).toEqual([]);
});

test('large validated frames become notices and invalid provider text is never exposed', async () => {
  const f = fixture(), lease = f.acquire();
  f.sockets[0].callbacks.open();
  f.send(0, 'heartbeats', [{current_time:new Date().toISOString(), heartbeat_counter:'1', padding:'x'.repeat(70*1024)}]);
  const read = () => f.host.dispatch({action:'messages',leaseId:lease.leaseId},a) as import('../../../src/shared/websocket-sources').WebsocketMessages;
  const first = read();
  expect(first.messages.at(-1)).toMatchObject({type:'notice'});
  expect(JSON.stringify(first).length).toBeLessThan(1024);
  expect(first.total).toBe(1);
  f.sockets[0].callbacks.message('invalid-provider-text');
  await vi.advanceTimersByTimeAsync(250);
  const next = read();
  expect(next.messages.at(-1)?.type).toBe('close');
  expect(JSON.stringify(next)).not.toContain('invalid-provider-text');
});

test('host valuation returns only fresh live trades and drops the quote on a gap', async()=>{
 const f=fixture();f.acquire();f.ready(0);
 const trade={trade_id:'42',product_id:'BTC-USD',price:'100.5',size:'1',side:'BUY',time:new Date().toISOString()};
 f.send(0,'market_trades',[{type:'snapshot',trades:[trade]}]);
 expect(f.host.price('BTC-USD')).toBeNull();
 f.send(0,'market_trades',[{type:'update',trades:[{...trade,trade_id:'43'}]}]);
 expect(f.host.price('BTC-USD')).toBe('100.5');
 expect(f.host.quotes()).toEqual([{product:'BTC-USD',price:'100.5',eventTime:Date.parse(trade.time)}]);
 expect(f.host.price('ETH-USD')).toBeNull();
 for(let i=0;i<16;i++){await vi.advanceTimersByTimeAsync(1000);f.heartbeat(0);}
 expect(f.host.price('BTC-USD')).toBeNull();
 f.send(0,'market_trades',[{type:'update',trades:[{...trade,trade_id:'44',time:new Date().toISOString()}]}]);
 expect(f.host.price('BTC-USD')).toBe('100.5');
 f.sockets[0].callbacks.error();expect(f.host.price('BTC-USD')).toBeNull();expect(f.host.quotes()).toEqual([]);
});

test('price-only demand supports more than five markets without subscribing to books',async()=>{
 const f=fixture(), products=['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','ADA-USD','XRP-USD','LTC-USD','AVAX-USD'];
 for(const product of products)f.host.dispatch({action:'acquire',product,usage:'holdings'},a,true);
 await vi.advanceTimersByTimeAsync(1000);
 const index=f.sockets.length-1;f.sockets[index].callbacks.open();
 f.send(index,'subscriptions',[{subscriptions:{heartbeats:[],market_trades:products}}]);f.heartbeat(index);
 await vi.advanceTimersByTimeAsync(2000);
 const commands=f.sockets[index].send.mock.calls.map(([raw])=>JSON.parse(raw));
 expect(commands.map(c=>c.channel)).toEqual(['heartbeats','market_trades']);
 expect(commands[1].product_ids).toEqual([...products].sort());
 const inspection=f.host.dispatch({action:'inspect'},b) as import('../../../src/shared/coinbase-stream').CoinbaseStreamInspection;
 expect(inspection.subscriptions).toHaveLength(8);
 expect(inspection.subscriptions.every(item=>item.confirmed&&item.channels.join()==='market_trades'&&item.uses.join()==='holdings')).toBe(true);
 expect(inspection.connection).toBe('live');
 f.host.dispatch({action:'acquire',product:'BTC-USD',mode:'book'},b);
 f.heartbeat(index);await vi.advanceTimersByTimeAsync(2000);f.heartbeat(index);
 // The book is added on the existing socket; no reconnect.
 expect(f.sockets).toHaveLength(index+1);
 expect(f.sockets[index].send.mock.calls.map(([raw])=>JSON.parse(raw)).slice(2)).toEqual([{type:'subscribe',channel:'level2',product_ids:['BTC-USD']}]);
 f.host.dropClient(b);
 await vi.advanceTimersByTimeAsync(2000);
 expect(f.sockets[index].send.mock.calls.map(([raw])=>JSON.parse(raw)).slice(3)).toEqual([{type:'unsubscribe',channel:'level2',product_ids:['BTC-USD']}]);
 expect(f.sockets).toHaveLength(index+1);
});

test('inspection is passive and requested price subscriptions need acknowledgement',()=>{
 const f=fixture();
 const idle=f.host.dispatch({action:'inspect'},b) as import('../../../src/shared/coinbase-stream').CoinbaseStreamInspection;
 expect(idle.subscriptions).toEqual([]);expect(f.sockets).toHaveLength(0);
 const lease=f.host.dispatch({action:'acquire',product:'BTC-USD'},a) as DataLease;
 f.sockets[0].callbacks.open();f.heartbeat(0);
 expect(f.read(lease.leaseId)?.continuity).toBe('unavailable');
});

test('manual reconnect resets retry delay while preserving existing demand',()=>{
 const f=fixture(),lease=f.acquire();f.ready(0);f.sockets[0].callbacks.error();
 expect((f.host.dispatch({action:'inspect'},b) as import('../../../src/shared/coinbase-stream').CoinbaseStreamInspection).issue).toBe('transport');
 f.host.dispatch({action:'reconnect'},b);
 expect(f.sockets).toHaveLength(2);
 f.ready(1);expect(f.read(lease.leaseId)?.continuity).toBe('live');
 f.host.suspend();expect(()=>f.host.dispatch({action:'reconnect'},b)).toThrow('suspended');
});

test('inspection shows deduplicated account labels and latest live trade time',()=>{
 const f=fixture();f.acquire();f.ready(0);
 f.host.setHoldingAccounts([{product:'BTC-USD',account:'Fixture A'},{product:'BTC-USD',account:'Fixture B'},{product:'BTC-USD',account:'Fixture A'}]);
 const time=new Date().toISOString();
 f.send(0,'market_trades',[{type:'update',trades:[{trade_id:'99',product_id:'BTC-USD',price:'100',size:'1',side:'BUY',time}]}]);
 const result=f.host.dispatch({action:'inspect'},b) as import('../../../src/shared/coinbase-stream').CoinbaseStreamInspection;
 expect(result.subscriptions[0]).toMatchObject({accounts:['Fixture A','Fixture B'],lastTick:time});
});

test('source collection edits release disallowed leases and preserve allowed page demand',()=>{
 const f=fixture();
 const held=f.host.dispatch({action:'acquire',product:'BTC-USD',usage:'holdings'},a,true) as DataLease;
 const view=f.host.dispatch({action:'acquire',product:'ETH-USD'},a) as DataLease;
 f.host.configure({enabled:true,collection:'when-open',subscriptions:{holdings:true,views:true,products:[]}});
 expect(f.read(held.leaseId)).toBeNull();
 expect(f.host.dispatch({action:'renew',ids:[view.leaseId]},a)).toHaveLength(1);
 expect(()=>f.host.dispatch({action:'acquire',product:'BTC-USD',usage:'holdings'},a,true)).toThrow('disabled');
 f.host.configure({enabled:false,collection:'off',subscriptions:{holdings:true,views:true,products:[]}});
 expect(f.host.dispatch({action:'renew',ids:[view.leaseId]},a)).toEqual([]);
 expect(()=>f.acquire()).toThrow('disabled');
 expect(f.host.price('BTC-USD')).toBeNull();
 f.host.configure({enabled:true,collection:'automatic',subscriptions:{holdings:true,views:false,products:['SOL-USD']}});
 expect(()=>f.acquire()).toThrow('disabled');
 expect(f.host.dispatch({action:'acquire',product:'SOL-USD',usage:'manual'},a,true)).toHaveProperty('leaseId');
});

test('rule demand shares existing products and exposes fresh metric observations with actual receipt and epoch',async()=>{
 const f=fixture(),lease=f.acquire();f.ready(0);
 const ref={sourceId:'ccbb0000-0000-4000-8000-000000000001',feedId:'price:BTC-USD',configVersion:1,schemaVersion:1};
 f.host.ruleDemand(['BTC-USD']);expect(f.sockets).toHaveLength(1);
 expect(f.host.inputSnapshot({...ref,configVersion:2})).toBeNull();
 expect(f.host.inputSnapshot(ref)?.latest).toBeNull();
 const trade={trade_id:'101',product_id:'BTC-USD',price:'100.123456789',size:'1',side:'BUY',time:new Date().toISOString()};
 f.send(0,'market_trades',[{type:'snapshot',trades:[trade]}]);expect(f.host.inputSnapshot(ref)?.latest).toBeNull();
 f.send(0,'market_trades',[{type:'update',trades:[{...trade,trade_id:'102'}]}]);
 const first=f.host.inputSnapshot(ref)!;expect(first).toMatchObject({quality:'fresh',latest:{payload:{kind:'metric',value:'100.123456789'},receivedAt:Date.now(),origin:'live'}});
 await vi.advanceTimersByTimeAsync(1000);f.heartbeat(0);
 expect(f.host.inputSnapshot(ref)?.latest?.receivedAt).toBe(first.latest?.receivedAt);
 f.send(0,'market_trades',[{type:'update',trades:[{...trade,trade_id:'103',price:'999'}]}]);
 expect(f.host.inputSnapshot(ref)?.latest?.payload).toEqual(first.latest?.payload);
 for(let i=0;i<15;i++){await vi.advanceTimersByTimeAsync(1000);f.heartbeat(0);}
 expect(f.host.inputSnapshot(ref)?.quality).toBe('stale');
 f.sockets[0].callbacks.error();expect(f.host.inputSnapshot(ref)?.latest).toBeNull();
 await vi.advanceTimersByTimeAsync(1000);f.ready(1);
 expect(f.host.inputSnapshot(ref)?.latest).toBeNull();
 f.send(1,'market_trades',[{type:'update',trades:[{...trade,trade_id:'104',time:new Date().toISOString()}]}]);
 expect(f.host.inputSnapshot(ref)?.latest?.epoch).toBeGreaterThan(first.latest!.epoch);
 f.host.ruleDemand([]);expect(f.sockets[1].close).not.toHaveBeenCalled();
 f.host.dispatch({action:'release',ids:[lease.leaseId]},a);expect(f.sockets[1].close).toHaveBeenCalled();
});

test('rule-only markets acquire price subscriptions and respect source collection policy',async()=>{
 const f=fixture();f.host.ruleDemand(['ZEC-USD']);expect(f.sockets).toHaveLength(1);
 const inspection=f.host.dispatch({action:'inspect'},a) as import('../../../src/shared/coinbase-stream').CoinbaseStreamInspection;
 expect(inspection.subscriptions).toMatchObject([{product:'ZEC-USD',uses:['rule'],channels:['market_trades']}]);
 expect(()=>f.host.dispatch({action:'acquire',product:'BTC-USD',usage:'rule'},b)).toThrow();
 f.host.configure({enabled:true,collection:'when-open',subscriptions:{holdings:true,views:true,products:[]}});
 expect(f.sockets[0].close).toHaveBeenCalled();f.host.ruleDemand(['ZEC-USD']);expect(f.sockets).toHaveLength(1);
 f.host.configure({enabled:true,collection:'automatic',subscriptions:{holdings:false,views:false,products:[]}});
 f.host.ruleDemand(['ZEC-USD']);expect(f.sockets).toHaveLength(2);
 f.host.ruleDemand([]);expect(f.sockets[1].close).toHaveBeenCalled();
});

test('renderer dispatch may only acquire view leases; holdings/manual demand needs the trusted host path',()=>{
 const f=fixture();f.host.configure({enabled:true,collection:'automatic',subscriptions:{holdings:true,views:true,products:['SOL-USD']}});
 for(const usage of ['holdings','manual'])expect(()=>f.host.dispatch({action:'acquire',product:'SOL-USD',usage},a)).toThrow('usage unavailable');
 expect(f.host.dispatch({action:'acquire',product:'SOL-USD',usage:'view'},a)).toHaveProperty('leaseId');
 expect(f.host.dispatch({action:'acquire',product:'SOL-USD'},a)).toHaveProperty('leaseId');
 expect(f.host.dispatch({action:'acquire',product:'SOL-USD',usage:'manual'},a,true)).toHaveProperty('leaseId');
});
