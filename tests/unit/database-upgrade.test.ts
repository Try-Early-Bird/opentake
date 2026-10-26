import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import * as schema from '../../src/main/migrations';
import { createDatabaseLifecycle } from '../../src/main/database';

it('refuses to initialize over an incomplete existing database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-incomplete-'));
  const directory = join(root, 'database');
  const lifecycle = createDatabaseLifecycle(directory);
  try {
    await mkdir(directory); await writeFile(join(directory, 'retained-data'), 'synthetic');
    await expect(lifecycle.start()).rejects.toThrow('refusing to initialize');
    expect(await readFile(join(directory, 'retained-data'), 'utf8')).toBe('synthetic');
    expect(await readdir(directory)).toEqual(['retained-data']);
  } finally { await lifecycle.close(); await rm(root, { recursive: true, force: true }); }
});

async function legacy(root: string) {
  const db = new PGlite(join(root, 'database'));
  await schema.migrate(db, schema.migrations.slice(0, -1));
  await db.exec("CREATE TABLE upgrade_probe(value text); INSERT INTO upgrade_probe VALUES ('synthetic user data');");
  await db.exec(`INSERT INTO platform_connections(owner_id,venue,credential_ref,status)
    SELECT id,'synthetic','synthetic-reference','connected' FROM local_owners;
    INSERT INTO takes(id,owner_id,title,selection,draft)
    SELECT '11111111-1111-4111-8111-111111111111',id,'Retained take','{}','Unsaved draft' FROM local_owners;`);
  const owners = (await db.query('SELECT id FROM local_owners')).rows;
  await db.close();
  await writeFile(join(root, 'preferences.json'), '{"theme":"dark"}');
  return owners;
}
it('stages an upgrade, preserves the old database and preferences, and reopens the new data', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-upgrade-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  let previous: PGlite | undefined;
  let reopened: ReturnType<typeof createDatabaseLifecycle> | undefined;
  try {
    const owners = await legacy(root);
    const db = await lifecycle.start();
    expect((await db.query('SELECT id FROM local_owners')).rows).toEqual(owners);
    expect((await db.query('SELECT * FROM upgrade_probe')).rows).toEqual([{ value: 'synthetic user data' }]);
    expect(await schema.migrationHistory(db)).toHaveLength(schema.migrations.length);
    expect((await db.query("SELECT credential_ref,status FROM platform_connections WHERE venue='synthetic'")).rows).toEqual([{ credential_ref: 'synthetic-reference', status: 'connected' }]);
    expect((await db.query("SELECT title,draft FROM takes WHERE id='11111111-1111-4111-8111-111111111111'")).rows).toEqual([{ title: 'Retained take', draft: 'Unsaved draft' }]);
    expect(lifecycle.directory).not.toBe(join(root, 'database'));
    expect(await readFile(join(root, 'preferences.json'), 'utf8')).toBe('{"theme":"dark"}');
    previous = new PGlite(join(root, 'database'));
    expect(await schema.migrationHistory(previous)).toHaveLength(schema.migrations.length - 1);
    expect((await previous.query('SELECT * FROM upgrade_probe')).rows).toEqual([{ value: 'synthetic user data' }]);
    await previous.close(); previous = undefined;
    await db.exec("INSERT INTO upgrade_probe VALUES ('after upgrade')");
    const directory = lifecycle.directory;
    await lifecycle.close();
    reopened = createDatabaseLifecycle(join(root, 'database'));
    const next = await reopened.start();
    expect(reopened.directory).toBe(directory);
    expect((await next.query('SELECT * FROM upgrade_probe')).rows).toHaveLength(2);
    expect((await readdir(root)).filter(name => name.startsWith('upgrade-'))).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await previous?.close(); await reopened?.close(); await lifecycle.close(); await rm(root, { recursive: true, force: true }); }
});
it('a partially committed failed migration never modifies or replaces the original database', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-upgrade-failed-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  let old: PGlite | undefined;
  try {
    await legacy(root);
    vi.spyOn(schema, 'migrate').mockImplementationOnce(async db => {
      await db.exec("DELETE FROM upgrade_probe");
      throw new Error('Synthetic migration failure');
    });
    await expect(lifecycle.start()).rejects.toThrow('Synthetic migration failure');
    await expect(readFile(join(root, 'database.active'))).rejects.toMatchObject({ code: 'ENOENT' });
    old = new PGlite(join(root, 'database'));
    expect((await old.query('SELECT * FROM upgrade_probe')).rows).toEqual([{ value: 'synthetic user data' }]);
    expect(await schema.migrationHistory(old)).toHaveLength(schema.migrations.length - 1);
  } finally { vi.restoreAllMocks(); await old?.close(); await lifecycle.close(); await rm(root, { recursive: true, force: true }); }
});
