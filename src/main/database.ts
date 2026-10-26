import { documentDirectory, collectDocumentFiles, verifyDocumentFiles } from './document-files';
import { WorkerDatabase, type DatabaseClient } from './database-client';
import { access, open, readFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicPrivateWrite, secureTree } from './private-files';
import { migrate, pendingMigrations, prepareRestoredDatabase } from './migrations';
import { recoverAiAudits } from './ai-audit';

// Main-process only. The app's single-instance lock owns access to this directory.
export function createDatabaseLifecycle(dataDir: string) {
  let database: WorkerDatabase | undefined;
  let starting: Promise<WorkerDatabase> | undefined;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  let activeDirectory = dataDir;
  let replacing: Promise<string> | undefined;
  const pointer = `${dataDir}.active`;

  async function openCurrent(): Promise<WorkerDatabase> {
    try {
      const name = await readFile(pointer, 'utf8');
      if (!/^database\.import-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid database pointer');
      activeDirectory = join(dirname(dataDir), name);
      await access(join(activeDirectory, 'PG_VERSION'));
    } catch (error) {
      // A missing pointer is the original database. A missing import target is
      // not permission to silently create an empty replacement.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || activeDirectory !== dataDir) throw error;
    }
    let existing = false;
    try { await access(join(activeDirectory, 'PG_VERSION')); existing = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!existing) {
      let entries: string[] = [];
      try { entries = await readdir(activeDirectory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (entries.length) throw new Error('Existing database is incomplete; refusing to initialize over it.');
    }
    await secureTree(activeDirectory);
    database = new WorkerDatabase(activeDirectory);
    await database.waitReady;
    try {
      const pending = await pendingMigrations(database);
      if (existing && pending.length) {
        // Stage upgrades away from the only copy of a user's database. The
        // previous directory remains intact, even if a later migration fails.
        const previous = activeDirectory;
        const candidatePath = join(dirname(dataDir), `database.import-${randomUUID()}`);
        let candidate: WorkerDatabase | undefined;
        let activated = false;
        try {
          const snapshot = await database.dumpDataDir('gzip');
          await secureTree(candidatePath);
          candidate = new WorkerDatabase(candidatePath, { loadDataDir: snapshot });
          await candidate.waitReady;
          await migrate(candidate);
          await candidate.query('SELECT 1');
          await candidate.close(); candidate = undefined;
          await secureTree(candidatePath);
          // Sync the recovery record before the atomic activation. A crash
          // leaves either the old database or the fully migrated copy active.
          await atomicPrivateWrite(join(dirname(dataDir), `upgrade-${basename(candidatePath)}.json`), Buffer.from(JSON.stringify({
            previous: basename(previous), next: basename(candidatePath),
            schemaVersion: pending.at(-1)!.version, createdAt: new Date().toISOString(),
          })));
          await database.close();
          await atomicPrivateWrite(pointer, Buffer.from(basename(candidatePath)));
          activated = true;
          activeDirectory = candidatePath;
          database = new WorkerDatabase(activeDirectory);
          await database.waitReady;
        } finally {
          if (candidate?.ready) await candidate.close();
          if (!activated) await rm(candidatePath, { recursive: true, force: true });
        }
      } else await migrate(database);
      await collectDocumentFiles(database, documentDirectory(activeDirectory));
      await database.transaction(tx=>recoverAiAudits(tx,'host_restarted'));
    }
    catch (error) { if (!database.closed) await database.close(); throw error; }
    await secureTree(activeDirectory);
    return database;
  }

  return {
    get directory(): string { return activeDirectory; },
    replace(snapshot: Blob): Promise<string> {
      if (closing || replacing || !starting) return Promise.reject(new Error('Database unavailable'));
      replacing = (async () => {
        const previous = activeDirectory;
        const candidatePath = join(dirname(dataDir), `database.import-${randomUUID()}`);
        const temporaryPointer = `${pointer}.${randomUUID()}.tmp`;
        let candidate: WorkerDatabase | undefined;
        let committed = false;
        let previousClosed = false;
        try {
          await starting;
          await mkdir(candidatePath, { mode: 0o700 });
          candidate = new WorkerDatabase(candidatePath, { loadDataDir: snapshot });
          await candidate.waitReady;
          await secureTree(candidatePath);
          await candidate.query('select 1');
          await prepareRestoredDatabase(candidate);
          await collectDocumentFiles(candidate, documentDirectory(candidatePath));
          await verifyDocumentFiles(candidate, documentDirectory(candidatePath));
          await Promise.allSettled([...operations]);
          await database!.close();
          previousClosed = true;
          const file = await open(temporaryPointer, 'wx', 0o600);
          try { await file.writeFile(basename(candidatePath)); await file.sync(); }
          finally { await file.close(); }
          // The old directory is retained. Restart sees either the original
          // pointer or the validated candidate, never a half-renamed database.
          await rename(temporaryPointer, pointer);
          committed = true;
          activeDirectory = candidatePath;
          database = candidate;
          starting = Promise.resolve(candidate);
          return previous;
        } catch (error) {
          if (previousClosed && !committed) {
            database = new WorkerDatabase(previous);
            starting = database.waitReady.then(() => database!);
            await starting;
          }
          throw error;
        } finally {
          if (!committed) {
            if (candidate?.ready) await candidate.close();
            await rm(candidatePath, { recursive: true, force: true });
          }
          await rm(temporaryPointer, { force: true });
        }
      })();
      return replacing.finally(() => { replacing = undefined; });
    },
    async use<T>(operation: (db: DatabaseClient) => Promise<T>): Promise<T> {
      if (replacing) throw new Error('Database import in progress');
      if (closing) throw new Error('Database is shutting down');
      if (!starting) throw new Error('Database is not started');
      const pending = starting.then(operation);
      operations.add(pending);
      try { return await pending; }
      finally { operations.delete(pending); }
    },
    start(): Promise<WorkerDatabase> {
      if (closing) return Promise.reject(new Error('Database is shutting down'));
      starting ??= openCurrent();
      return starting;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        // Quit can arrive while initialization is still in flight.
        if (!starting) return;
        if (replacing) await replacing.catch(() => {});
        try {
          await starting;
        } catch {
          // A failed initialization has no usable database to close.
          return;
        }
        await Promise.allSettled([...operations]);
        await database!.close();
      })();
      return closing;
    },
  };
}
