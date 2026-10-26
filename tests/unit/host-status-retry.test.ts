import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { hostCall, type HostManifest } from '../../src/main/host-rpc';

async function fixture(work: (context: { host: HostManifest; requests: () => number }) => Promise<void>, behavior = 'reset-once') {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain synthetic request. */ }
    requests++;
    if (behavior === 'reject') { response.setHeader('content-type', 'application/json'); response.end('{"ok":false}'); return; }
    if (requests === 1 || behavior === 'reset-always') { request.socket.destroy(); return; }
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true,"value":[{"provider":"fixture","status":"connected"}]}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  try {
    await work({ host: { port: address.port, token: 'a'.repeat(64), pid: process.pid, build: 'fixture', protocol: 1 }, requests: () => requests });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it.each(['ai:status', 'host:status'])('recovers %s after a real local socket reset', async method => {
  await fixture(async ({ host, requests }) => {
    expect(await hostCall(host, method, [], randomUUID(), 3000)).toEqual([{ provider: 'fixture', status: 'connected' }]);
    expect(requests()).toBe(2);
  });
});
it.each(['orders:confirm', 'settings:credentials:save', 'ai:start', 'gateway:call'])('never replays %s after a reset', async method => {
  await fixture(async ({ host, requests }) => {
    await expect(hostCall(host, method, [], randomUUID(), 3000)).rejects.toThrow();
    expect(requests()).toBe(1);
  });
});
it('bounds retries and surfaces persistent disconnections', async () => {
  await fixture(async ({ host, requests }) => {
    await expect(hostCall(host, 'ai:status', [], randomUUID(), 3000)).rejects.toThrow('connection was interrupted');
    expect(requests()).toBe(2);
  }, 'reset-always');
});
it('does not retry a host-side failure', async () => {
  await fixture(async ({ host, requests }) => {
    await expect(hostCall(host, 'ai:status', [], randomUUID(), 3000)).rejects.toThrow('request failed');
    expect(requests()).toBe(1);
  }, 'reject');
});
