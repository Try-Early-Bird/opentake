import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedScanExecutor, createManagedScanStore, type ManagedScanAdapter } from '../../src/main/search/managed-scans';

const scope = { venue: 'robinhood', instance: 'fixture', connectionId: 'connection', accountId: 'account' };
const definition = { filters: [{ filter_type: 'price', predicate: '>', values: ['5'] }], sorting_column: 'price', sorting_direction: 'desc' };
const profiles: string[] = [];
afterEach(async () => { await Promise.all(profiles.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'search-managed-scans-')); profiles.push(profile);
  const store = createManagedScanStore(profile);
  const scans = new Map<string, { id: string; title: string; writable: boolean; providerManaged: boolean }>();
  const events: string[] = [];
  const adapter = {
    recoveryCandidates: vi.fn(async (_scope, title) => [...scans.values()].filter(s => s.title === title)),
    validate: vi.fn(async () => { events.push('validate'); }),
    inspect: vi.fn(async (_scope, id) => scans.get(id) ?? null),
    create: vi.fn(async (_scope, title) => {
      const id = `scan-${scans.size + 1}`;
      scans.set(id, { id, title, writable: true, providerManaged: false }); events.push('create'); return { id };
    }),
    replaceFilters: vi.fn(async (_scope, _id, filters) => { events.push(`filters:${filters[0].values[0]}`); }),
    replaceSorting: vi.fn(async () => { events.push('sort'); }),
    run: vi.fn(async () => { events.push('run'); return { rows: ['fixture'] }; }),
  } satisfies ManagedScanAdapter<{ rows: string[] }>;
  const executor = createManagedScanExecutor({ store, adapter });
  const controller = new AbortController();
  const authorize = vi.fn(async () => {});
  const request = { scope, definition, signal: controller.signal, authorize };
  return { profile, store, scans, events, adapter, executor, controller, authorize, request };
}

test('persists ownership and reuses its ID after restart, replacing filters and sorting each time', async () => {
  const f = await fixture();
  await expect(f.executor.run(f.request)).resolves.toEqual({ rows: ['fixture'] });
  expect(f.events).toEqual(['validate', 'create', 'filters:5', 'sort', 'run']);
  const restored = createManagedScanExecutor({ store: createManagedScanStore(f.profile), adapter: f.adapter });
  await restored.run({ ...f.request, definition: { ...definition, filters: [{ ...definition.filters[0], values: ['10'] }] } });
  expect(f.adapter.create).toHaveBeenCalledOnce();
  expect(f.events.slice(-4)).toEqual(['validate', 'filters:10', 'sort', 'run']);
  expect(f.adapter.inspect).toHaveBeenLastCalledWith(scope, 'scan-1', f.controller.signal, expect.objectContaining({ sorting_column: 'price' }));
});

test('persists creation intent before dispatch and blocks retries after a lost create response', async () => {
  const f = await fixture();
  f.adapter.create.mockImplementation(async () => {
    expect((await createManagedScanStore(f.profile).read(scope))?.state.kind).toBe('creating');
    throw new Error('Transport lost the response');
  });
  await expect(f.executor.run(f.request)).rejects.toThrow('Transport lost');
  const restarted = createManagedScanExecutor({ store: createManagedScanStore(f.profile), adapter: f.adapter });
  await expect(restarted.run(f.request)).rejects.toThrow('unresolved outcome');
  expect(f.adapter.create).toHaveBeenCalledOnce();
  expect(f.adapter.replaceFilters).not.toHaveBeenCalled();
});

test('a known create ID is saved even when cancellation arrives during the write', async () => {
  const f = await fixture();
  f.adapter.create.mockImplementation(async () => { f.controller.abort(); return { id: 'created-despite-abort' }; });
  await expect(f.executor.run(f.request)).rejects.toThrow();
  expect((await createManagedScanStore(f.profile).read(scope))?.state).toEqual({ kind: 'owned', id: 'created-despite-abort' });
  expect(f.adapter.replaceFilters).not.toHaveBeenCalled();
});

