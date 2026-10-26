import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabaseLifecycle } from '../../src/main/database';
import { createMaintenance } from '../../src/main/maintenance';
import { readJobHistory } from '../../src/main/job-history';

test('job history retains more than 100 jobs and pages tied timestamps without gaps or duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-history-'));
  const database = createDatabaseLifecycle(join(root, 'database'));
  const maintenance = createMaintenance(database, {
    busy: () => false, cancel: () => {},
    refresh: async () => ({ status: 'connected', checkedAt: null, accounts: [] }),
  }, () => false);
  try {
    await database.start();
    await database.use(db => db.exec(`INSERT INTO platform_connections(owner_id, venue, credential_ref, maintenance_enabled)
      SELECT id, 'robinhood', 'synthetic-reference', true FROM local_owners;
      INSERT INTO background_jobs(connection_id, kind, state, reason, updated_at)
      SELECT c.id, 'account_sync', CASE WHEN n % 3 = 0 THEN 'failed' WHEN n % 3 = 1 THEN 'completed' ELSE 'cancelled' END,
        'scheduled', '2026-01-01 00:00:00.123456+00'::timestamptz + (n % 2) * interval '1 microsecond'
      FROM platform_connections c CROSS JOIN generate_series(1, 125) n;
      INSERT INTO background_jobs(connection_id, kind, state, reason)
      SELECT id, 'account_sync', 'pending', 'manual' FROM platform_connections;`));
    await maintenance.tick();
    const expected = await database.use(async db => (await db.query<{ id: string }>(
      "SELECT id FROM background_jobs ORDER BY updated_at DESC, id DESC")).rows.map(row => row.id));
    expect(expected).toHaveLength(126);
    const first = await database.use(db => readJobHistory(db, null));
    expect(first.jobs).toHaveLength(50);
    expect(first.nextCursor?.updatedAt).toContain('.123457');
    // A new completion between requests must not shift the next page.
    await database.use(db => db.exec(`INSERT INTO background_jobs(connection_id, kind, state, reason)
      SELECT id, 'account_sync', 'completed', 'manual' FROM platform_connections;`));
    const second = await database.use(db => readJobHistory(db, first.nextCursor));
    const third = await database.use(db => readJobHistory(db, second.nextCursor));
    expect(second.jobs).toHaveLength(50);
    expect(third.jobs).toHaveLength(26);
    expect(third.nextCursor).toBeNull();
    expect([...first.jobs, ...second.jobs, ...third.jobs].map(job => job.id)).toEqual(expected);
    expect(first.jobs[0]).toMatchObject({ kind: 'account_sync', state: 'completed' });
    await expect(database.use(db => readJobHistory(db, { id: 'invalid', updatedAt: 'yesterday' }))).rejects.toThrow();
    await database.use(db => db.exec('DELETE FROM background_jobs'));
    expect(await database.use(db => readJobHistory(db))).toEqual({ jobs: [], nextCursor: null });
  } finally {
    await maintenance.stop(); await database.close(); await rm(root, { recursive: true, force: true });
  }
});

test('history merges terminal trading orders with sync jobs and pages tied timestamps', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import('../../src/main/migrations');
  const { randomUUID } = await import('node:crypto');
  const db = new PGlite();
  try {
    await migrate(db);
    const connection = (await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue) SELECT id,'robinhood' FROM local_owners RETURNING id`)).rows[0].id;
    const account = (await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic','••1234',true,true) RETURNING id`,[connection])).rows[0].id;
    const strategy = randomUUID(), version = randomUUID(), allocation = randomUUID();
    await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
    await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
      SELECT $1,$2,id,1,1,'{"title":"Synthetic take"}','{}','{}','{}' FROM local_owners`,[version,strategy]);
    await db.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'USD','active',now(),now())`,[allocation,account,strategy,version]);
    const at='2026-10-10 12:00:00.123456+00';
    const ids:string[]=[];
    for(let i=0;i<53;i++) {
      const id=randomUUID();ids.push('trade:'+id);
      await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at,terminal_at)
        VALUES($1,$2,$3,$4,$5,$6,'VTI',$7,$8,'{}',$1,$9,$10,$10,$10)`,
        [id,allocation,account,strategy,version,i%2?'rebalance':'subscribe',i%2?'sell':'buy',['filled','failed','cancelled'][i%3],'a'.repeat(64),at]);
    }
    for(const [index,status] of ['queued','submitted','partially_filled','placement_unknown','reconciliation_required'].entries()) {
      await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'rebalance',$6,'buy',$7,'{}',$1,$8,$9,$9)`,
        [randomUUID(),allocation,account,strategy,version,'TEST'+index,status,'b'.repeat(64),at]);
    }
    const sync=(await db.query<{id:string}>(`INSERT INTO background_jobs(connection_id,kind,state,reason,updated_at) VALUES($1,'account_sync','completed','scheduled',$2) RETURNING id`,[connection,at])).rows[0].id;
    const first=await readJobHistory(db);
    expect(first.jobs).toHaveLength(50);
    expect(first.nextCursor?.updatedAt).toContain('.123456');
    const second=await readJobHistory(db,first.nextCursor);
    const all=[...first.jobs,...second.jobs];
    expect(all.map(j=>j.id)).toEqual([...ids,sync].sort().reverse());
    expect(second.nextCursor).toBeNull();
    expect(all.filter(j=>j.execution)).toHaveLength(53);
    expect(all.find(j=>j.execution?.status==='filled')).toMatchObject({state:'completed',execution:{strategyId:strategy,strategyTitle:'Synthetic take',symbol:'VTI'}});
    expect(all.find(j=>j.execution?.status==='failed')).toMatchObject({state:'failed'});
    expect(all.find(j=>j.execution?.status==='cancelled')).toMatchObject({state:'cancelled'});
    expect((await db.query('SELECT id FROM strategy_executions')).rows).toHaveLength(58);
  } finally { await db.close(); }
});
