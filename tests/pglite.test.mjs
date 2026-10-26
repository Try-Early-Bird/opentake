import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseLifecycle } from '../src/main/database.ts';
import { temporaryProfile } from './helpers/profile.mjs';
import { writeFile, readFile } from 'node:fs/promises';

test('PGlite runs an in-memory query without schema or migrations', async () => {
  const db = new PGlite();
  try {
    const result = await db.query('select 1 as ready');
    assert.deepEqual(result.rows, [{ ready: 1 }]);
  } finally {
    await db.close();
  }
});

test('an invalid database path fails without deleting the existing file', async () => {
  const profile = await temporaryProfile();
  const lifecycle = createDatabaseLifecycle(profile.database);
  try {
    await writeFile(profile.database, 'preserve existing data');
    await assert.rejects(lifecycle.start());
    await lifecycle.close();
    assert.equal(await readFile(profile.database, 'utf8'), 'preserve existing data');
  } finally {
    await profile.cleanup();
  }
});

test('disk-backed lifecycle reuses its instance and reloads data after close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-persistence-'));
  const first = createDatabaseLifecycle(join(root, 'database'));
  const second = createDatabaseLifecycle(join(root, 'database'));
  try {
    const [a, b] = await Promise.all([first.start(), first.start()]);
    assert.equal(a, b);
    // Test-only table in a disposable directory, not an application migration.
    await a.exec('create table persistence_probe (value text)');
    await a.query('insert into persistence_probe values ($1)', ['survives restart']);
    await Promise.all([first.close(), first.close()]);
    await assert.rejects(first.start(), /shutting down/);
    const reopened = await second.start();
    assert.deepEqual((await reopened.query('select value from persistence_probe')).rows,
      [{ value: 'survives restart' }]);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown waits for initialization without leaving the database open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-startup-quit-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  try {
    const starting = lifecycle.start();
    await lifecycle.close();
    assert.equal((await starting).closed, true);
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
