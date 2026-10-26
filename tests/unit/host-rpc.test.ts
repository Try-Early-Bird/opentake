import { expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunCapabilities } from '../../src/main/run-capabilities';
import { hostCall, readHostManifest, startHostRpc } from '../../src/main/host-rpc';

test('host RPC requires its private capability, rejects browser origins, and sanitizes failures', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-rpc-'));
  const host = await startHostRpc(profile, 'test-build', async method => {
    if (method === 'status') return { state: 'ready' };
    throw new Error('synthetic-sensitive-provider-error');
  });
  try {
    expect(await readHostManifest(profile)).toMatchObject({ build: 'test-build', pid: process.pid });
    expect(await hostCall(host.manifest, 'status', [], randomUUID())).toEqual({ state: 'ready' });
    const url = `http://127.0.0.1:${host.manifest.port}/rpc`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${host.manifest.token}`, origin: 'http://attacker.test' } })).status).toBe(403);
    await expect(hostCall(host.manifest, 'unknown', [], randomUUID())).rejects.toThrow('The host is responding');
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${host.manifest.token}` }, body: JSON.stringify({ method: 'unknown', args: [], clientId: randomUUID() }) });
    expect(await response.text()).not.toContain('synthetic-sensitive');
  } finally { await host.close(); await rm(profile, { recursive: true, force: true }); }
});


test('run capabilities authorize only their active run gateway, never management or another run', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-run-rpc-'));
  let active = true;
  let time = 0;
  const run = randomUUID();
  const grants = createRunCapabilities(id => active && id === run, () => time);
  const grant = grants.issue(run, randomUUID());
  const seen: string[] = [];
  const host = await startHostRpc(profile, 'test-build', async method => { seen.push(method); return []; }, grants.authorize);
  const scoped = { ...host.manifest, token: grant.token };
  try {
    expect(await hostCall(scoped, 'gateway:list', [run], randomUUID())).toEqual([]);
    expect(await hostCall(scoped, 'gateway:instructions', [run], randomUUID())).toEqual([]);
    await expect(hostCall(scoped, 'gateway:instructions', [randomUUID()], randomUUID())).rejects.toThrow();
    await expect(hostCall(scoped, 'settings:credentials:list', [], randomUUID())).rejects.toThrow();
    await expect(hostCall(scoped, 'gateway:call', [randomUUID(), 'tool', {}], randomUUID())).rejects.toThrow();
    await expect(hostCall(host.manifest, 'gateway:list', [run], randomUUID())).rejects.toThrow();
    active = false;
    await expect(hostCall(scoped, 'gateway:list', [run], randomUUID())).rejects.toThrow();
    active = true;
    time = 600_000;
    await expect(hostCall(scoped, 'gateway:list', [run], randomUUID())).rejects.toThrow();
    time = 0;
    grant.revoke();
    await expect(hostCall(scoped, 'gateway:list', [run], randomUUID())).rejects.toThrow();
    await expect(hostCall(scoped, 'gateway:instructions', [run], randomUUID())).rejects.toThrow();
    expect(seen).toEqual(['gateway:list','gateway:instructions']);
  } finally { await host.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const method of ['strategies:read','strategies:available','notifications:navigation']) test(`host RPC retries one reset for ${method}`, async () => {
 const reset = new TypeError('fetch failed', {cause: Object.assign(new Error('reset'), {code:'ECONNRESET'})});
 const fetchMock = vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(reset).mockResolvedValueOnce(new Response(JSON.stringify({ok:true,value:{ready:true}})));
 try {
  expect(await hostCall({port:1,token:'synthetic',pid:1,protocol:1,build:'test'},method,[],randomUUID())).toEqual({ready:true});
  expect(fetchMock).toHaveBeenCalledTimes(2);
 } finally { fetchMock.mockRestore(); }
});
test('host RPC bounds read retries and never replays submissions', async () => {
 const reset = new TypeError('fetch failed', {cause: Object.assign(new Error('reset'), {code:'ECONNRESET'})});
 const fetchMock = vi.spyOn(globalThis,'fetch').mockRejectedValue(reset);
 const host={port:1,token:'synthetic',pid:1,protocol:1 as const,build:'test'};
 try {
  await expect(hostCall(host,'strategies:read',[],randomUUID())).rejects.toThrow('Background host connection was interrupted');
  expect(fetchMock).toHaveBeenCalledTimes(2);fetchMock.mockClear();
  await expect(hostCall(host,'strategies:submit-coinbase-orders',[],randomUUID())).rejects.toThrow('fetch failed');
  expect(fetchMock).toHaveBeenCalledTimes(1);
 } finally { fetchMock.mockRestore(); }
});
