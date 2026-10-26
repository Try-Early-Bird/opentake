import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnections } from '../../../src/main/connections';
import { createDatabaseLifecycle } from '../../../src/main/database';
import type { SecretStore } from '../../../src/main/secret-store';

test('brokerage reads require the selected agentic account even with an explicit accountRef', async () => {
  const path = await mkdtemp(join(tmpdir(), 'earlybird-account-scope-'));
  const db = createDatabaseLifecycle(join(path, 'database'));
  const values = new Map<string, string>();
  const secrets: SecretStore = { available: () => true, get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); }, has: async key => values.has(key), delete: async key => { values.delete(key); } };
  const reads: (string | undefined)[] = [];
  const service = createConnections(db, secrets, async () => {}, async (_store, ref) => ({
    authorize: async () => { await secrets.set(ref, 'synthetic'); },
    accounts: async () => [
      { externalRef: 'selected', maskedNumber: '1111', nickname: null, accountType: 'cash', agenticAllowed: true },
      { externalRef: 'other', maskedNumber: '2222', nickname: null, accountType: 'cash', agenticAllowed: true },
      { externalRef: 'ineligible', maskedNumber: '3333', nickname: null, accountType: 'cash', agenticAllowed: false },
    ],
    readTool: async (_name, _args, ref, signal) => { if (reads.length === 2) { await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } reads.push(ref); return {}; },
  }));
  try {
    await db.start();
    const { accounts } = await service.connect();
    await expect(service.readTool('get_portfolio', {})).rejects.toThrow('Select an account');
    await service.selectAccount(accounts[0].id);
    await service.readTool('get_portfolio', {});
    await service.readTool('get_portfolio', {}, accounts[0].id);
    await expect(service.readTool('get_portfolio', {}, accounts[1].id)).rejects.toThrow('Select an account');
    await expect(service.readTool('get_portfolio', { accountRef: accounts[2].id })).rejects.toThrow('Select an account');
    const controller = new AbortController();
    const pending = service.readTool('get_portfolio', {}, accounts[0].id, controller.signal);
    const rejected = expect(pending).rejects.toThrow('Synthetic stop');
    setTimeout(() => controller.abort(new Error('Synthetic stop')), 30);
    await rejected;
    // Eligibility can change independently of the saved selection.
    await db.use(d => d.query('UPDATE linked_accounts SET agentic_allowed=false WHERE id=$1', [accounts[0].id]));
    await expect(service.readTool('get_portfolio', {}, accounts[0].id)).rejects.toThrow('Select an account');
    expect(reads).toEqual(['selected', 'selected']);
  } finally { await service.close(); await db.close(); await rm(path, { recursive: true, force: true }); }
});
