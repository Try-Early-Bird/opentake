import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { backgroundDatabaseWork } from '../../src/main/database-client';
import { createFixture, fixtureId, SMOKE_SIZE } from './fixture';
import { createServices } from './services';

test('queued transaction queries retain their submitting measurement scope', async () => {
  const f = await createFixture({ ...SMOKE_SIZE, historyRows: 3 });
  try {
    await Promise.all(['first', 'second'].map(name => f.measurement.scope(name, () =>
      f.db.transaction(tx => tx.query(`SELECT 1 AS ${name}_scope`)))));
    for (const name of ['first', 'second']) {
      const query = f.measurement.samples.find(s => f.measurement.queries.get(s.label) === `SELECT 1 AS ${name}_scope`);
      expect(query?.scope).toBe(name);
    }
  } finally { await f.close(); }
});

test('seeded worker fixture exercises foreground reads, reconciliation, and both due schedulers', async () => {
  const f = await createFixture({ ...SMOKE_SIZE, historyRows: 396 });
  const services = createServices(f);
  try {
    expect(f.worker.ready).toBe(true);
    expect(f.measurement.samples).toEqual([]); // Migrations and seeding are not timed.
    const count = async (table: string) => Number((await f.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count);
    expect(await count('take_messages')).toBe(132);
    expect(await count('coinbase_portfolio_observations')).toBe(133);
    expect(await count('strategy_reconciliation_cases')).toBe(133);
    expect(await count('strategy_allocations')).toBe(2);
    expect(await count('coinbase_allocations')).toBe(2);
    expect(await count('account_orders')).toBe(0);
    const first = f.allocations[0];
    const takeList = await f.measurement.scope('foreground.takes', () => services.history.takes(false));
    expect(new Set(takeList.items.map(t => t.id))).toEqual(new Set(f.allocations.map(a => a.takeId)));
    expect(takeList.items.every(t => t.strategy?.invested)).toBe(true);
    const messages = await f.measurement.scope('foreground.messages', () => services.history.messages(first.takeId, first.headId));
    expect(messages.messages).toHaveLength(30);
    expect(messages.messages.at(-1)?.id).toBe(first.headId);
    expect(messages.messages.every(m => m.text.startsWith('Synthetic history ') && m.versionCount === 1)).toBe(true);
    expect(messages.next).not.toBeNull();
    const older = await services.history.messages(first.takeId, first.headId, messages.next);
    expect(older.messages).toHaveLength(3);
    expect(older.next).toBeNull();
    expect(new Set([...messages.messages, ...older.messages].map(m => m.id)).size).toBe(33);
    const account = f.accounts.find(a => a.venue === 'coinbase')!;
    const portfolio = await f.measurement.scope('foreground.portfolio', () => services.portfolio.snapshot(account.id));
    expect(portfolio.account?.id).toBe(account.id);
    expect(portfolio.portfolio?.totalValue).toBe(account.balance);
    expect(portfolio.spotPositions?.[0].takeAllocations).toHaveLength(2);
    expect(portfolio.history.length).toBeGreaterThan(0);

    await f.measurement.scope('background.notifications', () => backgroundDatabaseWork(() => services.notifications.tick()));
    const inbox = await f.measurement.scope('foreground.notifications', () => services.notifications.list());
    expect(inbox.items.some(item => item.takeEvent?.event === 'missing_evidence' && item.takeEvent.allocationId === first.id)).toBe(true);
    const notificationsBefore = await count('notifications');
    f.advance(61_000); // Beyond the maximum reconciliation cooldown.
    await services.notifications.tick();
    expect(await count('notifications')).toBe(notificationsBefore);

    await f.measurement.scope('background.robinhood', () => backgroundDatabaseWork(() => services.robinhood.tick()));
    await f.measurement.scope('background.coinbase', () => backgroundDatabaseWork(() => services.coinbase.tick()));
    expect(services.calls.filter(c => c.venue === 'robinhood').map(c => c.id).sort()).toEqual(f.allocations.filter(a => a.venue === 'robinhood').map(a => a.id).sort());
    expect(services.calls.filter(c => c.venue === 'robinhood').every(c => c.trigger === 'scheduled')).toBe(true);
    expect(services.calls.filter(c => c.venue === 'coinbase').map(c => c.id).sort()).toEqual(f.allocations.filter(a => a.venue === 'coinbase').map(a => a.takeId).sort());
    expect((await f.db.query('SELECT state FROM coinbase_rebalance_runs')).rows).toEqual([{ state: 'completed' }, { state: 'completed' }]);
    expect(await count('account_orders')).toBe(0);
    expect(services.unexpectedCalls).toEqual([]);
    expect(f.measurement.samples.some(s => s.operation === 'transaction.query')).toBe(true);
    expect(f.measurement.failures.map(error => error instanceof Error ? error.stack : error)).toEqual([]);
    expect(f.measurement.samples.every(s => Number.isFinite(s.elapsedMs) && s.elapsedMs >= 0)).toBe(true);
    expect(f.measurement.unavailable).toContain('exactQueueWait');
  } finally { await services.stop(); await f.close(); }
  expect(f.worker.closed).toBe(true);
  await expect(access(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('fixture recreates the same domain manifest and records injected provider failures', async () => {
  const size = { ...SMOKE_SIZE, allocationsPerAccount: 1, historyRows: 3 };
  const first = await createFixture(size);
  const manifest = structuredClone(first.manifest);
  await first.close();
  const f = await createFixture(size);
  const services = createServices(f, { rejectCall: 1, delayMs: 1 });
  try {
    expect(f.manifest).toEqual(manifest);
    expect(f.accounts[0].id).not.toBe(fixtureId('different-seed', 'account:robinhood:0'));
    await services.robinhood.tick();
    expect(services.calls).toHaveLength(1);
    expect(services.calls[0].outcome).toBe('error');
    expect((await f.db.query('SELECT planning_failures FROM strategy_allocations')).rows).toEqual([{ planning_failures: 1 }]);
    await services.coinbase.tick(); // Independent invocation, not a host-isolation test.
    expect(services.calls.at(-1)).toMatchObject({ venue: 'coinbase', outcome: 'ok' });
    expect(services.unexpectedCalls).toEqual([]);
  } finally { await services.stop(); await f.close(); }
  await expect(createFixture({ ...SMOKE_SIZE, historyRows: -1 })).rejects.toThrow('positive integers');
});

test('scaled fixture crosses the Robinhood page boundary without missing eligible allocations', async () => {
  const f = await createFixture({ ...SMOKE_SIZE, accountsPerVenue: 2, allocationsPerAccount: 26 });
  const services = createServices(f);
  try {
    await services.robinhood.tick();
    expect(services.calls).toHaveLength(50);
    await services.robinhood.tick();
    expect(new Set(services.calls.map(c => c.id))).toEqual(new Set(f.allocations.filter(a => a.venue === 'robinhood').map(a => a.id)));
    expect(services.unexpectedCalls).toEqual([]);
  } finally { await services.stop(); await f.close(); }
});

test('external I/O tripwire rejects fetch, sockets, and subprocesses before dispatch', async () => {
  const require = createRequire(import.meta.url);
  const guard = require('./io-guard.cjs') as { attempts: string[] };
  // These intentional probes consume their evidence; all other attempts fail afterEach.
  try {
    expect(() => fetch('https://example.invalid')).toThrow('blocked external I/O');
    const socket = new (require('node:net').Socket)();
    try { expect(() => socket.connect(443, 'example.invalid')).toThrow('blocked external I/O'); }
    finally { socket.destroy(); }
    expect(() => require('node:child_process').spawn('not-a-real-command')).toThrow('blocked external I/O');
    expect(guard.attempts).toEqual(['fetch', 'net.Socket.connect', 'node:child_process.spawn']);
  } finally { guard.attempts.splice(0); }
});
