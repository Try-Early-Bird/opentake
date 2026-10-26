import { afterEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOpentakeMcpServer, callOpentakeTool, type OpentakeServices } from '../../../src/main/opentake-mcp/server';
import { readTools, toolCatalog } from '../../../src/main/opentake-mcp/catalog';
import { loadProvider } from '../../../src/main/robinhood-client';
import { createHash } from 'node:crypto';

const accountRef = '11111111-1111-4111-8111-111111111111';
function services(): OpentakeServices {
  return { status: vi.fn(async () => ({ status: 'connected' as const, checkedAt: null,
    accounts: [{ id: accountRef, maskedNumber: '••••5678', nickname: null, accountType: 'cash', agenticAllowed: true, selected: true },
      { id: '22222222-2222-4222-8222-222222222222', maskedNumber: '••••1111', nickname: null, accountType: 'cash', agenticAllowed: true, selected: false },
      { id: '33333333-3333-4333-8333-333333333333', maskedNumber: '••••2222', nickname: null, accountType: 'cash', agenticAllowed: false, selected: true }] })),
    read: vi.fn(async () => ({ buying_power: '100' })) };
}
afterEach(() => vi.restoreAllMocks());

test('MCP protocol discovers only enabled platform tools and routes shared and provider calls', async () => {
  const local = services();
  const server = createOpentakeMcpServer(local);
  const client = new Client({ name: 'synthetic', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const catalog = (await client.listTools()).tools;
    expect(catalog.map(t => t.name)).toEqual(toolCatalog().map(t => t.name));
    expect(new Set(catalog.map(t => t.name)).size).toBe(catalog.length);
    expect(catalog.filter(t => !t.annotations?.readOnlyHint).map(t=>t.name).sort()).toEqual(['opentake_propose_rules','opentake_propose_strategy','opentake_request_tool_access','opentake_request_trade']);
    expect(catalog.some(t => /follow|publish|confirm|exercise|create_scan/.test(t.name))).toBe(false);
    const result = await client.callTool({ name: 'opentake_list_accounts', arguments: { platform: 'robinhood' } });
    expect(JSON.stringify(result)).toContain(accountRef);
    expect(JSON.stringify(result)).not.toContain('22222222-2222');
    expect(JSON.stringify(result)).not.toContain('33333333-3333');
    expect(local.status).toHaveBeenCalledWith('robinhood');
    await client.callTool({ name: 'robinhood_get_portfolio', arguments: { accountRef } });
    expect(local.read).toHaveBeenCalledWith('robinhood', 'get_portfolio', {}, accountRef);
  } finally { await client.close(); await server.close(); }
});

test('unknown platforms, write tools, cross-platform fields and malformed arguments fail before service access', async () => {
  const local = services();
  for (const [name, input] of [
    ['opentake_list_accounts', { platform: 'other' }],
    ['opentake_connection_status', {}],
    ['earlybird_follow_strategy', {}],
    ['robinhood_exercise_option', { confirm: true }],
    ['robinhood_get_portfolio', { platform: 'other' }],
    ['robinhood_get_portfolio', { account_number: '12345678' }],
    ['robinhood_get_portfolio', { accountRef: 'wrong' }],
    ['robinhood_get_equity_quotes', { symbols: [] }],
    ['robinhood_get_earnings_calendar', { days: 0 }],
  ] as const) expect((await callOpentakeTool(local, name, input)).isError).toBe(true);
  expect(local.read).not.toHaveBeenCalled(); expect(local.status).not.toHaveBeenCalled();
  await callOpentakeTool(local, 'robinhood_get_equity_quotes', { symbols: [' aapl '] });
  expect(local.read).toHaveBeenCalledWith('robinhood', 'get_equity_quotes', { symbols: ['AAPL'] }, undefined);
});

test('errors never return provider secrets or raw account numbers', async () => {
  const local = services();
  local.read = async () => { throw new Error('synthetic-secret 12345678'); };
  const result = await callOpentakeTool(local, 'robinhood_get_portfolio', {});
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|12345678/);
});

