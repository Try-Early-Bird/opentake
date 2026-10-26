import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { directoryBytes, exportSnapshot, postgresAllocatedBytes } from '../../src/main/database-tools';
import { decryptBackup } from '../../src/main/backup-crypto';

test('storage counts nested files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-size-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'a'), 'abc');
    await writeFile(join(root, 'nested', 'b'), 'defg');
    if (process.platform !== 'win32') await symlink(join(root, 'a'), join(root, 'link'));
    expect(await directoryBytes(root)).toBe(7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('export restores all test data without changing the source database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-export-'));
  const db = new PGlite();
  let restored: PGlite | undefined;
  try {
    await db.exec('create table export_probe (value text)');
    await db.query('insert into export_probe values ($1)', ['saved']);
    expect(await postgresAllocatedBytes(db)).toBeGreaterThan(0);
    const destination = join(root, 'backup.ebbackup');
    await exportSnapshot(db, destination, 'test-only-strong-passphrase');
    const encrypted = await readFile(destination);
    expect(encrypted.subarray(0, 8).toString()).toBe('EBBACK01');
    restored = new PGlite({ loadDataDir: new Blob([await decryptBackup(encrypted, 'test-only-strong-passphrase')]) });
    expect((await restored.query('select * from export_probe')).rows).toEqual([{ value: 'saved' }]);
    expect((await db.query('select * from export_probe')).rows).toEqual([{ value: 'saved' }]);
  } finally {
    await restored?.close();
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
