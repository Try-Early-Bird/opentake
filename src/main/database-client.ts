import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import type { PGlite, Transaction, QueryOptions, Results } from '@electric-sql/pglite';

export type DatabaseClient = Pick<PGlite, 'query' | 'exec' | 'transaction' | 'dumpDataDir'>;
const background = new AsyncLocalStorage<boolean>();
export const backgroundDatabaseWork = <T>(work: () => Promise<T>): Promise<T> => background.run(true, work);
export const databaseWorkerPath = new URL('../../resources/database-worker.cjs', import.meta.url);

/** One worker owns the physical connection; a transaction holds the queue until settled. */
export class WorkerDatabase implements DatabaseClient {
  readonly waitReady: Promise<void>;
  ready = false;
  closed = false;
  private worker: Worker;
  private failure?: Error;
  private closing?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private queue: { run(): Promise<void>; background: boolean; at: number }[] = [];
  private running = false;
  constructor(directory?: string, options?: { loadDataDir: Blob }) {
    this.worker = new Worker(databaseWorkerPath, { workerData: { directory, options } });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.waitReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Fail closed without automatically reopening or replaying a possibly committed write.
    const fail = () => {
      this.failure ??= new Error('Database worker unavailable. Restart the app to recover.');
      this.ready = false; this.closed = true;
      rejectReady(this.failure);
      for (const request of this.pending.values()) request.reject(this.failure);
      this.pending.clear();
      void this.drain();
      void this.worker.terminate();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => { if (!this.closed) fail(); });
    this.worker.on('message', message => {
      if (message.ready) { this.ready = true; resolveReady(); return; }
      if (message.failed) { fail(); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error('Database operation failed.'), { code: message.code }));
      else request.resolve(message.value);
    });
  }
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    await this.waitReady;
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Database is closed');
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private schedule<T>(work: () => Promise<T>, closingTask = false): Promise<T> {
    if (this.closing || this.closed) return Promise.reject(this.failure ?? new Error('Database is closing'));
    if (!closingTask && this.queue.length >= 1024) return Promise.reject(new Error('Database busy. Try again shortly.'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ background: closingTask || background.getStore() === true, at: Date.now(), run: async () => {
        try { if (this.failure) throw this.failure; resolve(await work()); } catch (error) { reject(error); }
      } });
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        // Foreground first, with aging so sustained UI traffic cannot starve maintenance.
        const index = this.queue[0].at < Date.now() - 5000 ? 0 : this.queue.findIndex(item => !item.background);
        await this.queue.splice(Math.max(0, index), 1)[0].run();
      }
    } finally { this.running = false; }
  }
  query<T>(sql: string, params?: any[], options?: QueryOptions): Promise<Results<T>> {
    return this.schedule(() => this.call('query', [sql, params, options]));
  }
  exec(sql: string, options?: QueryOptions): Promise<Results[]> {
    return this.schedule(() => this.call('exec', [sql, options]));
  }
  dumpDataDir(compression?: Parameters<PGlite['dumpDataDir']>[0]): ReturnType<PGlite['dumpDataDir']> {
    return this.schedule(() => this.call('dump', [compression]));
  }
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.schedule(async () => {
      await this.call('exec', ['BEGIN']);
      let closed = false;
      const check = () => { if (closed) throw new Error('Transaction is closed'); };
      const tx: Transaction = {
        query: (sql, params, options) => { check(); return this.call('query', [sql, params, options]); },
        exec: (sql, options) => { check(); return this.call('exec', [sql, options]); },
        sql: (parts, ...params) => { check(); return this.call('query', [parts.reduce((sql, part, i) => sql + (i ? `$${i}` : '') + part, ''), params]); },
        rollback: async () => { check(); await this.call('exec', ['ROLLBACK']); closed = true; },
        listen: async () => { throw new Error('Database notifications are not exposed by this worker'); },
        get closed() { return closed; },
      };
      try {
        const value = await work(tx);
        if (!closed) await this.call('exec', ['COMMIT']);
        return value;
      } catch (error) {
        if (!closed && !this.failure) await this.call('exec', ['ROLLBACK']);
        throw error;
      } finally { closed = true; }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Enqueue behind accepted work; closing rejects new submissions immediately.
    this.closing = this.schedule(async () => {
      try { await this.call('close', []); } finally { this.closed = true; this.ready = false; }
    }, true).finally(async () => { await this.worker.terminate(); });
    return this.closing;
  }
}
