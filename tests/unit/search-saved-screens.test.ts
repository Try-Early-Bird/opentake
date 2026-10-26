import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSavedScreens } from '../../src/main/search/saved-screens';
import { createSearchAgentService } from '../../src/main/search/agent-service';
import { createRobinhoodScreening } from '../../src/main/search/robinhood-screening';
import { defaultSearchSettings, type SearchSettings } from '../../src/shared/search-settings';

const scope = { venue: 'robinhood', instance: 'production', connectionId: 'fixture', accountId: 'one' };
const definition = { filters: [{ filter_type: 'PRICE', predicate: '>', values: ['5'] }], sorting_column: 'Market cap', sorting_direction: 'desc' as const };
const source = { adapterVersion: 1 as const, scope, definition };
const profiles: string[] = [];
afterEach(async () => { await Promise.all(profiles.splice(0).map(profile => rm(profile, { recursive: true, force: true }))); });
async function profile() { const path = await mkdtemp(join(tmpdir(), 'saved-screen-')); profiles.push(path); return path; }
const record = () => ({ originRunId: randomUUID(), title: 'Over $5', question: 'Find stocks over $5', selection: { provider: 'claude' as const, model: 'fixture' }, sources: [source] });
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out'); }

test('saved definitions survive restart, use explicit scope, and save retries do not duplicate a run', async () => {
  const path = await profile(), store = createSavedScreens(path), input = record();
  const saved = await store.save(input);
  const renamed = await store.save({ ...input, title: 'My screen' });
  expect(renamed.id).toBe(saved.id);
  const restarted = createSavedScreens(path);
  expect(await restarted.list()).toHaveLength(1);
  expect(await restarted.get(saved.id)).toMatchObject({ title: 'My screen', includeNewVenues: false, sources: [source] });
  expect(JSON.stringify(await restarted.list())).not.toContain('connectionId');
  expect(JSON.stringify(await restarted.list())).not.toContain('accountId');
  await restarted.remove(saved.id); expect(await restarted.list()).toEqual([]);
});

test('corrupt or future definitions are not overwritten and unsupported schema versions cannot be saved', async () => {
  const path = await profile(), store = createSavedScreens(path);
  await store.save(record());
  const file = join(path, 'search', 'saved-screens.json');
  const before = await readFile(file, 'utf8');
  expect(() => store.save({ ...record(), sources: [{ ...source, adapterVersion: 2 }] } as any)).toThrow();
  expect(await readFile(file, 'utf8')).toBe(before);
  await writeFile(file, '{invalid');
  await expect(store.list()).rejects.toThrow('could not be loaded');
  await expect(store.save(record())).rejects.toThrow('could not be loaded');
  expect(await readFile(file, 'utf8')).toBe('{invalid');
});

test('concurrent local saves preserve both definitions', async () => {
  const store = createSavedScreens(await profile());
  const saved = await Promise.all([store.save(record()), store.save(record())]);
  expect(new Set(saved.map(s => s.id)).size).toBe(2);
  expect(await store.list()).toHaveLength(2);
});

