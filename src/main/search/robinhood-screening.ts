import { SearchMaintenanceError } from './previews';
import { savedSearchSourceSchema, type SavedSearchSource } from '../../shared/saved-search';
import { z } from 'zod';
import { marketHitSchema, marketKey, type MarketHit } from '../../shared/search';
import { createManagedScanExecutor, createManagedScanStore, managedScanDefinitionSchema, type ManagedScanDefinition, type ManagedScanScope } from './managed-scans';
import { ScreenerError, type ScanOperation } from './screener-tools';

const text = z.string().min(1).max(256);
const specSchema = z.object({
  filter_type: text, display_name: text, value_type: z.enum(['DECIMAL', 'INTEGER', 'STRING', 'DATETIME']),
  unit_type: z.enum(['PLAIN', 'PERCENTAGE', 'DOLLAR']), supported_predicates: z.array(text).min(1).max(20),
  supported_lengths: z.array(z.number().int().positive()).max(1000).optional(),
  supported_intervals: z.array(text).max(100).optional(), options: z.array(text).max(1000).optional(),
  supported_plots: z.array(text).max(100).optional(),
});
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'data' in value) return value.data;
  return value;
}
export function parseScreenerSpecs(value: unknown) {
  const parsed = z.object({ filter_specs: z.array(specSchema).min(1).max(200) }).safeParse(unwrap(value));
  if (!parsed.success || new Set(parsed.data.filter_specs.map(s => s.filter_type)).size !== parsed.data.filter_specs.length) {
    throw new ScreenerError('Robinhood returned unsupported filter specifications. No filters were applied.');
  }
  return parsed.data;
}
export function validateScreenerFilters(definition: ManagedScanDefinition, raw: unknown) {
  const specs = parseScreenerSpecs(raw).filter_specs;
  for (const filter of definition.filters) {
    const spec = specs.find(s => s.filter_type === filter.filter_type);
    const invalid = () => { throw new ScreenerError(`Unsupported or incomplete screener condition: ${filter.filter_type}. Check the current filter specifications.`); };
    if (!spec || !spec.supported_predicates.includes(filter.predicate)) return invalid();
    for (const [value, options] of [[filter.interval, spec.supported_intervals], [filter.length, spec.supported_lengths]] as const) {
      if (options?.length ? value === undefined || !(options as readonly unknown[]).includes(value) : value !== undefined) return invalid();
    }
    // Plots are not exposed by the managed input contract; never silently omit one.
    if (spec.supported_plots?.length) return invalid();
    const count = filter.predicate === 'BETWEEN' || filter.predicate === 'OUTSIDE' ? 2 : filter.predicate === 'ANY_OF' ? null : 1;
    if (count !== null && filter.values.length !== count) return invalid();
    if (!['>', '>=', '<', '<=', '=', '!=', 'BETWEEN', 'OUTSIDE', 'ANY_OF'].includes(filter.predicate)) return invalid();
    if (spec.options?.length) {
      if (filter.values.some(v => !spec.options!.includes(v))) return invalid();
    } else if (spec.value_type === 'INTEGER' || spec.value_type === 'DECIMAL') {
      if (filter.values.some(v => !/^-?\d+(?:\.\d+)?$/.test(v) || !Number.isFinite(Number(v))
        || (spec.value_type === 'INTEGER' && !Number.isSafeInteger(Number(v))))) return invalid();
      if (count === 2 && Number(filter.values[0]) > Number(filter.values[1])) return invalid();
    } else if (spec.value_type === 'DATETIME') {
      if (filter.values.some(v => !z.iso.datetime().safeParse(v).success)) return invalid();
      if (count === 2 && Date.parse(filter.values[0]) > Date.parse(filter.values[1])) return invalid();
    } else return invalid(); // Free-form expressions are outside this contract.
  }
}

const remoteScanSchema = z.object({ scan_id: text, title: text, cortex_managed: z.boolean(),
  columns: z.array(z.object({ display_name: text })).max(100) });
