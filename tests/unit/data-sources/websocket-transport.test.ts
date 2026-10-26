import { once, EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer, type ClientOptions } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceWebsocketTransport } from '../../../src/main/data-sources/websocket/transport';
const config = {
  endpoint: 'wss://feed.example.test/prices', auth: { mode: 'none' },
  subscription: { body: { op: 'subscribe' } },
  acknowledgement: { success: { path: ['op'], equals: 'subscribed' }, failure: { path: ['op'], equals: 'denied' } },
};
const callbacks = () => ({ ready: vi.fn(), data: vi.fn(), failed: vi.fn() });
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); vi.useRealTimers(); });
async function fixture(authenticated = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); if (typeof address === 'string') throw Error();
  let options!: ClientOptions;
  const received: string[] = [];
  server.on('connection', peer => peer.on('message', data => received.push(String(data))));
  const credential = vi.fn(async () => ({ endpoint: config.endpoint, generation: '1', kind: 'message' as const, value: 'fixture-secret-only' }));
  const transport = createSourceWebsocketTransport({ credential, resolve: publicDns, makeSocket: (_url, opts) => {
    options = opts;
    // Only this test constructor substitutes loopback; production always uses WSS.
    return new WebSocket(`ws://127.0.0.1:${address.port}`, { ...opts, agent: undefined, family: 4 });
  } });
  const cb = callbacks(), abort = new AbortController();
  const connected = once(server, 'connection');
  const connection = transport.connect('fixture', authenticated ? { ...config, auth: {
    mode: 'login', credentialId: '00000000-0000-4000-8000-000000000001',
    message: { body: { op: 'login', token: null }, secretPaths: [['token']] },
    acknowledgement: { success: { path: ['op'], equals: 'logged-in' }, failure: { path: ['op'], equals: 'expired' } },
  } } : config, abort.signal, cb);
  cleanups.push(async () => { connection.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(done => server.close(() => done())); });
  const [peer] = await connected as [WebSocket];
  await vi.waitFor(() => expect(received).toHaveLength(1));
  return { peer, cb, options, received, connection, abort, credential };
}
test('public stream pins DNS and delivers actual JSON only after subscription acknowledgment', async () => {
  const f = await fixture();
  expect(f.options).toMatchObject({ rejectUnauthorized: true, followRedirects: false, perMessageDeflate: false, maxPayload: 262144 });
  expect(f.options.agent!.options.servername).toBe('feed.example.test');
  const pinned = vi.fn(); (f.options.agent!.options.lookup as Function)('ignored', {}, pinned);
  expect(pinned).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  expect(f.credential).not.toHaveBeenCalled();
  f.peer.send(JSON.stringify({ price: 1 })); f.peer.send(JSON.stringify({ op: 'subscribed' })); f.peer.send(JSON.stringify({ symbol: 'BTC-USD', price: '123.45' }));
  await vi.waitFor(() => expect(f.cb.data).toHaveBeenCalledExactlyOnceWith({ symbol: 'BTC-USD', price: '123.45' }));
  expect(f.cb.ready).toHaveBeenCalledOnce(); expect(f.cb.failed).not.toHaveBeenCalled();
  f.abort.abort(); f.peer.send(JSON.stringify({ price: 2 }));
  await new Promise(done => setTimeout(done, 20)); expect(f.cb.data).toHaveBeenCalledOnce();
});
test('login precedes subscription, data arrives, and credential expiry stops the socket', async () => {
  const f = await fixture(true);
  expect(JSON.parse(f.received[0])).toEqual({ op: 'login', token: 'fixture-secret-only' });
  f.peer.send('{"op":"logged-in"}'); await vi.waitFor(() => expect(f.received).toHaveLength(2));
  expect(JSON.parse(f.received[1])).toEqual({ op: 'subscribe' });
  f.peer.send('{"op":"subscribed"}'); f.peer.send('{"price":42}');
  await vi.waitFor(() => expect(f.cb.data).toHaveBeenCalledExactlyOnceWith({ price: 42 }));
  f.peer.send('{"op":"expired"}');
  await vi.waitFor(() => expect(f.cb.failed).toHaveBeenCalledExactlyOnceWith('authentication'));
});
test.each(['binary', 'oversize', 'echo'])('rejects %s messages without observations', async mode => {
  const f = await fixture(true);
  f.peer.send('{"op":"logged-in"}'); await vi.waitFor(() => expect(f.received).toHaveLength(2));
  f.peer.send('{"op":"subscribed"}'); await vi.waitFor(() => expect(f.cb.ready).toHaveBeenCalledOnce());
  if (mode === 'binary') f.peer.send(Buffer.from('{}'));
  else if (mode === 'oversize') f.peer.send('a'.repeat(262145));
  else f.peer.send('{"token":"fixture-secret-only"}');
  await vi.waitFor(() => expect(f.cb.failed).toHaveBeenCalledOnce()); expect(f.cb.data).not.toHaveBeenCalled();
});
test('mixed public/private DNS is rejected before resolving credentials or opening socket', async () => {
  const credential = vi.fn(), makeSocket = vi.fn(), cb = callbacks();
  createSourceWebsocketTransport({ credential, makeSocket, resolve: async () => [...await publicDns(), { address: '127.0.0.1', family: 4 }] }).connect('one', config, new AbortController().signal, cb);
  await vi.waitFor(() => expect(cb.failed).toHaveBeenCalledWith('destination'));
  expect(credential).not.toHaveBeenCalled(); expect(makeSocket).not.toHaveBeenCalled();
});
test('pending setup times out, releases capacity and fences late DNS completion', async () => {
  vi.useFakeTimers();
  let finish!: (value: Awaited<ReturnType<typeof publicDns>>) => void;
  const makeSocket = vi.fn(), cb = callbacks();
  const transport = createSourceWebsocketTransport({ credential: vi.fn(), makeSocket, resolve: () => new Promise(done => { finish = done; }) });
  transport.connect('one', config, new AbortController().signal, cb);
  const duplicate = callbacks(); transport.connect('one', config, new AbortController().signal, duplicate);
  await Promise.resolve(); expect(duplicate.failed).toHaveBeenCalledWith('capacity');
  await vi.advanceTimersByTimeAsync(10000); expect(cb.failed).toHaveBeenCalledWith('timeout');
  finish(await publicDns()); await Promise.resolve(); expect(makeSocket).not.toHaveBeenCalled();
  const retry = callbacks(); const next = transport.connect('one', config, new AbortController().signal, retry);
  await Promise.resolve(); expect(retry.failed).not.toHaveBeenCalled(); next.close();
  expect(vi.getTimerCount()).toBe(0);
});
test('abort during credential resolution releases the slot and prevents late socket creation', async () => {
  let finish!: (value: { endpoint: string; generation: string; kind: 'bearer'; value: string }) => void;
  const credential = vi.fn(() => new Promise<{ endpoint: string; generation: string; kind: 'bearer'; value: string }>(done => { finish = done; }));
  const makeSocket = vi.fn(), cb = callbacks(), abort = new AbortController();
  const transport = createSourceWebsocketTransport({ credential, makeSocket, resolve: publicDns });
  transport.connect('one', { ...config, auth: { mode: 'header', credentialId: '00000000-0000-4000-8000-000000000001' } }, abort.signal, cb);
  await vi.waitFor(() => expect(credential).toHaveBeenCalledOnce());
  abort.abort(); finish({ endpoint: config.endpoint, generation: '1', kind: 'bearer', value: 'fixture-only' });
  await new Promise(done => setTimeout(done, 20));
  expect(makeSocket).not.toHaveBeenCalled(); expect(cb.failed).not.toHaveBeenCalled();
  const next = transport.connect('one', config, new AbortController().signal, cb); next.close();
  expect(cb.failed).not.toHaveBeenCalled();
});

