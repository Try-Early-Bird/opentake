import { once } from 'node:events';
import WebSocket, { WebSocketServer, type ClientOptions } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { createCoinbasePublicTransport } from '../../../src/main/data-sources/coinbase-stream/transport';
import { coinbaseStreamUrl } from '../../../src/main/data-sources/coinbase-stream/session';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(limit = 128) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); if (typeof address === 'string') throw Error('Fixture address');
  let options!: ClientOptions, url!: string;
  const transport = createCoinbasePublicTransport((requested, config) => { url = requested; options = config; return new WebSocket(`ws://127.0.0.1:${address.port}`, config); });
  const callbacks = { open: vi.fn(), message: vi.fn(), error: vi.fn(), close: vi.fn() };
  const connection = once(server, 'connection');
  const socket = transport.connect({ url: coinbaseStreamUrl, maxFrameBytes: limit }, callbacks);
  const [peer] = await connection as [WebSocket];
  cleanups.push(async () => { socket.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await vi.waitFor(() => expect(callbacks.open).toHaveBeenCalledTimes(1));
  return { socket, peer, callbacks, options, url };
}
test('fixed public transport disables compression/redirects and validates text before delivery', async () => {
  const f = await fixture();
  expect(f.url).toBe(coinbaseStreamUrl);
  expect(f.options).toMatchObject({ maxPayload: 128, perMessageDeflate: false, followRedirects: false, rejectUnauthorized: true, handshakeTimeout: 10_000 });
  expect(f.options.headers).toBeUndefined();
  f.peer.send('{"channel":"fixture"}'); await vi.waitFor(() => expect(f.callbacks.message).toHaveBeenCalledWith('{"channel":"fixture"}'));
  const incoming = once(f.peer, 'message'); f.socket.send('{"type":"subscribe"}');
  expect(String((await incoming)[0])).toBe('{"type":"subscribe"}');
  expect(() => f.socket.send('a'.repeat(2049))).toThrow('unavailable');
});
test.each(['whole', 'fragmented', 'binary'])('%s payload is rejected without message delivery', async mode => {
  const f = await fixture(32);
  if (mode === 'fragmented') { f.peer.send('a'.repeat(24), { fin: false }); f.peer.send('b'.repeat(24), { fin: true }); }
  else if (mode === 'binary') f.peer.send(Buffer.from('binary'));
  else f.peer.send('a'.repeat(33));
  await vi.waitFor(() => expect(f.callbacks.error).toHaveBeenCalledTimes(1)); expect(f.callbacks.message).not.toHaveBeenCalled();
});
test('unsupported endpoints and budgets fail before any network construction', () => {
  const factory = vi.fn(), transport = createCoinbasePublicTransport(factory);
  const callbacks = { open: vi.fn(), message: vi.fn(), error: vi.fn(), close: vi.fn() };
  expect(() => transport.connect({ url: 'wss://other.test' as typeof coinbaseStreamUrl, maxFrameBytes: 1024 }, callbacks)).toThrow();
  expect(() => transport.connect({ url: coinbaseStreamUrl, maxFrameBytes: 0 }, callbacks)).toThrow();
  expect(factory).not.toHaveBeenCalled();
});
