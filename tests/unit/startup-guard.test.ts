import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrate, migrations } from '../../src/main/migrations';

const baseline = JSON.parse(readFileSync(new URL('../fixtures/migration-checksums.json', import.meta.url), 'utf8'));

test('existing migration SQL is immutable and new versions are consecutive', () => {
  const current = migrations.map(m => ({version:m.version,name:m.name,checksum:createHash('sha256').update(m.sql).digest('hex')}));
  expect(current.slice(0, baseline.length), 'Applied migrations must not change; append a new version.').toEqual(baseline);
  expect(current.map(m => m.version)).toEqual(current.map((_, index) => index + 1));
});

test('migrations install, upgrade incrementally, preserve data, and can run again', async () => {
  const db = new PGlite();
  try {
    let owner: unknown;
    for (let index = 0; index < migrations.length; index++) {
      await migrate(db, migrations.slice(0, index + 1));
      const current = (await db.query('SELECT id FROM local_owners')).rows;
      owner ??= current;
      expect(current).toEqual(owner);
    }
    const ledger = (await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
    await migrate(db);
    expect((await db.query('SELECT * FROM app_migrations ORDER BY version')).rows).toEqual(ledger);
  } finally { await db.close(); }
});

test('approval column rename preserves history from the already applied migration 12', async () => {
  const db = new PGlite();
  try {
    await migrate(db, migrations.filter(m => m.version <= 12));
    await db.exec(`
      INSERT INTO takes(id,owner_id,title,selection)
        SELECT '00000000-0000-4000-8000-000000000001',id,'Saved fixture','{}' FROM local_owners;
      INSERT INTO take_runs(id,take_id,request_id,state,configuration)
        VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','completed','{}');
      INSERT INTO tool_invocations(id,run_id,take_id,provider,server_name,tool_name,destination,state,"authorization")
        VALUES('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','fixture','fixture','fixture','local','succeeded','approved');
    `);
    const ledger = (await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
    await migrate(db);
    expect((await db.query('SELECT approval_mode,state FROM tool_invocations')).rows).toEqual([{approval_mode:'approved',state:'succeeded'}]);
    expect((await db.query('SELECT * FROM app_migrations WHERE version<=12 ORDER BY version')).rows).toEqual(ledger);
  } finally { await db.close(); }
});
