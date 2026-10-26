import { afterEach, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const guard = createRequire(import.meta.url)('./io-guard.cjs') as { attempts: string[] };
// A production service may catch an I/O exception. Still fail the test afterward.
afterEach(() => expect(guard.attempts.splice(0), 'Unexpected external I/O').toEqual([]));

vi.mock('node:worker_threads', async importOriginal => {
  const original = await importOriginal<typeof import('node:worker_threads')>();
  return { ...original, Worker: class extends original.Worker {
    constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const allowed = fileURLToPath(new URL('../../resources/database-worker.cjs', import.meta.url));
      if ((filename instanceof URL ? fileURLToPath(filename) : filename) !== allowed) {
        guard.attempts.push('unapproved worker');
        throw new Error('Only the database worker is permitted');
      }
      super(filename, { ...options, execArgv: [...(options?.execArgv ?? []), '--require',
        fileURLToPath(new URL('./io-guard.cjs', import.meta.url))] });
      this.on('message', message => {
        if (message.performanceBlockedIO) guard.attempts.push(message.performanceBlockedIO);
      });
    }
  } };
});

vi.mock('electron', () => new Proxy({}, {
  get(_target, name) {
    if (name === 'then') return undefined;
    guard.attempts.push(`electron.${String(name)}`);
    throw new Error('Electron APIs are not available in the performance harness');
  },
}));