async function fixture() {
  const path = await profile(); let account = 'one', title = '';
  let settings: SearchSettings = { ...defaultSearchSettings(), selection: { provider: 'claude', model: 'fixture' } };
  let supported = true, connected = true;
  const scanTool = vi.fn(async (_scope, operation, input, signal, authorize) => {
    await authorize(); signal.throwIfAborted();
    if (operation === 'get_scanner_filter_specs') return { filter_specs: [{ filter_type: supported ? 'PRICE' : 'CHANGED', display_name: 'Price', value_type: 'DECIMAL', unit_type: 'DOLLAR', supported_predicates: ['>'] }] };
    if (operation === 'create_scan') { title = input.title; return { scan_id: 'managed' }; }
    if (operation === 'get_scans') return { scans: [{ scan_id: 'managed', title, cortex_managed: false, columns: [{ display_name: 'Market cap' }] }] };
    if (operation === 'run_scan') return { result: { scan_id: 'managed', sorted_by: 'Market cap desc', total_items: 1, results: [{ ticker: 'FIX', instrument_id: 'fixture', instrument_type: 'EQUITY' }] } };
    return {};
  });
  const store = createSavedScreens(path);
  const screening = createRobinhoodScreening(path, { scanScope: async () => ({ ...scope, accountId: account }), scanTool });
  const audit = { start: vi.fn(async () => ({ traceId: 'fixture', runId: 'fixture' })), record: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
  const models = vi.fn(async () => ({ ok: true as const, models: [{ value: 'fixture', label: 'Fixture' }], source: 'catalog' as const }));
  let service: ReturnType<typeof createSearchAgentService>;
  let response = '';
  const execute = vi.fn(async (runtime: any) => {
    response = JSON.stringify(await service.gateway('gateway:call', runtime.id, 'robinhood_search_screen', definition));
  });
  service = createSearchAgentService({ settings: async () => settings, models, budgets: async () => ({ claudeCostUsd: null }), audit,
    savedScreens: store, screening, execute, port: () => 12345,
    // Replay must not prompt to share data with an AI provider, even when enabled.
    sharing: async () => ({ verify: settings.selection === null, revision: 1, scope: account }),
    policies: async () => ['robinhood_search', 'robinhood_search_screen', 'robinhood_get_scanner_filter_specs', 'robinhood_get_scans', 'robinhood_run_scan'].map(name => ({ server: '00000000-0000-4000-8000-000000000001', name, fingerprint: name, revision: 1, policy: 'allowed' as const })),
    adapter: { id: 'robinhood', label: 'Robinhood', status: async () => ({ id: 'robinhood', label: 'Robinhood', connected, capabilities: { lookup: true, details: true, screening: true } }), lookup: async () => ({ markets: [], truncated: false }), owns: () => true, resolve: async () => null },
  });
  const approve = async (id: string, allow = true) => {
    await until(() => service.snapshot(id, 'owner').approvals.length > 0);
    const item = service.snapshot(id, 'owner').approvals[0];
    expect(item.title).toContain('manage a Robinhood screener');
    await service.decide(id, item.id, allow, 'owner');
    await until(() => service.snapshot(id, 'owner').state !== 'running');
  };
  return { path, service, store, models, execute, audit, scanTool, approve, response: () => response,
    noModel: () => { settings = { ...settings, selection: null }; },
    account: (value: string) => { account = value; },
    unsupported: () => { supported = false; }, disconnect: () => { connected = false; },
    block: () => { settings.permissions.managedScreeners = 'blocked'; },
  };
}

test('only successful owner-scoped screens can be saved; replay needs no model and retains permission approval', async () => {
  const f = await fixture();
  try {
    const run = await f.service.start({ question: 'Find stocks over $5', sources: ['robinhood'] }, 'owner');
    await expect(f.service.save(run, 'Early', 'owner')).rejects.toThrow('Complete a new screen');
    await f.approve(run);
    expect(f.service.snapshot(run, 'owner').canSave).toBe(true);
    expect(f.response()).not.toContain('connectionId'); expect(f.response()).not.toContain('validated');
    await expect(f.service.save(run, 'Foreign', 'other')).rejects.toThrow('unavailable');
    await expect(f.service.save(run, 'Wrong venue', 'owner', ['newly-connected'])).rejects.toThrow('Run a new screen');
    await expect(f.service.save(run, 'No venue', 'owner', [])).rejects.toThrow();
    const saved = await f.service.save(run, 'Over $5', 'owner', ['robinhood']);
    f.noModel(); f.execute.mockClear(); f.models.mockClear();
    const replay = await f.service.replay(saved.id, 'owner');
    await f.approve(replay);
    expect(f.service.snapshot(replay, 'owner')).toMatchObject({ state: 'completed', replay: { id: saved.id }, canSave: false, screening: { returned: 1 } });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.models).not.toHaveBeenCalled();
    expect(f.audit.start.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'replay', provider: 'none', model: 'none', sourceRef: saved.id });
    const writes = f.scanTool.mock.calls.length;
    await f.service.removeSaved(saved.id);
    expect(f.scanTool.mock.calls).toHaveLength(writes);
    expect(await f.service.saved()).toEqual([]);
  } finally { await f.service.close(); }
});

test('replay refuses changed accounts, changed specifications, declined approvals and disconnected venues', async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save(record()); f.noModel();
    let run = await f.service.replay(saved.id, 'owner'); await f.approve(run, false);
    expect(f.scanTool).not.toHaveBeenCalled();
    f.account('other'); run = await f.service.replay(saved.id, 'owner'); await f.approve(run);
    expect(f.service.snapshot(run, 'owner').state).toBe('failed'); expect(f.scanTool).not.toHaveBeenCalled();
    f.account('one'); f.unsupported(); run = await f.service.replay(saved.id, 'owner'); await f.approve(run);
    expect(f.service.snapshot(run, 'owner').state).toBe('failed');
    expect(f.scanTool.mock.calls.map(call => call[1])).toEqual(['get_scanner_filter_specs']);
    f.disconnect(); await expect(f.service.replay(saved.id, 'owner')).rejects.toThrow('unavailable');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.models).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

test('revoking managed-screen permission during replay approval prevents all venue calls', async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save(record()); f.noModel();
    const run = await f.service.replay(saved.id, 'owner');
    await until(() => f.service.snapshot(run, 'owner').approvals.length > 0);
    f.block(); await f.approve(run);
    expect(f.scanTool).not.toHaveBeenCalled(); expect(f.service.snapshot(run, 'owner').state).toBe('failed');
  } finally { await f.service.close(); }
});


