import { expect, test } from 'vitest';
import { createFixture, fixtureId } from './fixture';
import { syncActionNotifications } from '../../src/main/action-notifications';
import type { NotificationInput } from '../../src/shared/notifications';

test('batched action evidence preserves legs, planned fallback, receipts and reversals across the batch boundary', async () => {
  const f = await createFixture({ seed: 'action-batch', accountsPerVenue: 1, allocationsPerAccount: 12, historyRows: 12 });
  try {
    const rows = (await f.db.query<{ id: string; allocation_id: string; account_id: string; strategy_id: string }>(`SELECT t.id,t.allocation_id,a.account_id,a.strategy_id FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id ORDER BY t.id`)).rows;
    for (const [i, r] of rows.entries()) {
      await f.db.query(`UPDATE strategy_allocation_transactions SET kind='redemption',details=$2 WHERE id=$1`, [r.id, JSON.stringify({ preview: { legs: [{ symbol: 'VTI', notional: String(i + 1) }] } })]);
      const entry = fixtureId('action-receipt', r.id);
      await f.db.query(`INSERT INTO strategy_attribution_entries(id,allocation_id,account_id,transaction_id,sequence,entry_type,cash_delta,currency,source_kind,source_ref,idempotency_key,request_hash,occurred_at,recorded_at)
        VALUES($1,$2,$3,$4,2,'capital_released',$5,'USD','synthetic','release','release','synthetic',now(),now())`, [entry, r.allocation_id, r.account_id, r.id, -(i + 1)]);
      if (i === 11) await f.db.query(`INSERT INTO strategy_attribution_entries(id,allocation_id,account_id,transaction_id,sequence,entry_type,cash_delta,currency,source_kind,source_ref,idempotency_key,request_hash,reversal_of,occurred_at,recorded_at)
        VALUES($1,$2,$3,$4,3,'reversal',$5,'USD','synthetic','reverse','reverse','synthetic',$6,now(),now())`, [fixtureId('action-reversal', r.id), r.allocation_id, r.account_id, r.id, i + 1, entry]);
      if (i === 0) for (const [j, symbol] of ['VTI', 'QQQ'].entries()) await f.db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'redeem',$6,'sell','filled',$7,$1,$8,$9,$9)`, [fixtureId('action-leg', String(j)), r.allocation_id, r.account_id, r.strategy_id, r.id, symbol, JSON.stringify({ dollar_amount: '0.5' }), 'a'.repeat(64), new Date(f.clock() + j).toISOString()]);
    }
    await f.db.query("UPDATE strategy_allocation_transactions SET outcome='superseded' WHERE id=$1", [rows[10].id]);
    await f.measurement.scope('actions', () => syncActionNotifications(f.db, f.clock()));
    const cards = (await f.db.query<{ payload: NotificationInput }>("SELECT payload FROM notifications WHERE payload->>'kind'='action_update'")).rows;
    expect(cards).toHaveLength(11);
    for (const [i, r] of rows.entries()) {
      const card = cards.find(c => c.payload.source.id === `rh:${r.id}`)?.payload;
      if (i === 10) { expect(card).toBeUndefined(); continue; }
      expect(card?.context).toEqual({ strategyId: r.strategy_id });
      expect(card?.action?.accounts[0].returned).toEqual(i === 11 ? [] : [{ currency: 'USD', amount: `${i + 1}.000000000000000000` }]);
      if (i === 0) {
        expect(card?.action?.state).toBe('completed');
        expect(card?.action?.orders.map(o => o.symbol)).toEqual(['VTI', 'QQQ']);
      } else {
        expect(card?.action?.state).toBe('pending');
        expect(card?.action?.orders).toMatchObject([{ id: `planned:${r.id}:0`, symbol: 'VTI', side: 'sell', amount: String(i + 1) }]);
      }
    }
    expect(f.measurement.failures).toEqual([]);
  } finally { await f.close(); }
});

test('unchanged action cards retain delivery/read state but still prune late duplicates; transitions and recovery still update', async () => {
  const f = await createFixture();
  try {
    const r = (await f.db.query<{ id: string; allocation_id: string; account_id: string; strategy_id: string }>(`SELECT t.id,t.allocation_id,a.account_id,a.strategy_id FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id LIMIT 1`)).rows[0];
    const leg = fixtureId('action-state', r.id);
    await f.db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'subscribe','VTI','buy','queued','{"dollar_amount":"100"}',$1,$6,now(),now())`, [leg, r.allocation_id, r.account_id, r.strategy_id, r.id, 'a'.repeat(64)]);
    const card = async () => (await f.db.query<{ id: string; sequence: string; payload: NotificationInput; seen: boolean; delivery: string; pruned: boolean }>("SELECT id,sequence,payload,seen,delivery,pruned FROM notifications WHERE payload->>'kind'='action_update' AND payload->'source'->>'id'=$1", [`rh:${r.id}`])).rows[0];
    await syncActionNotifications(f.db, f.clock());
    await f.db.query("UPDATE notifications SET seen=true,delivery='attempted' WHERE id=$1", [(await card()).id]);
    const before = await card();
    const duplicate = { kind: 'order_update', context: { strategyId: r.strategy_id }, source: { type: 'order', id: leg }, eventKey: 'late', order: { orderId: leg } };
    await f.db.query('SELECT record_local_notification($1::jsonb)', [JSON.stringify(duplicate)]);
    f.advance(1000);
    await f.measurement.scope('unchanged', () => syncActionNotifications(f.db, f.clock()));
    expect(await card()).toEqual(before);
    expect((await f.db.query("SELECT pruned,delivery FROM notifications WHERE payload->>'eventKey'='late'")).rows).toEqual([{ pruned: true, delivery: 'suppressed' }]);
    const queries = f.measurement.samples.filter(s => s.scope === 'unchanged' && s.operation.endsWith('query')).map(s => f.measurement.queries.get(s.label));
    expect(queries.some(q => q?.includes('record_local_notification'))).toBe(false);
    await f.db.query("UPDATE linked_accounts SET nickname='Renamed synthetic account' WHERE id=$1", [r.account_id]);
    await syncActionNotifications(f.db, f.clock());
    const renamed = await card();
    expect(renamed.payload.action?.accounts[0].label).toBe('Renamed synthetic account');
    expect(renamed.sequence).toBe(before.sequence);
    expect(renamed.seen).toBe(true); expect(renamed.delivery).toBe('attempted');
    await f.db.query("UPDATE strategy_executions SET status='filled' WHERE id=$1", [leg]);
    f.advance(1000);
    await syncActionNotifications(f.db, f.clock());
    const complete = await card();
    expect(complete.payload.action).toMatchObject({ state: 'completed', updatedAt: new Date(f.clock()).toISOString() });
    expect(complete.seen).toBe(false); expect(complete.delivery).toBe('pending');
    expect(BigInt(complete.sequence)).toBeGreaterThan(BigInt(before.sequence));
    await f.db.query("UPDATE notifications SET seen=true,delivery='attempted' WHERE id=$1", [complete.id]);
    await f.db.query("UPDATE strategy_allocation_transactions SET outcome='failed' WHERE id=$1", [r.id]);
    f.advance(1000);
    await syncActionNotifications(f.db, f.clock(), true);
    const recovery = await card();
    expect(recovery.payload.action?.state).toBe('attention');
    expect(recovery.seen).toBe(false); expect(recovery.delivery).toBe('attempted');
    await f.db.query('UPDATE notifications SET pruned=true WHERE id=$1', [recovery.id]);
    await syncActionNotifications(f.db, f.clock());
    expect((await card()).pruned).toBe(true);
    expect(f.measurement.failures).toEqual([]);
  } finally { await f.close(); }
});
