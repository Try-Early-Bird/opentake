import { overviewDetail } from '../../src/main/strategies/overview';
import { test, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cpus, platform, release, arch } from 'node:os';
import { createFixture } from './fixture';
import { createServices } from './services';
import { stats, WORKLOADS } from './latency-runner';

test.skipIf(process.env.EARLYBIRD_PERF_OVERVIEW !== '1')('measure the optimized overview with individual-read controls', async () => {
  const output = process.env.EARLYBIRD_PERF_OUTPUT;
  if (!process.versions.node.startsWith('24.') || !output || !isAbsolute(output)) throw Error('Use Node 24 and a new absolute output directory');
  const manifest = { createdAt: new Date().toISOString(), revision: process.env.EARLYBIRD_PERF_REVISION,
    node: process.version, electron: process.versions.electron, v8: process.versions.v8,
    platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
    repetitions: 3, optimizedSamples: 40, controlSamples: 5, seed: 'baseline-v1',
    scope: 'Warm list/detail/capital branch; excludes renderer, initial portfolio/holdings and provider latency. Control has too few samples for p95.' };
  const results: { name: string; repetition: number; fixture: Awaited<ReturnType<typeof createFixture>>['manifest']; control: number[]; optimized: number[]; controlQueries: number; optimizedQueries: number }[] = [];
  for (const workload of WORKLOADS.filter(w => w.historyRows === 10_000)) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const f = await createFixture({ ...workload, seed: manifest.seed }), s = createServices(f);
      try {
        expect(await s.takeOverview()).toEqual((await s.takeDetails()).map(r => ({ ...r, detail: overviewDetail(r.detail) })));
        const control: number[] = [], optimized: number[] = [];
        let controlQueries = 0, optimizedQueries = 0;
        for (const [name, read, count, values] of [
          ['control', s.takeDetails, 5, control], ['optimized', () => s.takeOverview(), 40, optimized],
        ] as const) {
          f.measurement.samples.length = 0;
          f.measurement.queries.clear();
          for (let i = 0; i < count; i++) {
            const start = performance.now();
            const rows = await f.measurement.scope(name, read);
            values.push(performance.now() - start);
            expect(rows).toHaveLength(f.allocations.length);
          }
          const queries = f.measurement.samples.filter(s => s.operation.endsWith('query')).length / count;
          if (name === 'control') controlQueries = queries; else optimizedQueries = queries;
          await writeFile(join(output, `${workload.name}-r${repetition}-${name}.json.gz`), gzipSync(JSON.stringify({ samples: f.measurement.samples, queries: Object.fromEntries(f.measurement.queries) })));
        }
        expect(s.unexpectedCalls).toEqual([]);
        expect(f.measurement.failures).toEqual([]);
        results.push({ name: workload.name, repetition, fixture: f.manifest, control, optimized, controlQueries, optimizedQueries });
        const summary = WORKLOADS.filter(w => w.historyRows === 10_000).map(w => {
          const rows = results.filter(r => r.name === w.name);
          return { name: w.name, repetitions: rows.length, control: stats(rows.flatMap(r => r.control)), optimized: stats(rows.flatMap(r => r.optimized)),
            controlQueries: rows[0]?.controlQueries, optimizedQueries: rows[0]?.optimizedQueries };
        });
        await writeFile(join(output, 'overview-run.json'), JSON.stringify({ manifest, results, summary }, null, 2));
      } finally { await s.stop(); await f.close(); }
    }
  }
  expect(results).toHaveLength(9);
}, 600_000);