test('never adopts same-title scans and refuses missing, renamed, read-only or provider-managed ownership', async () => {
  const f = await fixture();
  f.scans.set('unrelated', { id: 'unrelated', title: 'Opentake · Ask Agent', writable: true, providerManaged: false });
  await f.executor.run(f.request);
  expect(f.adapter.replaceFilters.mock.calls[0][1]).toBe('scan-2');
  const remote = f.scans.get('scan-2')!;
  for (const replacement of [null, { ...remote, title: 'Renamed' }, { ...remote, writable: false }, { ...remote, providerManaged: true }, { ...remote, id: 'unrelated' }]) {
    f.adapter.inspect.mockResolvedValueOnce(replacement);
    await expect(f.executor.run(f.request)).rejects.toThrow('ownership could not be verified');
  }
  expect(f.adapter.replaceFilters).toHaveBeenCalledOnce();
  expect(f.adapter.create).toHaveBeenCalledOnce();
});

test('serializes the complete configure-and-run, including cancelled writes still settling', async () => {
  const f = await fixture();
  const entered = deferred<void>(); const finish = deferred<void>();
  f.adapter.replaceFilters.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; f.events.push('first-write-settled'); });
  const first = f.executor.run(f.request);
  const rejected = expect(first).rejects.toThrow();
  await entered.promise;
  f.controller.abort();
  const second = f.executor.run({ ...f.request, signal: new AbortController().signal });
  // Allow promise continuations to run while the cancelled transport is pending.
  await new Promise(resolve => setImmediate(resolve));
  expect(f.adapter.validate).toHaveBeenCalledOnce();
  finish.resolve();
  await rejected; await second;
  expect(f.events).toEqual(['validate', 'create', 'first-write-settled', 'validate', 'filters:5', 'sort', 'run']);
  expect(f.adapter.create).toHaveBeenCalledOnce();
});

test('rechecks revocation between writes and fully replaces configuration on the next request', async () => {
  const f = await fixture();
  f.adapter.replaceFilters.mockImplementationOnce(async () => { f.authorize.mockRejectedValue(new Error('Permission revoked')); });
  await expect(f.executor.run(f.request)).rejects.toThrow('Permission revoked');
  expect(f.adapter.replaceSorting).not.toHaveBeenCalled(); expect(f.adapter.run).not.toHaveBeenCalled();
  f.authorize.mockResolvedValue(undefined);
  await f.executor.run(f.request);
  expect(f.adapter.create).toHaveBeenCalledOnce(); expect(f.adapter.replaceFilters).toHaveBeenCalledTimes(2);
  expect(f.adapter.replaceSorting).toHaveBeenCalledOnce(); expect(f.adapter.run).toHaveBeenCalledOnce();
});

test('rejects arbitrary scan IDs, omitted sort, unsupported filters and cancellation before writes', async () => {
  const f = await fixture();
  for (const invalid of [{ ...definition, scan_id: 'user-owned' }, { filters: definition.filters }, { ...definition, filters: [] }]) {
    await expect(f.executor.run({ ...f.request, definition: invalid })).rejects.toThrow();
  }
  f.adapter.validate.mockRejectedValueOnce(new Error('Unsupported filter'));
  await expect(f.executor.run(f.request)).rejects.toThrow('Unsupported filter');
  f.controller.abort();
  await expect(f.executor.run(f.request)).rejects.toThrow();
  expect(f.adapter.create).not.toHaveBeenCalled();
  expect(await f.store.read(scope)).toBeUndefined();
});

test('a cancelled queued request never reaches the adapter or acquires a screener', async () => {
  const f = await fixture();
  const entered = deferred<void>(); const finish = deferred<void>();
  f.adapter.run.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return { rows: [] }; });
  const first = f.executor.run({ ...f.request, signal: new AbortController().signal });
  await entered.promise;
  const second = f.executor.run({ ...f.request, scope: { ...scope, accountId: 'other' } });
  const rejected = expect(second).rejects.toThrow();
  f.controller.abort(); finish.resolve();
  await first; await rejected;
  expect(f.adapter.validate).toHaveBeenCalledOnce();
  expect(await f.store.read({ ...scope, accountId: 'other' })).toBeUndefined();
});

test('failed persistence of the created ID leaves a pending intent across restart', async () => {
  const f = await fixture();
  const save = f.store.save.bind(f.store);
  vi.spyOn(f.store, 'save').mockImplementation(async record => {
    if (record.state.kind === 'owned') throw new Error('Disk full');
    return save(record);
  });
  await expect(f.executor.run(f.request)).rejects.toThrow('Disk full');
  const restarted = createManagedScanExecutor({ store: createManagedScanStore(f.profile), adapter: f.adapter });
  await expect(restarted.run(f.request)).rejects.toThrow('unresolved outcome');
  expect(f.adapter.create).toHaveBeenCalledOnce();
  expect(f.adapter.replaceFilters).not.toHaveBeenCalled();
});

