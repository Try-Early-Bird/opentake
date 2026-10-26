import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createFixture } from './fixture';
import { createServices } from './services';
import { readWindow } from './latency-runner';
import { syncCoinbaseLifecycleNotifications } from '../../src/main/coinbase/lifecycle-notifications';
import { syncActionNotifications } from '../../src/main/action-notifications';

test.skipIf(process.env.EARLYBIRD_PERF_CONTENTION !== '1')('measure same-state foreground reads under sustained reconciliation', async () => {
  const output = process.env.EARLYBIRD_PERF_OUTPUT;
  if (!output || !isAbsolute(output) || !process.versions.node.startsWith('24.')) throw Error('Use Node 24 and an absolute output directory');
  const results = [];
  for (const size of [
    { name: '500-takes-10k-history', accountsPerVenue: 25, allocationsPerAccount: 10, historyRows: 10_000 },
    { name: '100-takes-100k-history', accountsPerVenue: 5, allocationsPerAccount: 10, historyRows: 100_000 },
  ]) for (let repetition = 1; repetition <= 3; repetition++) {
    const f = await createFixture({ ...size, seed: 'baseline-v1' });
    const s = createServices(f), key = `${size.name}-r${repetition}`;
    try {
      const reconcile = async () => {
        await syncCoinbaseLifecycleNotifications(f.db, f.clock());
        await syncActionNotifications(f.db, f.clock());
      };
      await reconcile(); // Same populated notification state for idle and busy phases.
      await readWindow(f, s, 'warm', 2);
      const phases = [];
      const passes: number[] = [];
      for (const phase of ['idle-before', 'busy', 'idle-after']) {
        f.measurement.samples.length = 0; f.measurement.queries.clear();
        const result = await readWindow(f, s, phase, 120, phase === 'busy' ? async collecting => {
          do {
            const start = performance.now();
            await f.measurement.scope('reconciliation', reconcile);
            passes.push(performance.now() - start);
          } while (collecting());
        } : undefined);
        expect(result.completed).toBe(120);
        expect(result.probes.every(p => p.outcome === 'ok')).toBe(true);
        phases.push(result);
        await writeFile(join(output, `${key}-${phase}.json.gz`), gzipSync(JSON.stringify({ samples: f.measurement.samples, queries: Object.fromEntries(f.measurement.queries) })));
      }
      expect(f.measurement.failures).toEqual([]);
      expect(s.unexpectedCalls).toEqual([]);
      results.push({ key, fixture: f.manifest, phases, passes });
      await writeFile(join(output, 'contention-run.json'), JSON.stringify({ node: process.version, electron: process.versions.electron, cadenceMs: 25, samplesPerProbePerPhase: 120, background: 'continuous lifecycle + actions, fixed business clock; stress, not production cadence', results }, null, 2));
      console.log(`Completed ${key}`);
    } finally { await s.stop(); await f.close(); }
  }
}, 600_000);
