import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { DatabaseClient } from './database-client';
import { atomicPrivateWrite, privateDirectory } from './private-files';
import { documentLimits } from '../shared/chat-documents';

// Inside PGDATA so ordinary files travel with the existing atomic database
// snapshots, upgrades and restores. The DB stores IDs and hashes, never paths.
export const documentDirectory = (databaseDirectory: string) => join(databaseDirectory, 'attachments', 'pdf');
export const documentHash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export function documentFiles(directory: string) {
 const path = (id: string, ordinal?: number) => {
  z.uuid().parse(id);
  if (ordinal !== undefined) z.number().int().min(0).max(49).parse(ordinal);
  return join(directory, ordinal === undefined ? `${id}.pdf` : `${id}.${ordinal}.part`);
 };
 async function prepare() {
  await privateDirectory(join(directory, '..'));
  await privateDirectory(directory);
 }
 async function read(id: string, ordinal?: number): Promise<Buffer> {
  await prepare();
  const file = await open(path(id, ordinal), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
   const stat = await file.stat(), limit = ordinal === undefined ? documentLimits.bytes : documentLimits.chunkBytes;
   if (!stat.isFile() || stat.size > limit) throw new Error('Invalid PDF storage file.');
   const data = await file.readFile();
   if (data.length !== stat.size) throw new Error('PDF storage file changed.');
   return data;
  } finally { await file.close(); }
 }
 return {
  read,
  async write(id: string, data: Buffer, ordinal?: number) {
   await prepare();
   await atomicPrivateWrite(path(id, ordinal), data);
   const saved = await read(id, ordinal);
   if (!saved.equals(data)) throw new Error('PDF storage verification failed.');
   // Persist the directory entry before a database commit releases the old copy.
   if (process.platform !== 'win32') {
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
   }
  },
  async assemble(id: string, bytes: number) {
   const parts: Buffer[] = [];
   for (let ordinal = 0; ordinal < Math.ceil(bytes / documentLimits.chunkBytes); ordinal++) {
    let part: Buffer;
    try { part = await read(id, ordinal); } catch { throw new Error('Incomplete PDF upload.'); }
    if (part.length !== Math.min(documentLimits.chunkBytes, bytes - ordinal * documentLimits.chunkBytes)) throw new Error('Incomplete PDF upload.');
    parts.push(part);
   }
   return Buffer.concat(parts);
  },
  async collect(db: Pick<DatabaseClient, 'query'>) {
   await prepare();
   const rows = (await db.query<{id:string;status:string}>('SELECT id,status FROM take_documents')).rows;
   const live = new Map(rows.map(row => [row.id,row.status]));
   for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (entry.isFile() && /^\.write-[a-f0-9-]{36}\.tmp$/.test(entry.name)) { await rm(join(directory,entry.name),{force:true}); continue; }
    const match = /^([a-f0-9-]{36})(?:\.([0-9]+)\.part|\.pdf)$/.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const status = live.get(match[1]);
    if (!status || (match[2] !== undefined && status === 'ready')) await rm(join(directory, entry.name), {force:true});
   }
  },
 };
}

/** Remove upload staging and originals whose rows no longer exist. */
export async function collectDocumentFiles(db: DatabaseClient, directory: string) {
 await db.transaction(tx=>documentFiles(directory).collect(tx));
}

/** Restores are the one place every original is checked up front: a damaged
 * import must never replace the active database. */
export async function verifyDocumentFiles(db: Pick<DatabaseClient, 'query'>, directory: string) {
 const files = documentFiles(directory);
 const rows = (await db.query<{id:string;bytes:number;file_sha256:string}>('SELECT id,bytes,file_sha256 FROM take_documents WHERE file_sha256 IS NOT NULL')).rows;
 for (const row of rows) {
  const data = await files.read(row.id).catch(() => undefined);
  if (data?.length !== row.bytes || documentHash(data) !== row.file_sha256) throw new Error('Stored PDF is missing or damaged.');
 }
}
