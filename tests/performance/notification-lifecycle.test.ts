import { expect, test } from 'vitest';
import { createFixture, fixtureId, SMOKE_SIZE } from './fixture';
import { createCoinbaseLifecycle } from '../../src/main/coinbase/lifecycle';
import { syncCoinbaseLifecycleNotifications } from '../../src/main/coinbase/lifecycle-notifications';

test('batched lifecycle views preserve evidence and isolate unavailable Takes', async () => {
  const f = await createFixture({ ...SMOKE_SIZE, accountsPerVenue: 2, allocationsPerAccount: 12 });
  const service = createCoinbaseLifecycle(f.database, f.clock);
  const ids = f.allocations.filter(a => a.venue === 'coinbase').map(a => a.takeId);
  try {
    const original = await f.measurement.scope('single', async () => Object.fromEntries(await Promise.all(ids.map(async id => [id, await service.view(id)]))));
    const before = f.measurement.samples.filter(s => s.operation.endsWith('query')).length;
    f.measurement.samples.length = 0;
    const batch = await f.measurement.scope('batch', () => service.viewMany(ids));
    expect(batch).toEqual(original);
    expect(f.measurement.samples.filter(s => s.operation.endsWith('query')).length).toBeLessThan(before * .6);
    const missing = fixtureId('missing', 'take');
    const partial = await service.viewMany([ids[0], missing, ids[1]]);
    expect(partial).toEqual({ [ids[0]]: original[ids[0]], [missing]: null, [ids[1]]: original[ids[1]] });
    expect(await service.viewMany([])).toEqual({});
    f.advance(900_001);
    const stale = await service.viewMany(ids);
    expect(stale[ids[0]]?.blocked).toBeTruthy();
    expect(stale[ids[0]]).toEqual(await service.view(ids[0]));
    expect(f.measurement.failures).toEqual([]);
  } finally { await f.close(); }
});

test('lifecycle notices retain unresolved evidence, recover, recur, and survive restart', async () => {
  const f = await createFixture(SMOKE_SIZE);
  const account = f.accounts.find(a => a.venue === 'coinbase')!;
  const allocations = f.allocations.filter(a => a.venue === 'coinbase');
  const wallet = async (amount: string) => {
    await f.db.query(`UPDATE coinbase_transaction_history SET checked_at=$2,data=jsonb_set(data,'{wallets}',$3::jsonb) WHERE account_id=$1`,
      [account.id, new Date(f.clock()).toISOString(), JSON.stringify([{ wallet: 'synthetic', asset: 'USDC', balance: amount, available: amount, held: '0' }])]);
  };
  const notices = async () => (await f.db.query<{ id: string; resolved_at: Date | null; delivery: string }>("SELECT id,resolved_at,delivery FROM notifications WHERE payload->>'kind'='outside_sale' ORDER BY sequence")).rows;
  const tick = () => syncCoinbaseLifecycleNotifications(f.db, f.clock());
  try {
    await wallet('100'); // Two $100 allocations now share only $100 of evidence.
    await tick();
    const first = await notices();
    expect(first).toHaveLength(2);
    expect(first.every(n => n.resolved_at === null)).toBe(true);
    await tick(); // Service is recreated by each projection, including after restart.
    expect(await notices()).toEqual(first);
    f.advance(900_001);
    await tick();
    expect((await notices()).every(n => n.resolved_at === null)).toBe(true);
    await wallet('1200');
    await f.db.query("UPDATE coinbase_allocations SET restore_required=true WHERE id=$1", [allocations[0].id]);
    await tick();
    expect((await notices()).every(n => n.resolved_at === null)).toBe(true);
    await f.db.query("UPDATE coinbase_allocations SET restore_required=false WHERE id=$1", [allocations[0].id]);
    await tick();
    expect((await notices()).every(n => n.resolved_at !== null)).toBe(true);
    await wallet('100');
    await syncCoinbaseLifecycleNotifications(f.db, f.clock(), true);
    const recurring = await notices();
    expect(recurring).toHaveLength(4);
    expect(recurring.filter(n => n.resolved_at === null)).toHaveLength(2);
    await f.db.query('UPDATE takes SET archived_at=$2 WHERE id=$1', [allocations[0].takeId, new Date(f.clock()).toISOString()]);
    await tick();
    expect((await f.db.query("SELECT id FROM notifications WHERE payload->>'kind'='strategy_archived' AND resolved_at IS NULL")).rows).toHaveLength(1);
    await f.db.query('UPDATE takes SET archived_at=NULL WHERE id=$1', [allocations[0].takeId]);
    await tick();
    expect((await f.db.query("SELECT id FROM notifications WHERE payload->>'kind'='strategy_archived' AND resolved_at IS NULL")).rows).toHaveLength(0);
  } finally { await f.close(); }
});
