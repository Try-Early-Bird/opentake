import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseClient as PGlite } from './database-client';
import { encryptBackup } from './backup-crypto';
import { atomicPrivateWrite } from './private-files';

// Logical file bytes, including WAL and database metadata; never follow symlinks.
export async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    try {
      if (entry.isDirectory()) bytes += await directoryBytes(path);
      else if (entry.isFile()) bytes += (await lstat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return bytes;
}

export async function postgresAllocatedBytes(db: PGlite): Promise<number | null> {
  try {
    const result = await db.query<{ bytes: string }>('select sum(total_bytes)::text as bytes from pg_backend_memory_contexts');
    return Number(result.rows[0].bytes);
  } catch {
    return null; // This metric may not be supported by every PGlite build.
  }
}

export async function exportSnapshot(db: PGlite, destination: string, password: string): Promise<void> {
  const snapshot = await db.dumpDataDir('gzip');
  const plaintext = Buffer.from(await snapshot.arrayBuffer());
  try {
    await atomicPrivateWrite(destination, await encryptBackup(plaintext, password));
  } finally { plaintext.fill(0); }
}
