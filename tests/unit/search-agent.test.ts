import { test, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/main/migrations';
import { createAiAudit, recoverAiAudits } from '../../src/main/ai-audit';
import { createSearchAgentRunner } from '../../src/main/search/agent-runner';
import { createSearchAgentContext, searchToolPermission, type SearchToolPolicy } from '../../src/main/search/agent-context';
import { defaultSearchSettings } from '../../src/shared/search-settings';
const settings = () => ({ ...defaultSearchSettings(), selection: { provider: 'claude' as const, model: 'fixture' } });
const tools = (): SearchToolPolicy[] => [{ name: 'market_lookup', source: 'fixture', scope: 'marketData', fingerprint: 'v1', policy: 'allowed' }];
const request = { question: 'Find a fixture market', sources: ['fixture'] };
const audit = () => ({ start: vi.fn(async () => ({ traceId: 'fixture', runId: 'fixture' })), record: vi.fn(async () => {}), finish: vi.fn(async () => {}) });
function dependencies() {
  return { settings: async () => settings(), tools: async () => tools(), available: async () => true,
    budgets: async () => ({ claudeCostUsd: null, opencodeCostUsd: null, outputTokens: null }), audit: audit(), adapter: () => 'fixture',
    authorize: vi.fn(async () => {}), approve: vi.fn(async () => true), dispatch: vi.fn(async () => ({ source: 'fixture' })),
    execute: vi.fn(async (input: Parameters<Parameters<typeof createSearchAgentRunner>[0]['execute']>[0]) => {
      await input.call('market_lookup', { query: 'fixture' }); input.text('Provider-backed fixture result');
    }),
  };
}
test('search configuration is isolated, scoped and cannot expand after submission', () => {
  const config = settings(); const policy = tools();
  const context = createSearchAgentContext(request, config, policy);
  config.selection.model = 'changed'; policy[0].fingerprint = 'changed';
  expect(context.selection.model).toBe('fixture');
  expect(searchToolPermission(context, 'market_lookup', policy, config)).toBe('blocked');
  expect(searchToolPermission(context, 'trade', tools(), config)).toBe('blocked');
  expect(searchToolPermission(context, 'market_lookup', tools(), { ...config, permissions: { marketData: 'blocked', managedScreeners: 'allowed' } })).toBe('blocked');
  expect(() => createSearchAgentContext({ ...request, takeId: 'not-allowed' }, settings(), tools())).toThrow();
  expect(() => createSearchAgentContext(request, defaultSearchSettings(), tools())).toThrow('Choose search AI');
});

test('dedicated search lifecycle records audits without Take rows and uses restart recovery', async () => {
  const db = new PGlite();
  const deps = dependencies();
  deps.audit = createAiAudit({ use: fn => fn(db) });
  const runner = createSearchAgentRunner(deps);
  try {
    await migrate(db);
    const id = await runner.start(request, 'owner'); await runner.settled(id, 'owner');
    expect(runner.snapshot(id, 'owner').state).toBe('completed');
    expect(deps.authorize).toHaveBeenCalledTimes(2);
    expect((await db.query('SELECT id FROM takes')).rows).toEqual([]);
    expect((await db.query('SELECT id FROM take_runs')).rows).toEqual([]);
    expect((await db.query('SELECT feature,state FROM ai_audit_traces')).rows).toEqual([{ feature: 'search', state: 'completed' }]);
    const interrupted = await deps.audit.start({ feature: 'search', operation: 'search', provider: 'claude', model: 'fixture', adapter: 'fixture', adapterVersion: '1', context: {} });
    await db.transaction(tx => recoverAiAudits(tx, 'host_restarted'));
    expect((await db.query('SELECT state FROM ai_audit_runs WHERE id=$1', [interrupted.runId])).rows).toEqual([{ state: 'interrupted' }]);
  } finally { await runner.close(); await db.close(); }
});

test('sharing denial and a revoked permission never dispatch a search tool', async () => {
  const deps = dependencies(); deps.authorize.mockRejectedValue(new Error('Denied'));
  let runner = createSearchAgentRunner(deps);
  const id = await runner.start(request, 'owner'); await runner.settled(id, 'owner');
  expect(deps.execute).not.toHaveBeenCalled(); expect(deps.dispatch).not.toHaveBeenCalled();
  expect(runner.snapshot(id, 'owner').state).toBe('failed'); await runner.close();
  const next = dependencies();
  next.settings = async () => ({ ...settings(), permissions: { marketData: 'ask', managedScreeners: 'ask' } });
  next.approve.mockImplementation(async () => { next.tools = async () => []; return true; });
  runner = createSearchAgentRunner(next);
  const second = await runner.start(request, 'owner'); await runner.settled(second, 'owner');
  expect(next.approve).toHaveBeenCalledOnce(); expect(next.dispatch).not.toHaveBeenCalled();
  await runner.close();
});

test('search cancellation is owner-scoped, bounded to one run per client, and audited', async () => {
  const deps = dependencies();
  deps.execute.mockImplementation(async ({ signal }) => { await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }); });
  const runner = createSearchAgentRunner(deps);
  try {
    const id = await runner.start(request, 'owner');
    await expect(runner.start(request, 'owner')).rejects.toThrow('Stop the current');
    expect(() => runner.snapshot(id, 'other')).toThrow('unavailable');
    await expect(runner.stop(id, 'other')).rejects.toThrow('unavailable');
    await runner.stop(id, 'owner'); expect(runner.snapshot(id, 'owner').state).toBe('cancelled');
    expect(deps.audit.finish).toHaveBeenCalledWith(id, 'cancelled');
  } finally { await runner.close(); }
});