test('matched pong reports health; missing pong times out and clears heartbeat timers', async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), ping: vi.fn(), terminate: vi.fn() });
  const cb = { ...callbacks(), heartbeat: vi.fn() };
  const transport = createSourceWebsocketTransport({ credential: vi.fn(), resolve: publicDns, makeSocket: () => socket as unknown as WebSocket });
  const connection = transport.connect('heartbeat', config, new AbortController().signal, cb);
  cleanups.push(() => connection.close());
  await vi.advanceTimersByTimeAsync(0);
  socket.emit('open'); socket.emit('message', Buffer.from('{"op":"subscribed"}'), false);
  await vi.advanceTimersByTimeAsync(15000); expect(socket.ping).toHaveBeenCalledOnce();
  socket.emit('pong', Buffer.from('wrong')); expect(cb.heartbeat).not.toHaveBeenCalled();
  socket.emit('pong', Buffer.from(socket.ping.mock.calls[0][0])); expect(cb.heartbeat).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15000); expect(cb.failed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000); expect(cb.failed).toHaveBeenCalledExactlyOnceWith('timeout');
  expect(socket.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

test('custom WSS transport: ws hands the custom https.Agent pinned DNS lookup to the TLS connection', async () => {
  // Fixture only: the real ws client and real Agent run, but the Agent's connection factory is captured
  // and fails locally, so no DNS query or network connection is made.
  const { Socket } = await import('node:net');
  let captured: Record<string, unknown> | undefined, agentLookup: unknown;
  const failed = vi.fn();
  const transport = createSourceWebsocketTransport({ credential: vi.fn(), resolve: async () => [{ address: '8.8.4.4', family: 4 }], makeSocket: (url, options) => {
    const agent = options.agent as import('node:https').Agent & { options: Record<string, unknown>; createConnection(opts: Record<string, unknown>): unknown };
    agentLookup = agent.options.lookup;
    agent.createConnection = opts => { captured = opts; const socket = new Socket(); queueMicrotask(() => socket.destroy(Error('fixture connection refused'))); return socket; };
    return new WebSocket(url, options);
  } });
  const abort = new AbortController(); cleanups.push(() => abort.abort());
  transport.connect('pinned', config, abort.signal, { ready: vi.fn(), data: vi.fn(), failed });
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith('transport'));
  expect(captured).toMatchObject({ host: 'feed.example.test', servername: 'feed.example.test', family: 4, rejectUnauthorized: true });
  expect(captured!.lookup).toBe(agentLookup);
  const resolved = await new Promise(done => (captured!.lookup as (host: string, options: unknown, callback: (...args: unknown[]) => void) => void)('feed.example.test', {}, (...args) => done(args)));
  expect(resolved).toEqual([null, '8.8.4.4', 4]);
});