test('backup round trips definitions, skips duplicates, and rejects conflicting or invalid imports atomically', async () => {
  const original = createSavedScreens(await profile()); await original.save(record());
  const backup = await original.exportBackup();
  expect(backup).toMatchObject({ kind: 'opentake-saved-screens', version: 1 });
  expect(JSON.stringify(backup)).not.toMatch(/scan_id|managed-scans|token|credential/);
  const target = createSavedScreens(await profile());
  const preview = await target.previewBackup(backup);
  expect(preview.screens).toHaveLength(1); expect(await target.list()).toHaveLength(0);
  expect(await target.importBackup(preview.backup)).toEqual({ imported: 1, skipped: 0 });
  expect(await target.get(backup.screens[0].id)).toEqual(backup.screens[0]);
  expect(await target.importBackup(backup)).toEqual({ imported: 0, skipped: 1 });
  const conflict = structuredClone(backup); conflict.screens[0].title = 'Changed';
  await original.save(record()); conflict.screens.push((await original.exportBackup()).screens[1]);
  await expect(target.importBackup(conflict)).rejects.toThrow('conflicts');
  expect(await target.list()).toHaveLength(1);
  for (const invalid of [{ ...backup, version: 2 }, { ...backup, credentials: {} }, { ...backup, screens: [backup.screens[0], backup.screens[0]] }]) {
    await expect(target.previewBackup(invalid)).rejects.toThrow('Invalid');
  }
});

test('backup confirmations are owner-bound, one-use and revalidated after preview', async () => {
  const f = await fixture();
  try {
    const store = createSavedScreens(await profile()); await store.save(record());
    const backup = await store.exportBackup();
    const preview = await f.service.previewBackup(backup, 'owner');
    await expect(f.service.importBackup(preview.token, 'other')).rejects.toThrow('expired');
    expect(await f.service.importBackup(preview.token, 'owner')).toEqual({ imported: 1, skipped: 0 });
    await expect(f.service.importBackup(preview.token, 'owner')).rejects.toThrow('expired');
    const next = await f.service.previewBackup(backup, 'owner');
    await f.store.save({ ...record(), originRunId: backup.screens[0].originRunId, title: 'Renamed locally' });
    await expect(f.service.importBackup(next.token, 'owner')).rejects.toThrow('conflicts');
    const pending = await f.service.previewBackup(await f.store.exportBackup(), 'owner');
    await f.service.cancelAll();
    await expect(f.service.importBackup(pending.token, 'owner')).rejects.toThrow('expired');
  } finally { await f.service.close(); }
});

test('recovery is a settings-only confirmed read with account and permission rechecks', async () => {
  const f = await fixture();
  try {
    const { createManagedScanStore } = await import('../../src/main/search/managed-scans');
    const ownership = createManagedScanStore(f.path), title = 'Opentake · Ask Agent · nonce';
    await ownership.save({ scope, title, state: { kind: 'creating' } });
    f.scanTool.mockImplementation(async (_scope, operation, _input, _signal, authorize) => {
      await authorize(); if (operation !== 'get_scans') throw new Error('Unexpected write');
      return { scans: [{ scan_id: 'recovered', title, cortex_managed: false, columns: [] }] };
    });
    const preview = await f.service.previewRecovery('owner');
    if (preview.status !== 'ready') throw new Error('Missing preview');
    await expect(f.service.confirmRecovery(preview.token, 'other')).rejects.toThrow('expired');
    f.account('other');
    await expect(f.service.confirmRecovery(preview.token, 'owner')).rejects.toThrow('changed');
    f.account('one');
    const next = await f.service.previewRecovery('owner');
    if (next.status !== 'ready') throw new Error('Missing preview');
    await f.service.confirmRecovery(next.token, 'owner');
    expect((await ownership.read(scope))?.state).toEqual({ kind: 'owned', id: 'recovered' });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.models).not.toHaveBeenCalled();
    f.block(); await expect(f.service.previewRecovery('owner')).rejects.toThrow('blocked');
  } finally { await f.service.close(); }
});


test('oversized backup and aggregate-capacity imports leave existing screens unchanged', async () => {
  const store = createSavedScreens(await profile()); await store.save(record());
  const backup = await store.exportBackup();
  await expect(store.previewBackup({ ...backup, padding: 'x'.repeat(4 * 1024 * 1024) })).rejects.toThrow('4 MB');
  const incoming = { ...backup, screens: Array.from({ length: 100 }, () => ({ ...backup.screens[0], id: randomUUID(), originRunId: randomUUID() })) };
  await expect(store.previewBackup(incoming)).rejects.toThrow('100');
  await expect(store.importBackup(incoming)).rejects.toThrow('100');
  expect(await store.list()).toHaveLength(1);
});

test('maintenance previews expire without consuming another owner’s confirmation', async () => {
  const { createSearchPreviews } = await import('../../src/main/search/previews');
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const previews = createSearchPreviews<string>(), token = previews.issue('owner', 'fixture');
    expect(() => previews.take(token, 'other')).toThrow('expired');
    now.mockReturnValue(121_001);
    expect(() => previews.take(token, 'owner')).toThrow('expired');
  } finally { now.mockRestore(); }
});