function scans(value: unknown) {
  const parsed = z.object({ scans: z.array(z.unknown()).max(1000) }).safeParse(unwrap(value));
  if (!parsed.success) throw new ScreenerError('Robinhood screener ownership could not be verified.');
  return parsed.data.scans;
}
export function normalizeScreenerResults(value: unknown, id: string) {
  const unwrapped = unwrap(value);
  const payload = unwrapped && typeof unwrapped === 'object' && 'result' in unwrapped ? unwrapped.result : unwrapped;
  const result = z.object({ scan_id: text, results: z.array(z.unknown()).max(10000), total_items: z.number().int().nonnegative(), sorted_by: text }).safeParse(payload);
  if (!result.success || result.data.scan_id !== id) throw new ScreenerError('Robinhood returned an invalid screener result.');
  const rows = new Map<string, MarketHit>(); let omitted = 0;
  const kinds: Record<string, [string, string]> = { EQUITY: ['equity', 'Equity'], STOCK: ['stock', 'Stock'], ETF: ['etf', 'ETF'], OPTION: ['option', 'Option'], INDEX: ['index', 'Index'], CRYPTO: ['crypto', 'Crypto'], FUTURE: ['future', 'Future'] };
  for (const raw of result.data.results) {
    const row = z.object({ ticker: text, instrument_id: text, instrument_type: text }).safeParse(raw);
    if (!row.success || !kinds[row.data.instrument_type.toUpperCase()]) { omitted++; continue; }
    const [kind, typeLabel] = kinds[row.data.instrument_type.toUpperCase()];
    const hit = marketHitSchema.safeParse({ identity: { venue: 'robinhood', instance: 'production', reference: row.data.instrument_id, kind },
      symbol: row.data.ticker, name: row.data.ticker, venueLabel: 'Robinhood', typeLabel });
    if (!hit.success) { omitted++; continue; }
    rows.set(marketKey(hit.data), hit.data);
  }
  return { markets: [...rows.values()].slice(0, 20), total: result.data.total_items, omitted,
    truncated: rows.size > 20 || result.data.total_items > result.data.results.length,
    sortedBy: result.data.sorted_by };
}

