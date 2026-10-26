import { test, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createFixture, fixtureId } from './fixture';
import { createServices } from './services';
import { syncOrderActivity } from '../../src/main/trading/activity';
import { syncCapitalNotifications } from '../../src/main/trading/capital-notifications';
import { syncCoinbaseHealthNotifications } from '../../src/main/coinbase/sync-notifications';
import { syncCoinbaseLifecycleNotifications } from '../../src/main/coinbase/lifecycle-notifications';
import { syncTakeEventNotifications } from '../../src/main/take-event-notifications';
import { syncActionNotifications } from '../../src/main/action-notifications';

test.skipIf(process.env.EARLYBIRD_PERF_NOTIFICATIONS !== '1')('profile unchanged notification stages and incremental ticks', async () => {
  const output = process.env.EARLYBIRD_PERF_OUTPUT;
  if (!output || !isAbsolute(output) || !process.versions.node.startsWith('24.')) throw Error('Use Node 24 and an absolute output directory');
  const results = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    const f = await createFixture({ seed: 'baseline-v1', accountsPerVenue: 25, allocationsPerAccount: 10, historyRows: 10_000 });
    const s = createServices(f);
    try {
      const stages = [
        ['orders', () => syncOrderActivity(f.db, f.clock())],
        ['capital', () => syncCapitalNotifications(f.db)],
        ['health', () => syncCoinbaseHealthNotifications(f.db, f.clock())],
        ['lifecycle', () => syncCoinbaseLifecycleNotifications(f.db, f.clock())],
        ['take-events', () => syncTakeEventNotifications(f.db, f.clock())],
        ['actions', () => syncActionNotifications(f.db, f.clock())],
      ] as const;
      const measurements: { name: string; ms: number; queries: number }[] = [];
      async function measure(name: string, work: () => Promise<unknown>) {
        f.measurement.samples.length = 0;
        f.measurement.queries.clear();
        const start = performance.now();
        await f.measurement.scope(name, work);
        measurements.push({ name, ms: performance.now() - start, queries: f.measurement.samples.filter(q => q.operation.endsWith('query')).length });
        await writeFile(join(output!, `r${repetition}-${name}.json.gz`), gzipSync(JSON.stringify({ samples: f.measurement.samples, queries: Object.fromEntries(f.measurement.queries) })));
      }
      for (const [, stage] of stages) await stage();
      f.advance(61_000);
      for (const [name, stage] of stages) await measure(name, stage);
      await measure('tick-unchanged', () => s.notifications.tick());
      const allocations = f.allocations.filter(a => a.venue === 'robinhood');
      for (let i = 0; i < 100; i++) {
        const a = allocations[i % allocations.length];
        await f.db.query(`INSERT INTO strategy_reconciliation_cases(id,account_id,scope,cause,impacts,evidence,created_at,updated_at)
          VALUES($1,$2,$3,'unmatched_fill',$4,'{}',$5,$5)`, [fixtureId('notification-increment', String(i)), a.accountId, `increment:${i}`, JSON.stringify([{ allocationId: a.id }]), new Date(f.clock()).toISOString()]);
      }
      f.advance(61_000);
      await measure('tick-incremental', () => s.notifications.tick());
      const events = await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM notifications WHERE payload->>'kind'='missing_evidence' AND resolved_at IS NULL");
      expect(events.rows[0].count).toBe(101);
      expect(f.measurement.failures).toEqual([]);
      expect(s.unexpectedCalls).toEqual([]);
      results.push({ repetition, fixture: f.manifest, measurements });
      await writeFile(join(output, 'notifications-run.json'), JSON.stringify({ node: process.version, electron: process.versions.electron, results }, null, 2));
    } finally { await s.stop(); await f.close(); }
  }
}, 300_000);
