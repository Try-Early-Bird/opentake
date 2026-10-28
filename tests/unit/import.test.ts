import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { expect, test } from 'vitest';
import { validateArchive } from '../../src/main/import-archive';
import { createDatabaseLifecycle } from '../../src/main/database';

test('validated import replaces data, retains the previous database, and persists across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-import-test-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  const source = new PGlite();
  let backup: PGlite | undefined;
  let restarted: ReturnType<typeof createDatabaseLifecycle> | undefined;
  try {
    const original = await lifecycle.start();
    await original.exec("create table marker(value text); insert into marker values ('original')");
    await source.exec("create table marker(value text); insert into marker values ('imported')");
    const archive = Buffer.from(await (await source.dumpDataDir('gzip')).arrayBuffer());
    const snapshot = validateArchive(archive);
    const retained = await lifecycle.replace(snapshot);
    expect(retained).toBe(join(root, 'database'));
    expect(lifecycle.directory).not.toBe(retained);
    expect(await lifecycle.use(async db => (await db.query('select * from marker')).rows)).toEqual([{ value: 'imported' }]);
    backup = new PGlite(retained);
    expect((await backup.query('select * from marker')).rows).toEqual([{ value: 'original' }]);
    await lifecycle.close();
    restarted = createDatabaseLifecycle(join(root, 'database'));
    await restarted.start();
    expect(await restarted.use(async db => (await db.query('select * from marker')).rows)).toEqual([{ value: 'imported' }]);
  } finally {
    await lifecycle.close();
    await restarted?.close();
    await backup?.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed activation rolls back without replacing the previous database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-import-rollback-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  const source = new PGlite();
  try {
    const db = await lifecycle.start();
    await db.exec("create table marker(value text); insert into marker values ('original')");
    // Force the atomic pointer rename to fail after the original database closes.
    await mkdir(join(root, 'database.active'));
    const snapshot = validateArchive(Buffer.from(await (await source.dumpDataDir('gzip')).arrayBuffer()));
    await expect(lifecycle.replace(snapshot)).rejects.toThrow();
    expect(await lifecycle.use(async reopened => (await reopened.query('select * from marker')).rows)).toEqual([{ value: 'original' }]);
  } finally {
    await lifecycle.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('missing import target does not silently initialize an empty database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-import-pointer-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  try {
    await writeFile(join(root, 'database.active'), 'database.import-11111111-1111-1111-1111-111111111111');
    await expect(lifecycle.start()).rejects.toThrow();
    await expect(readFile(join(root, 'database', 'PG_VERSION'))).rejects.toThrow();
  } finally { await lifecycle.close(); await rm(root, { recursive: true, force: true }); }
});

test('corrupt archives and traversal/link entries are rejected', async () => {
  expect(() => validateArchive(Buffer.from('not a gzip'))).toThrow();
  const db = new PGlite();
  try {
    // PGlite 0.5.13 no longer queues a dump until the database is ready.
    await db.waitReady;
    const tar = gunzipSync(Buffer.from(await (await db.dumpDataDir('gzip')).arrayBuffer()));
    for (const unsafe of ['path', 'link']) {
      const changed = Buffer.from(tar);
      if (unsafe === 'path') { changed.fill(0, 0, 100); changed.write('/../outside', 0); }
      else changed[156] = 50;
      changed.fill(32, 148, 156);
      const checksum = changed.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      changed.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
      expect(() => validateArchive(gzipSync(changed))).toThrow();
    }
  } finally { await db.close(); }
});
