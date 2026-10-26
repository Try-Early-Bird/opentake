import { test, expect, vi } from 'vitest';
import { createSearchAgentService } from '../../src/main/search/agent-service';
import { defaultSearchSettings } from '../../src/shared/search-settings';
const builtin = '00000000-0000-4000-8000-000000000001';
const market = { identity: { venue: 'robinhood', instance: 'production', kind: 'stock', reference: 'fixture' }, symbol: 'FIX', name: 'Fixture', typeLabel: 'Stock', venueLabel: 'Robinhood' };
function fixture(verify = false, effort?: 'high' | 'max') {
  const state = { policy: 'allowed' as 'allowed' | 'ask' | 'blocked', revision: 1, verify, scope: 'fixture-account' };
  const audit = { start: vi.fn(async () => ({ traceId: 'fixture', runId: 'fixture' })), record: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
  const lookup = vi.fn(async () => ({ markets: [market], truncated: false }));
  let service: ReturnType<typeof createSearchAgentService>;
  const execute = vi.fn(async (input: any) => {
    expect(input.takeId).toBeUndefined(); expect(input.messages).toHaveLength(1);
    expect(service.authorize(input.gateway.token, 'gateway:call', [input.id])).toBe(true);
    expect(service.authorize(input.gateway.token, 'takes:create', [input.id])).toBe(false);
    expect(service.authorize(input.gateway.token, 'gateway:call', ['other'])).toBe(false);
    const catalog = await service.gateway('gateway:list', input.id) as { name: string }[];
    expect(catalog.map(t => t.name)).toEqual(['robinhood_search']);
    expect(await service.gateway('gateway:call', input.id, 'place_order', { symbol: 'FIX' })).toMatchObject({ isError: true });
    await service.gateway('gateway:call', input.id, 'robinhood_search', { query: 'FIX' });
    input.text('Found a fixture. Invented prose ticker FAKE is not a result row.');
  });
  service = createSearchAgentService({ settings: async () => ({ ...defaultSearchSettings(), selection: { provider: 'claude', model: 'fixture', ...(effort ? { effort } : {}) } }),
    models: async () => ({ ok: true, models: [{ value: 'fixture', label: 'Fixture', effortLevels: ['high'] }], source: 'catalog' }),
    policies: async () => [{ server: builtin, name: 'robinhood_search', fingerprint: 'v1', revision: 1, policy: state.policy }],
    budgets: async () => ({ claudeCostUsd: null }), audit, sharing: async () => ({ ...state }), port: () => 12345, execute,
    adapter: { id: 'robinhood', label: 'Robinhood', status: async () => ({ id: 'robinhood', label: 'Robinhood', connected: true, capabilities: { lookup: true, details: true, screening: false } }), lookup, resolve: async () => null, owns: () => true },
  });
  return { service, state, execute, lookup, audit };
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out'); }
const request = { question: 'Find Fixture', sources: ['robinhood'] };
test('search provider gateway is scoped, read-only, and returns only venue-backed rows', async () => {
  const f = fixture();
  try {
    const id = await f.service.start(request, 'owner');
    await until(() => f.service.snapshot(id, 'owner').state !== 'running');
    expect(f.service.snapshot(id, 'owner')).toMatchObject({ state: 'completed', markets: [market], approvals: [] });
    expect(f.lookup).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    expect(() => f.service.snapshot(id, 'other')).toThrow();
    const input = f.execute.mock.calls[0][0];
    expect(f.service.authorize(input.gateway.token, 'gateway:list', [id])).toBe(false);
  } finally { await f.service.close(); }
});
test('sharing approval is owner scoped and cancelled runs never reach the provider', async () => {
  const f = fixture(true);
  try {
    const id = await f.service.start(request, 'owner');
    await until(() => f.service.snapshot(id, 'owner').approvals.length === 1);
    const approval = f.service.snapshot(id, 'owner').approvals[0];
    await expect(f.service.decide(id, approval.id, true, 'other')).rejects.toThrow();
    await f.service.stop(id, 'owner');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.lookup).not.toHaveBeenCalled();
    expect(f.service.snapshot(id, 'owner')).toMatchObject({ state: 'cancelled', approvals: [] });
  } finally { await f.service.close(); }
});
test('permission revocation while approval is pending prevents dispatch', async () => {
  const f = fixture(); f.state.policy = 'ask';
  try {
    const id = await f.service.start(request, 'owner');
    await until(() => f.service.snapshot(id, 'owner').approvals.length === 1);
    const approval = f.service.snapshot(id, 'owner').approvals[0]; f.state.policy = 'blocked';
    await f.service.decide(id, approval.id, true, 'owner');
    await until(() => f.service.snapshot(id, 'owner').state !== 'running');
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.service.snapshot(id, 'owner').markets).toEqual([]);
  } finally { await f.service.close(); }
});
test('unsupported venues and initially blocked tools do not invoke AI', async () => {
  const f = fixture();
  try {
    await expect(f.service.start({ ...request, sources: ['foreign'] }, 'owner')).rejects.toThrow();
    f.state.policy = 'blocked'; await expect(f.service.start(request, 'owner')).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

test('sharing approval authorizes only this run and is audited before lookup', async () => {
  const f = fixture(true);
  try {
    const id = await f.service.start(request, 'owner');
    await until(() => f.service.snapshot(id, 'owner').approvals.length === 1);
    expect(f.execute).not.toHaveBeenCalled();
    await f.service.decide(id, f.service.snapshot(id, 'owner').approvals[0].id, true, 'owner');
    await until(() => f.service.snapshot(id, 'owner').state !== 'running');
    expect(f.service.snapshot(id, 'owner').markets).toEqual([market]);
    expect(f.audit.record.mock.calls.filter(call => call[1].kind === 'approval.requested')).toHaveLength(1);
    const next = await f.service.start(request, 'owner');
    await until(() => f.service.snapshot(next, 'owner').approvals.length === 1);
    await f.service.stop(next, 'owner');
  } finally { await f.service.close(); }
});


test('search effort is validated before execution and passed to its runtime', async () => {
 const unsupported=fixture(false,'max');
 try {await expect(unsupported.service.start(request,'owner')).rejects.toThrow('unavailable');expect(unsupported.execute).not.toHaveBeenCalled();}
 finally {await unsupported.service.close();}
 const supported=fixture(false,'high');
 try {const id=await supported.service.start(request,'owner');await until(()=>supported.service.snapshot(id,'owner').state!=='running');expect(supported.execute.mock.calls[0][0].selection.effort).toBe('high');}
 finally {await supported.service.close();}
});
