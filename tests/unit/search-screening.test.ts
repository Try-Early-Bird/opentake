import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRobinhoodScreening, normalizeScreenerResults, validateScreenerFilters } from '../../src/main/search/robinhood-screening';
import { managedScanDefinitionSchema } from '../../src/main/search/managed-scans';
import { parseScanOperation } from '../../src/main/search/screener-tools';
import { parseRead, toolCatalog } from '../../src/main/opentake-mcp/catalog';
import { createSearchAgentService } from '../../src/main/search/agent-service';
import { defaultSearchSettings } from '../../src/shared/search-settings';
import { robinhoodSearchAdapter } from '../../src/main/search/robinhood';

const specs = { data: { filter_specs: [
  { filter_type: 'PRICE_CHANGE', display_name: 'Change', value_type: 'DECIMAL', unit_type: 'PERCENTAGE', supported_predicates: ['>', 'BETWEEN'], supported_intervals: ['1d'] },
  { filter_type: 'SECTOR', display_name: 'Sector', value_type: 'STRING', unit_type: 'PLAIN', supported_predicates: ['=', 'ANY_OF'], options: ['Technology', 'Energy'] },
] }, guide: 'untrusted guide never included in model specs' };
const definition = managedScanDefinitionSchema.parse({ filters: [{ filter_type: 'PRICE_CHANGE', predicate: '>', values: ['5'], interval: '1d' }], sorting_column: 'Market cap', sorting_direction: 'desc' });
const scope = { venue: 'robinhood', instance: 'production', connectionId: 'fixture', accountId: 'fixture' };
const rawResults = { data: { result: { scan_id: 'owned', total_items: 2, sorted_by: 'Market cap desc', results: [
  { ticker: 'FIX', instrument_id: 'stock-id', instrument_type: 'EQUITY' },
  { ticker: 'FIX', instrument_id: 'option-id', instrument_type: 'OPTION' },
] } } };
const profiles: string[] = [];
afterEach(async () => { await Promise.all(profiles.splice(0).map(profile => rm(profile, { recursive: true, force: true }))); });
async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'screener-bridge-')); profiles.push(profile);
  let title = ''; const calls: string[] = [];
  const scanTool = vi.fn(async (_scope, operation, input, signal, authorize) => {
    await authorize(); signal.throwIfAborted(); calls.push(operation);
    if (operation === 'get_scanner_filter_specs') return specs;
    if (operation === 'create_scan') { title = input.title; return { data: { scan_id: 'owned' } }; }
    if (operation === 'get_scans') return { data: { scans: [{ scan_id: 'owned', title, cortex_managed: false, columns: [{ display_name: 'Market cap' }] }] } };
    if (operation === 'run_scan') return rawResults;
    return { success: true };
  });
  const screening = createRobinhoodScreening(profile, { scanScope: async () => scope, scanTool });
  return { screening, scanTool, calls };
}

test('validates exact provider filters, cardinality, intervals, numbers and enum options without dropping conditions', () => {
  expect(() => validateScreenerFilters(definition, specs)).not.toThrow();
  const filter = definition.filters[0];
  for (const invalid of [
    { ...filter, filter_type: 'invented' }, { ...filter, interval: undefined }, { ...filter, interval: '1h' },
    { ...filter, length: 14 }, { ...filter, predicate: 'PREDICATE_GREATER_THAN' }, { ...filter, values: ['NaN'] },
    { ...filter, predicate: 'BETWEEN', values: ['10', '5'] }, { ...filter, values: ['5', '6'] },
    { filter_type: 'SECTOR', predicate: 'ANY_OF', values: ['Invented'] },
  ]) expect(() => validateScreenerFilters({ ...definition, filters: [invalid] }, specs)).toThrow();
  expect(() => validateScreenerFilters(definition, { filter_specs: [] })).toThrow();
});

test('raw managed operations cannot be used to trade, edit arbitrary columns or use create as update', () => {
  for (const [name, input] of [['place_equity_order', {}], ['create_scan', { title: 'x', filters: [], scan_id: 'other' }],
    ['update_scan_config', { scan_id: 'x', columns: [] }], ['update_scan_filters', { scan_id: 'x', filters: [{ expression: 'arbitrary' }] }]] as const) {
    expect(() => parseScanOperation(name, input)).toThrow();
  }
  expect(() => parseRead('create_scan', { title: 'x' }, true)).toThrow();
  expect(toolCatalog().some(t => t.name === 'robinhood_search_screen')).toBe(false);
  expect(toolCatalog(true).some(t => t.name === 'robinhood_search_screen')).toBe(true);
});

test('creates once, validates sorting before updates, and returns distinct typed provider identities', async () => {
  const f = await fixture(); const signal = new AbortController().signal; const authorize = async () => {};
  expect(await f.screening.specs(signal, authorize)).not.toHaveProperty('guide');
  const result = await f.screening.screen(definition, signal, authorize);
  expect(result.markets.map(m => m.identity.kind)).toEqual(['equity', 'option']);
  expect(result.screening).toMatchObject({ total: 2, returned: 2, omitted: 0, truncated: false });
  await f.screening.screen(definition, signal, authorize);
  expect(f.calls.filter(c => c === 'create_scan')).toHaveLength(1);
  const before = f.calls.filter(c => c === 'update_scan_filters').length;
  await expect(f.screening.screen({ ...definition, sorting_column: 'invented' }, signal, authorize)).rejects.toThrow('Available columns: Market cap');
  expect(f.calls.filter(c => c === 'update_scan_filters')).toHaveLength(before);
});