export function createRobinhoodScreening(profile: string, connections: {
  scanScope(): Promise<ManagedScanScope>;
  scanTool(scope: ManagedScanScope, operation: ScanOperation, input: unknown, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown>;
}) {
  // Each screen owns a distinct signal even if a provider dispatches tools in parallel.
  const gates = new WeakMap<AbortSignal, () => Promise<void>>();
  const call = (scope: ManagedScanScope, operation: ScanOperation, input: unknown, signal: AbortSignal) => {
    const authorize = gates.get(signal); if (!authorize) throw new Error('Screener authorization missing.');
    return connections.scanTool(scope, operation, input, signal, authorize);
  };
  const executor = createManagedScanExecutor({ store: createManagedScanStore(profile), adapter: {
    recoveryCandidates: async (scope, title, signal) => scans(await call(scope, 'get_scans', {}, signal))
      .filter(v => v && typeof v === 'object' && 'title' in v && v.title === title)
      .map(v => {
        const parsed = remoteScanSchema.safeParse(v);
        return parsed.success ? { id: parsed.data.scan_id, title, writable: !parsed.data.cortex_managed, providerManaged: parsed.data.cortex_managed }
          : { id: '', title, writable: false, providerManaged: true };
      }),
    validate: async (scope, definition, signal) => validateScreenerFilters(definition, await call(scope, 'get_scanner_filter_specs', {}, signal)),
    create: async (scope, title, signal) => {
      const payload = unwrap(await call(scope, 'create_scan', { title, filters: [] }, signal));
      const candidates = [payload, ...(payload && typeof payload === 'object' ? ['scan', 'result'].map(k => (payload as Record<string, unknown>)[k]) : [])];
      const ids = candidates.map(v => z.object({ scan_id: text }).safeParse(v)).flatMap(v => v.success ? [v.data.scan_id] : []);
      if (new Set(ids).size !== 1) throw new ScreenerError('Screener creation outcome is unresolved. No automatic retry will be made.');
      return { id: ids[0] };
    },
    inspect: async (scope, id, signal, definition) => {
      const matches = scans(await call(scope, 'get_scans', {}, signal)).filter(v => v && typeof v === 'object' && 'scan_id' in v && v.scan_id === id);
      if (matches.length !== 1) return null;
      const parsed = remoteScanSchema.safeParse(matches[0]); if (!parsed.success) return null;
      if (!parsed.data.columns.some(c => c.display_name === definition.sorting_column)) {
        throw new ScreenerError(`Unsupported sorting column. Available columns: ${parsed.data.columns.map(c => c.display_name).join(', ')}.`);
      }
      return { id, title: parsed.data.title, providerManaged: parsed.data.cortex_managed, writable: !parsed.data.cortex_managed };
    },
    replaceFilters: async (scope, id, filters, signal) => { await call(scope, 'update_scan_filters', { scan_id: id, filters }, signal); },
    replaceSorting: async (scope, id, sorting, signal) => { await call(scope, 'update_scan_config', { scan_id: id, ...sorting }, signal); },
    run: async (scope, id, signal) => normalizeScreenerResults(await call(scope, 'run_scan', { scan_id: id }, signal), id),
  } });
  return {
    async recover(authorize: () => Promise<void>, expected?: { scope: ManagedScanScope; id: string; title: string }) {
      await authorize();
      const scope = await connections.scanScope();
      const matches = (other: ManagedScanScope) => ['venue', 'instance', 'connectionId', 'accountId'].every(k => scope[k as keyof ManagedScanScope] === other[k as keyof ManagedScanScope]);
      if (expected && !matches(expected.scope)) throw new SearchMaintenanceError('Selected account changed. Check recovery again.');
      const scopedAuthorize = async () => { await authorize(); if (!matches(await connections.scanScope())) throw new SearchMaintenanceError('Selected account changed.'); };
      const signal = AbortSignal.timeout(30_000); gates.set(signal, scopedAuthorize);
      try {
        const result = await executor.recover({ scope, signal, authorize: scopedAuthorize, confirm: expected });
        return { ...result, scope };
      } finally { gates.delete(signal); }
    },
    async specs(signal: AbortSignal, authorize: () => Promise<void>) {
      await authorize();
      return parseScreenerSpecs(await connections.scanTool(await connections.scanScope(), 'get_scanner_filter_specs', {}, signal, authorize));
    },
    async screen(input: unknown, signal: AbortSignal, authorize: () => Promise<void>, expected?: SavedSearchSource) {
      const definition = managedScanDefinitionSchema.parse(input);
      if (expected) savedSearchSourceSchema.parse(expected);
      await authorize();
      const scope = await connections.scanScope();
      const matches = (actual: ManagedScanScope) => !expected || ['venue', 'instance', 'connectionId', 'accountId'].every(key => actual[key as keyof ManagedScanScope] === expected.scope[key as keyof ManagedScanScope]);
      if (!matches(scope)) throw new ScreenerError('This saved screen belongs to a different venue or account. Select its original account or create a new screen.');
      const scopedAuthorize = async () => {
        await authorize();
        if (!matches(await connections.scanScope())) throw new ScreenerError('Saved screen account changed.');
      };
      const child = AbortSignal.any([signal]); gates.set(child, scopedAuthorize);
      try {
        const result = await executor.run({ scope, definition, signal: child, authorize: scopedAuthorize });
        return { ...result, validated: { adapterVersion: 1 as const, scope, definition }, screening: { venue: 'robinhood', total: result.total, returned: result.markets.length,
          omitted: result.omitted, truncated: result.truncated, sortedBy: result.sortedBy } };
      } finally { gates.delete(child); }
    },
  };
}
