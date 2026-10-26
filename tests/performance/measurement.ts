import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DatabaseClient } from '../../src/main/database-client';

export interface Sample {
  scope: string;
  operation: string;
  label: string;
  elapsedMs: number;
  outcome: 'ok' | 'error';
  rows?: number;
}

/** Public-call latency includes queue wait and IPC. It is NOT query execution time. */
export function measureDatabase(db: DatabaseClient) {
  const scopes = new AsyncLocalStorage<string | undefined>();
  const samples: Sample[] = [];
  const queries = new Map<string, string>();
  const failures: unknown[] = [];
  async function timed<T>(operation: string, label: string, work: () => Promise<T>): Promise<T> {
    const scope = scopes.getStore();
    if (!scope) return work(); // Fixture setup is deliberately excluded.
    const started = performance.now();
    let outcome: Sample['outcome'] = 'error';
    let rows: number | undefined;
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) rows = result.rows.length;
      outcome = 'ok';
      return result;
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      samples.push({ scope, operation, label, elapsedMs: performance.now() - started, outcome, ...(rows === undefined ? {} : { rows }) });
    }
  }
  function wrap<T extends object>(target: T, insideTransaction = false): T {
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      if (key === 'query' || key === 'exec') return (...args: unknown[]) => {
        const normalized = String(args[0]).replace(/\s+/g, ' ').trim();
        const label = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
        if (scopes.getStore()) queries.set(label, normalized);
        return timed(`${insideTransaction ? 'transaction.' : ''}${String(key)}`, label, () => value.apply(object, args));
      };
      if (key === 'transaction') return (work: (tx: object) => Promise<unknown>) => {
        // The worker queue may invoke this callback from another submitter's
        // async context. Restore ours so nested query labels stay attributable.
        const scope = scopes.getStore();
        return timed('transaction', 'transaction', () => value.call(object, (tx: object) =>
          scopes.run(scope, () => work(wrap(tx, true)))));
      };
      return value.bind(object);
    } });
  }
  const client = wrap(db);
  return {
    client, samples, queries, failures,
    scope: <T>(name: string, work: () => Promise<T>) => scopes.run(name, () => timed('service', name, work)),
    // Transaction and service samples contain child samples; never sum all durations.
    unavailable: ['exactQueueWait', 'workerQueryExecutionTime'] as const,
  };
}