test('invalid or mismatched results are rejected; missing identities and provider truncation are reported', () => {
  expect(() => normalizeScreenerResults(rawResults, 'other')).toThrow();
  const result = normalizeScreenerResults({ result: { scan_id: 'owned', sorted_by: 'Market cap desc', total_items: 100,
    results: [{ ticker: 'MISSING' }, ...rawResults.data.result.results] } }, 'owned');
  expect(result).toMatchObject({ omitted: 1, truncated: true, total: 100 });
  expect(result.markets).toHaveLength(2);
});

test('generic screened equities resolve by exact instrument ID when discovery refines the subtype', async () => {
  const adapter = robinhoodSearchAdapter({ status: async () => ({ status: 'connected', checkedAt: null, accounts: [] }),
    readTool: async () => ({ results: [{ symbol: 'FIX', instrument_id: 'stock-id', type: 'stock', name: 'Fixture' }] }) });
  const hit = normalizeScreenerResults(rawResults, 'owned').markets[0];
  expect(await adapter.resolve(hit, new AbortController().signal)).toMatchObject({ identity: hit.identity, name: 'Fixture' });
  expect(await adapter.resolve({ ...hit, identity: { ...hit.identity, reference: 'other' } }, new AbortController().signal)).toBeNull();
});

test('search gateway approves managed screening, surfaces coverage and stops on mid-operation revocation', async () => {
  const f = await fixture();
  const settings = { ...defaultSearchSettings(), selection: { provider: 'claude' as const, model: 'fixture' } };
  const names = ['robinhood_search', 'robinhood_get_scanner_filter_specs', 'robinhood_search_screen', 'robinhood_get_scans', 'robinhood_run_scan'];
  const audit = { start: vi.fn(async () => ({ traceId: 'fixture', runId: 'fixture' })), record: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
  let service: ReturnType<typeof createSearchAgentService>;
  let response: unknown;
  service = createSearchAgentService({ settings: async () => settings, models: async () => ({ ok: true, models: [{ value: 'fixture', label: 'Fixture' }], source: 'catalog' }),
    policies: async () => names.map(name => ({ server: '00000000-0000-4000-8000-000000000001', name, fingerprint: name, revision: 1, policy: 'allowed' as const })),
    budgets: async () => ({ claudeCostUsd: null }), audit, sharing: async () => ({ verify: false, revision: 1, scope: 'fixture' }), port: () => 12345,
    screening: f.screening, adapter: { id: 'robinhood', label: 'Robinhood', status: async () => ({ id: 'robinhood', label: 'Robinhood', connected: true, capabilities: { lookup: true, details: true, screening: true } }), lookup: async () => ({ markets: [], truncated: false }), owns: () => true, resolve: async () => null },
    execute: async runtime => {
      expect((await service.gateway('gateway:list', runtime.id) as { name: string }[]).map(t => t.name)).toEqual(names.slice(0, 3));
      expect(await service.gateway('gateway:call', runtime.id, 'create_scan', {})).toMatchObject({ isError: true });
      await service.gateway('gateway:call', runtime.id, 'robinhood_get_scanner_filter_specs', {});
      response = await service.gateway('gateway:call', runtime.id, 'robinhood_search_screen', definition);
    },
  });
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out'); };
  try {
    const id = await service.start({ question: 'Stocks rising over 5%', sources: ['robinhood'] }, 'owner');
    await until(() => service.snapshot(id, 'owner').approvals.length > 0);
    const approval = service.snapshot(id, 'owner').approvals[0];
    expect(approval.title).toContain('manage a Robinhood screener');
    expect(f.calls).toEqual(['get_scanner_filter_specs']);
    await service.decide(id, approval.id, true, 'owner');
    await until(() => service.snapshot(id, 'owner').state !== 'running');
    expect(response).not.toHaveProperty('isError');
    expect(service.snapshot(id, 'owner')).toMatchObject({ state: 'completed', screening: { total: 2, returned: 2 } });
    expect(service.snapshot(id, 'owner').markets).toHaveLength(2);
    settings.permissions.managedScreeners = 'allowed';
    const original = f.scanTool.getMockImplementation()!;
    f.scanTool.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === 'update_scan_filters') settings.permissions.marketData = 'blocked';
      return result;
    });
    const before = f.calls.filter(name => name === 'run_scan').length;
    const next = await service.start({ question: 'Screen again', sources: ['robinhood'] }, 'owner');
    await until(() => service.snapshot(next, 'owner').state !== 'running');
    expect(response).toMatchObject({ isError: true });
    expect(service.snapshot(next, 'owner').markets).toHaveLength(0);
    expect(f.calls.filter(name => name === 'run_scan')).toHaveLength(before);
    expect(f.calls.at(-1)).toBe('update_scan_filters');
  } finally { await service.close(); }
});
