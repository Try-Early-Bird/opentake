import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/main/migrations';
import { getJobRetention, setJobRetention, pruneJobHistory, readJobDetails } from '../../src/main/job-history';

test('job details record transitions and safe errors without inventing logs for older jobs', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    await db.exec(`INSERT INTO platform_connections(owner_id, venue)
      SELECT id, 'robinhood' FROM local_owners;
      INSERT INTO background_jobs(connection_id, kind, state, reason)
      SELECT id, 'account_sync', 'pending', 'manual' FROM platform_connections;`);
    const id = (await db.query<{ id: string }>('SELECT id FROM background_jobs')).rows[0].id;
    await db.exec(`UPDATE background_jobs SET state = 'running', attempts = 1;
      UPDATE background_jobs SET state = 'retrying', error_code = 'transient', next_run_at = now() + interval '10 seconds';
      UPDATE background_jobs SET state = 'running', attempts = 2, error_code = NULL;
      UPDATE background_jobs SET state = 'completed';`);
    const details = await readJobDetails(db, id);
    expect(details?.events.map(event => event.state)).toEqual(['pending', 'running', 'retrying', 'running', 'completed']);
    expect(details?.events[2]).toMatchObject({ attempts: 1, errorCode: 'transient' });
    expect(details?.job).toMatchObject({ attempts: 2, state: 'completed' });
    expect(details?.truncated).toBe(false);
    await db.exec("UPDATE background_jobs SET error_code = 'synthetic-unrecognized-error'");
    expect((await readJobDetails(db, id))?.events.at(-1)?.errorCode).toBe('unknown');
    await db.exec('DELETE FROM job_events');
    expect((await readJobDetails(db, id))?.events).toEqual([]);
    await expect(readJobDetails(db, 'not-a-uuid')).rejects.toThrow();
    await db.exec('DELETE FROM background_jobs');
    expect(await readJobDetails(db, id)).toBeNull();
  } finally { await db.close(); }
});

test('retention defaults to forever, deletes eligible history and logs, and preserves active or unresolved jobs', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    await db.exec(`INSERT INTO platform_connections(owner_id, venue)
      SELECT id, 'robinhood' FROM local_owners;
      INSERT INTO background_jobs(connection_id, kind, state, reason, updated_at)
      SELECT c.id, 'account_sync', state, 'manual', now() - interval '100 days'
      FROM platform_connections c CROSS JOIN unnest(ARRAY['completed','cancelled','pending','failed','needs_attention']) state;
      INSERT INTO background_jobs(connection_id, kind, state, reason)
      SELECT id, 'account_sync', 'completed', 'manual' FROM platform_connections;`);
    expect(await getJobRetention(db)).toBeNull();
    await pruneJobHistory(db);
    expect((await db.query('SELECT id FROM background_jobs')).rows).toHaveLength(6);
    for (const bad of [0, -1, 1, 31, '7', undefined]) await expect(setJobRetention(db, bad)).rejects.toThrow();
    expect(await setJobRetention(db, 30)).toBe(30);
    expect(await getJobRetention(db)).toBe(30);
    expect((await db.query('SELECT id FROM background_jobs')).rows).toHaveLength(4);
    expect((await db.query('SELECT id FROM job_events')).rows).toHaveLength(4);
    expect((await db.query<{ state: string }>('SELECT state FROM background_jobs ORDER BY state')).rows.map(row => row.state)).toEqual(['completed', 'failed', 'needs_attention', 'pending']);
    await pruneJobHistory(db, Date.now() + 31 * 86400_000);
    expect((await db.query('SELECT id FROM background_jobs')).rows).toHaveLength(3);
    expect(await setJobRetention(db, null)).toBeNull();
    expect(await getJobRetention(db)).toBeNull();
  } finally { await db.close(); }
});
