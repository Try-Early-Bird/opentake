import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDataSourceHostService } from '../../../src/main/data-sources/host-service';
import { startHostRpc, hostCall } from '../../../src/main/host-rpc';
import type { DataLease } from '../../../src/shared/data-sources';
import { definition, fakeWebSocket, sample } from './fixtures';

test('disposable host RPC scopes data leases and sanitizes rejected configuration', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-data-rpc-'));
  const ws = fakeWebSocket(), feed = definition({ adapterId: 'ws' });
  const service = createDataSourceHostService([ws.adapter], [feed]);
  const host = await startHostRpc(profile, 'synthetic-data-host', async (method, args, client) => service.dispatch(method, args, client));
  const a = randomUUID(), b = randomUUID();
  const call = <T>(method: string, args: unknown[] = [], client = a) => hostCall<T>(host.manifest, 'dataSources:' + method, args, client);
  try {
    const ref = { sourceId: feed.sourceId, feedId: feed.feedId, configVersion: 1, schemaVersion: 1 };
    const lease = await call<DataLease>('acquire', [ref]); ws.sessions[0].emit(sample('2'));
    expect(await call('read', [[lease.leaseId]])).toMatchObject([{ snapshot: { quality: 'fresh' } }]);
    expect(await call('read', [[lease.leaseId]], b)).toMatchObject([{ snapshot: null }]);
    await expect(call('acquire', [{ ...ref, secret: 'synthetic-sensitive' }])).rejects.not.toThrow('synthetic-sensitive');
    await call('drop-client'); expect(await call('renew', [[lease.leaseId]])).toEqual([]);
    service.close(); expect(ws.sessions[0].signal.aborted).toBe(true);
    ws.sessions[0].emit(sample('3')); await expect(call('list')).rejects.toThrow();
  } finally { service.close(); await host.close(); await rm(profile, { recursive: true, force: true }); }
});