test('scopes ownership to the connection, account, venue and environment', async () => {
  const f = await fixture();
  for (const selected of [scope, { ...scope, accountId: 'other' }, { ...scope, connectionId: 'other' }, { ...scope, instance: 'other' }, { ...scope, venue: 'other' }]) {
    await f.executor.run({ ...f.request, scope: selected });
  }
  expect(f.adapter.create).toHaveBeenCalledTimes(5);
  expect((await f.store.read(scope))?.state).toEqual({ kind: 'owned', id: 'scan-1' });
});

test('corrupt ownership fails closed without overwriting evidence or creating another scan', async () => {
  const f = await fixture(); await f.executor.run(f.request);
  const path = join(f.profile, 'search', 'managed-scans.json');
  await writeFile(path, '{invalid');
  await expect(f.executor.run(f.request)).rejects.toThrow('could not be loaded');
  expect(f.adapter.create).toHaveBeenCalledOnce();
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});

test('scope revocation after the run withholds result data', async () => {
  const f = await fixture();
  f.adapter.run.mockImplementation(async () => { f.authorize.mockRejectedValue(new Error('Account changed')); return { rows: ['private-result'] }; });
  await expect(f.executor.run(f.request)).rejects.toThrow('Account changed');
});


test('recovery previews a unique exact title and rechecks identity before local adoption', async () => {
  const f = await fixture();
  const original = f.adapter.create.getMockImplementation()!;
  f.adapter.create.mockImplementation(async (...args) => { await original(...args); throw new Error('Lost response'); });
  await expect(f.executor.run(f.request)).rejects.toThrow('Lost response');
  const preview = await f.executor.recover(f.request);
  expect(preview.status).toBe('ready');
  expect((await f.store.read(scope))?.state.kind).toBe('creating');
  if (preview.status !== 'ready') throw new Error('Missing preview');
  await expect(f.executor.recover({ ...f.request, confirm: { id: 'wrong', title: preview.title } })).rejects.toThrow('changed');
  await f.executor.recover({ ...f.request, confirm: preview });
  expect((await f.store.read(scope))?.state).toEqual({ kind: 'owned', id: preview.id });
  expect(f.adapter.replaceFilters).not.toHaveBeenCalled();
  await f.executor.run(f.request);
  expect(f.adapter.create).toHaveBeenCalledOnce();
});

test('recovery refuses missing, ambiguous, provider-managed, revoked and stale candidates', async () => {
  const f = await fixture(); const title = 'Opentake · Ask Agent · fixture-nonce';
  await f.store.save({ scope, title, state: { kind: 'creating' } });
  expect(await f.executor.recover(f.request)).toEqual({ status: 'missing' });
  const candidate = { id: 'one', title, writable: true, providerManaged: false };
  f.scans.set('one', candidate); f.scans.set('two', { ...candidate, id: 'two' });
  expect(await f.executor.recover(f.request)).toEqual({ status: 'ambiguous' });
  f.scans.delete('two'); f.scans.set('one', { ...candidate, providerManaged: true });
  expect(await f.executor.recover(f.request)).toEqual({ status: 'ambiguous' });
  f.scans.set('one', candidate);
  f.adapter.recoveryCandidates.mockImplementationOnce(async () => { f.authorize.mockRejectedValue(new Error('Revoked')); return [candidate]; });
  await expect(f.executor.recover({ ...f.request, confirm: candidate })).rejects.toThrow('Revoked');
  expect((await f.store.read(scope))?.state.kind).toBe('creating');
  f.authorize.mockResolvedValue(undefined);
  await f.store.save({ scope, title, state: { kind: 'owned', id: 'elsewhere' } });
  await expect(f.executor.recover({ ...f.request, confirm: candidate })).rejects.toThrow('changed');
});

test('recovery waits for an uncertain create transport to settle before inspecting', async () => {
  const f = await fixture(), entered = deferred<void>(), finish = deferred<void>();
  f.adapter.create.mockImplementation(async (_scope, title) => {
    entered.resolve(); await finish.promise;
    f.scans.set('one', { id: 'one', title, writable: true, providerManaged: false });
    throw new Error('Lost response');
  });
  const first = expect(f.executor.run(f.request)).rejects.toThrow('Lost response');
  await entered.promise;
  const recovery = f.executor.recover(f.request);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.adapter.recoveryCandidates).not.toHaveBeenCalled();
  finish.resolve(); await first;
  expect((await recovery).status).toBe('ready');
});