test('provider enforces read allowlist, resolves account hashes and redacts results without real network or secrets', async () => {
  const stored = new Map<string, string>();
  const secrets = { available: () => true, get: async (key: string) => stored.get(key) ?? null,
    set: async (key: string, value: string) => { stored.set(key, value); }, has: async (key: string) => stored.has(key), delete: async (key: string) => { stored.delete(key); } };
  const provider = await loadProvider(secrets, 'synthetic', 'owner', 'connection', true);
  await provider.saveTokens({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 });
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
  const calls = vi.spyOn(Client.prototype, 'callTool').mockImplementation(async request => ({ content: [{ type: 'text', text: JSON.stringify(
    request.name === 'get_accounts' ? { data: [{ account_number: '12345678' }] } : { data: { account_number: '12345678', url: '/accounts/12345678/', equity: '100' } }
  ) }] }));
  const signal = new AbortController().signal;
  const hash = createHash('sha256').update('12345678').digest('hex');
  const result = await provider.readTool('get_portfolio', {}, hash, signal);
  expect(calls.mock.calls[1][0]).toEqual({ name: 'get_portfolio', arguments: { account_number: '12345678' } });
  expect(JSON.stringify(result)).not.toContain('12345678');
  expect(JSON.stringify(result)).toContain('••••5678');
  calls.mockClear();
  await expect(provider.readTool('place_equity_order', {}, hash, signal)).rejects.toThrow();
  expect(calls).not.toHaveBeenCalled();
  await expect(provider.readTool('get_portfolio', {}, 'other-account', signal)).rejects.toThrow('Account unavailable');
  expect(calls).toHaveBeenCalledTimes(1); // discovery only; portfolio request never dispatched
  expect(readTools.filter(tool => tool.platform === 'robinhood').every(tool => tool.name.startsWith('robinhood_'))).toBe(true);
});

test('local reads require this connection account, reuse onboarded provider and serialize with maintenance', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createDatabaseLifecycle } = await import('../../../src/main/database');
  const { createConnections } = await import('../../../src/main/connections');
  const path = await mkdtemp(join(tmpdir(), 'opentake-mcp-synthetic-'));
  const db = createDatabaseLifecycle(join(path, 'database'));
  const values = new Map<string, string>();
  const secrets = { available: () => true, get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); }, has: async (key: string) => values.has(key), delete: async (key: string) => { values.delete(key); } };
  const read = vi.fn(async () => ({ data: 'synthetic portfolio' }));
  const connections = createConnections(db, secrets, async () => {}, async (_store, ref) => ({
    authorize: async () => { await secrets.set(ref, 'synthetic'); },
    accounts: async () => [{ externalRef: 'synthetic-hash', maskedNumber: '••••5678', nickname: null, accountType: 'cash', agenticAllowed: true }],
    readTool: read,
  }));
  try {
    await db.start();
    await expect(connections.readTool('get_portfolio', {})).rejects.toThrow();
    await connections.connect();
    await expect(connections.readTool('get_portfolio', {}, accountRef)).rejects.toThrow('Select an account');
    expect(read).not.toHaveBeenCalled();
    expect(await connections.readTool('get_portfolio', {})).toEqual({ data: 'synthetic portfolio' });
    expect(read.mock.calls[0][2]).toBe('synthetic-hash');
    let release!: () => void;
    read.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ data: 'done' }); }));
    const pending = connections.readTool('get_portfolio', {});
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    let refreshed = false;
    const refresh = connections.refresh().then(value => { refreshed = true; return value; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(refreshed).toBe(false);
    } finally { release(); }
    expect(await pending).toEqual({ data: 'done' });
    expect((await refresh).status).toBe('connected');
    await connections.disconnect();
    await expect(connections.readTool('get_portfolio', {})).rejects.toThrow();
  } finally { await connections.close(); await db.close(); await rm(path, { recursive: true, force: true }); }
});

test('basket validation errors identify invalid structure without weakening provider-error redaction',async()=>{
 const {proposalInputSchema}=await import('../../../src/shared/strategies');
 const local=services();local.strategy=async(_name,input)=>proposalInputSchema.parse(input);
 const result=await callOpentakeTool(local,'opentake_propose_strategy',{kind:'triggered'});
 expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('Invalid strategy arguments');
 expect(JSON.stringify(result)).toContain('spec');
});
