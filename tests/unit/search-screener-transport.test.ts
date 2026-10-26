import { expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnections } from '../../src/main/connections';
import { createDatabaseLifecycle } from '../../src/main/database';
import { createMcpManagement } from '../../src/main/mcp-management';
import { LocalRobinhoodProvider } from '../../src/main/robinhood-client';

test('managed transport binds scope to the currently selected account and rechecks authorization', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'screener-transport-'));
  const db = createDatabaseLifecycle(join(profile, 'database'));
  const values = new Map<string, string>();
  const secrets = { available: () => true, get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, has: async (key: string) => values.has(key), delete: async (key: string) => { values.delete(key); } };
  const scanTool = vi.fn(async () => ({ scan_id: 'fixture' }));
  const connections = createConnections(db, secrets, async () => {}, async (_store, ref) => ({
    authorize: async () => { values.set(ref, 'synthetic'); },
    accounts: async () => ['one', 'two'].map(externalRef => ({ externalRef, maskedNumber: externalRef, agenticAllowed: true, nickname: null, accountType: 'cash' })),
    scanTool,
  }));
  try {
    await db.start();
    const mcp = createMcpManagement(db, secrets, join(profile, 'mcp'), () => false, async () => ({ content: [] }));
    await mcp.start();
    expect((await mcp.policySnapshot()).some(t => t.name === 'robinhood_search_screen')).toBe(true);
    expect((await mcp.policySnapshot('10000000-0000-4000-8000-000000000001')).some(t => t.name === 'robinhood_search_screen')).toBe(false);
    const connected = await connections.connect();
    await connections.selectAccount(connected.accounts[0].id);
    const scope = await connections.scanScope(); const signal = new AbortController().signal;
    const authorize = vi.fn(async () => {});
    await connections.scanTool(scope, 'create_scan', { title: 'fixture', filters: [] }, signal, authorize);
    expect(authorize).toHaveBeenCalledOnce(); expect(scanTool).toHaveBeenCalledOnce();
    await expect(connections.scanTool(scope, 'update_scan_filters', { scan_id: 'fixture', filters: [{ filter_type: 'PRICE', predicate: '>', values: ['5'] }] }, signal, async () => { throw new Error('Revoked'); })).rejects.toThrow('Revoked');
    expect(scanTool).toHaveBeenCalledOnce();
    await connections.selectAccount(connected.accounts[1].id);
    await expect(connections.scanTool(scope, 'get_scans', {}, signal, authorize)).rejects.toThrow('account changed');
    expect(scanTool).toHaveBeenCalledOnce();
  } finally { await connections.close(); await db.close(); await rm(profile, { recursive: true, force: true }); }
});

test('low-level screener transport validates eligibility, redacts accounts and gates immediately before dispatch', async () => {
  const number = '12345678';
  const provider = new LocalRobinhoodProvider({ version: 1, ownerId: 'fixture', connectionId: 'fixture' } as any, async () => {});
  const callTool = vi.fn(async ({ name }) => ({ structuredContent: name === 'get_accounts'
    ? { results: [{ account_number: number, agentic_allowed: true }] }
    : { scan_id: 'fixture', account_number: number } }));
  // Replace transport acquisition, never OAuth/network/OS credential access.
  vi.spyOn(provider as any, 'withClient').mockImplementation(async (_signal, work: any) => work({ callTool }));
  const { createHash } = await import('node:crypto');
  const externalRef = createHash('sha256').update(number).digest('hex');
  const signal = new AbortController().signal;
  const output = await provider.scanTool('create_scan', { title: 'fixture', filters: [] }, externalRef, signal, async () => {});
  expect(JSON.stringify(output)).not.toContain(number);
  await expect(provider.scanTool('create_scan', { title: 'fixture', filters: [] }, externalRef, signal, async () => { throw new Error('Revoked'); })).rejects.toThrow('Revoked');
  expect(callTool.mock.calls.filter(([input]) => input.name === 'create_scan')).toHaveLength(1);
  await expect(provider.scanTool('create_scan', { title: 'fixture', filters: [] }, 'other-account', signal, async () => {})).rejects.toThrow('account unavailable');
});
