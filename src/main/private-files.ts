import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// POSIX permissions are not Windows ACLs. Windows relies on the user's profile ACL.
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe storage directory');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export async function secureTree(path: string): Promise<void> {
  await privateDirectory(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) throw new Error('Storage links are not allowed');
    if (stat.isDirectory()) await secureTree(child);
    else if (stat.isFile()) { if (process.platform !== 'win32') await chmod(child, 0o600); }
    else throw new Error('Unexpected storage entry');
  }
}

export async function atomicPrivateWrite(path: string, data: Buffer): Promise<void> {
  const temporary = join(dirname(path), `.write-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
