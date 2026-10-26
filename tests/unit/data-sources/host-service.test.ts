import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDataSourceHostService } from '../../../src/main/data-sources/host-service';
import type { DataLease, DataLeaseRead } from '../../../src/shared/data-sources';
import { definition, fakeWebSocket, sample } from './fixtures';
const owner = randomUUID(), other = randomUUID();
const feed = definition({ adapterId: 'ws', authScope: 'synthetic-private-scope' });
const ref = { sourceId: feed.sourceId, feedId: feed.feedId, configVersion: 1, schemaVersion: 1 };
const services: ReturnType<typeof createDataSourceHostService>[] = [];
function setup() {
  const ws = fakeWebSocket();
  const service = createDataSourceHostService([ws.adapter], [feed]); services.push(service);
  const call = (method: string, args: unknown[] = [], client = owner) => service.dispatch('dataSources:' + method, args, client);
  const acquire = (client = owner) => call('acquire', [ref], client) as DataLease;
  return { ws, service, call, acquire };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.useRealTimers(); });

test('two clients share collection; catalog and snapshot omit host-only configuration', () => {
  const { ws, call, acquire } = setup(); const a = acquire(), b = acquire(other);
  expect(ws.sessions).toHaveLength(1); ws.sessions[0].emit(sample());
  const result = call('read', [[a.leaseId]]) as DataLeaseRead[];
  expect(result[0].snapshot?.quality).toBe('fresh');
  expect(JSON.stringify([call('list'), result])).not.toContain('synthetic-private-scope');
  expect(call('read', [[b.leaseId]], other)).toMatchObject([{ snapshot: { quality: 'fresh' } }]);
});
test('foreign clients cannot read, renew or release a lease; unknown and prior-host IDs are harmless', () => {
  const { call, acquire } = setup(); const a = acquire();
  expect(call('read', [[a.leaseId]], other)).toEqual([{ leaseId: a.leaseId, snapshot: null }]);
  expect(call('renew', [[a.leaseId]], other)).toEqual([]);
  call('release', [[a.leaseId]], other);
  expect(call('renew', [[a.leaseId]])).toHaveLength(1);
  expect(call('renew', [[randomUUID()]])).toEqual([]);
  expect(call('release', [[randomUUID()]])).toBeNull();
});
test('expiry stops abandoned collection without another request and cannot be renewed late', async () => {
  const { ws, call, acquire } = setup(); const a = acquire();
  await vi.advanceTimersByTimeAsync(35_100);
  expect(ws.disposals()).toBe(1); expect(vi.getTimerCount()).toBe(0);
  expect(call('renew', [[a.leaseId]])).toEqual([]);
  expect(call('read', [[a.leaseId]])).toEqual([{ leaseId: a.leaseId, snapshot: null }]);
});
test('renewal extends only the owned lease; dropping one client preserves the other', async () => {
  const { ws, call, acquire } = setup(); const a = acquire(), b = acquire(other);
  await vi.advanceTimersByTimeAsync(20_000); call('renew', [[b.leaseId]], other);
  call('drop-client'); await vi.advanceTimersByTimeAsync(15_000);
  expect(ws.disposals()).toBe(0); expect(call('renew', [[a.leaseId]])).toEqual([]);
  call('release', [[b.leaseId]], other); await vi.advanceTimersByTimeAsync(5100);
  expect(ws.disposals()).toBe(1);
});
test('read batches are bounded and rate limited independently per client; reads never renew', async () => {
  const { call, acquire } = setup(); const a = acquire(), b = acquire(other);
  call('read', [[a.leaseId]]);
  expect(() => call('read', [[a.leaseId]])).toThrow('rate limited');
  expect(() => call('read', [[b.leaseId]], other)).not.toThrow();
  await vi.advanceTimersByTimeAsync(250); expect(() => call('read', [[a.leaseId]])).not.toThrow();
  expect(() => call('read', [Array.from({ length: 33 }, () => randomUUID())])).toThrow();
  expect(() => call('read', [[a.leaseId, a.leaseId]])).toThrow();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(call('read', [[a.leaseId]])).toMatchObject([{ snapshot: null }]);
});
test('only registered references are accepted; UI cannot choose auth scope or durable demand', () => {
  const { call } = setup();
  for (const input of [{ ...ref, authScope: 'private' }, { ...ref, demand: 'durable' }, { ...ref, endpoint: 'https://example.test' }, { ...ref, configVersion: 2 }]) {
    expect(() => call('acquire', [input])).toThrow();
  }
  expect(() => call('acquire', [ref, 'extra'])).toThrow();
});
test('suspend revokes UI leases, resume needs a new acquisition, close fences late provider updates', () => {
  const { ws, call, acquire, service } = setup(); const a = acquire();
  service.suspend(); expect(ws.disposals()).toBe(1);
  expect(() => acquire()).toThrow('suspended'); expect(call('renew', [[a.leaseId]])).toEqual([]);
  service.resume(); const b = acquire();
  ws.sessions[0].emit(sample('42')); expect(call('read', [[b.leaseId]])).toMatchObject([{ snapshot: { latest: null } }]);
  service.close(); ws.sessions.at(-1)!.emit(sample('9'));
  expect(ws.disposals()).toBe(2); expect(vi.getTimerCount()).toBe(0);
  expect(() => call('list')).toThrow('stopping');
});
test('global lease cap bounds clients and timers; empty production catalog does not collect', () => {
  const { acquire } = setup();
  for (let i = 0; i < 128; i++) acquire(randomUUID());
  expect(() => acquire()).toThrow('capacity');
  const empty = createDataSourceHostService(); services.push(empty);
  expect(empty.dispatch('dataSources:list', [], owner)).toEqual([]);
  expect(() => empty.dispatch('dataSources:acquire', [ref], owner)).toThrow('unavailable');
});
test('catalog update replaces only changed feeds and keeps unchanged leases and sockets', () => {
  const ws = fakeWebSocket(), second = definition({ adapterId: 'ws', sourceId: 'second' });
  const service = createDataSourceHostService([ws.adapter], [feed, second]); services.push(service);
  const a = service.dispatch('dataSources:acquire', [ref], owner) as DataLease;
  const b = service.dispatch('dataSources:acquire', [{ ...ref, sourceId: 'second' }], owner) as DataLease;
  expect(ws.sessions).toHaveLength(2);
  service.update([feed, { ...second, configVersion: 2 }]);
  expect(ws.disposals()).toBe(1); expect(ws.sessions[0].signal.aborted).toBe(false); expect(ws.sessions[1].signal.aborted).toBe(true);
  expect(service.dispatch('dataSources:renew', [[a.leaseId, b.leaseId]], owner)).toMatchObject([{ leaseId: a.leaseId }]);
  expect(() => service.update([feed, feed])).toThrow('Duplicate'); // Rejected catalogs leave the running one intact.
  expect(service.dispatch('dataSources:renew', [[a.leaseId]], owner)).toHaveLength(1);
});
test('rule reads wake on runtime events rather than polling', async () => {
  const ws = fakeWebSocket(); const service = createDataSourceHostService([ws.adapter], [feed]); services.push(service);
  const accept = vi.fn(async () => true);
  const pending = service.ruleRead(ref, 'next', 5000, new AbortController().signal, accept);
  await vi.advanceTimersByTimeAsync(1000); expect(accept).not.toHaveBeenCalled();
  ws.sessions[0].emit(sample('5'));
  expect(await pending).toMatchObject({ quality: 'fresh', latest: { payload: { value: '5' } } }); expect(accept).toHaveBeenCalledOnce();
  const timeout = service.ruleRead(ref, 'next', 300, new AbortController().signal), rejected = expect(timeout).rejects.toThrow('unavailable');
  await vi.advanceTimersByTimeAsync(300); await rejected;
});
