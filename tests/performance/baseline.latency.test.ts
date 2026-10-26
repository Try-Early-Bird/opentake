import { test, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { cpus, platform, release, arch, totalmem } from 'node:os';
import { WORKLOADS, runCase } from './latency-runner';

test.skipIf(process.env.EARLYBIRD_PERF_RUN !== '1')('collect controlled latency samples', async () => {
  const output = process.env.EARLYBIRD_PERF_OUTPUT;
  if (!process.versions.node.startsWith('24.')) throw new Error('Use Node 24 (the app runtime), not the shell default. See the performance README.');
  if (!output || !isAbsolute(output)) throw new Error('Set EARLYBIRD_PERF_OUTPUT to a new absolute results directory');
  const pilot = process.env.EARLYBIRD_PERF_PILOT === '1';
  const manifest = { createdAt: new Date().toISOString(), revision: process.env.EARLYBIRD_PERF_REVISION ?? 'unknown', pilot,
    environment: { node: process.version, electron: process.versions.electron ?? null, v8: process.versions.v8, os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    repetitions: pilot ? 1 : 3, foregroundSamplesPerProbePerRepetition: pilot ? 3 : 100, detailSamplesPerRepetition: pilot ? 2 : 40,
    limitations: ['Synthetic services, not live UI latency', 'No renderer or IPC overhead', 'Takes fanout excludes initial portfolio/holdings reads and UI row mapping', 'USDC conversion fixed at 1', 'No provider network latency', 'Exact queue wait unavailable', 'Ordinary desktop background load uncontrolled'] };
  const results = [];
  for (const workload of pilot ? WORKLOADS.slice(0, 1) : WORKLOADS) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
      console.log(`Starting ${workload.name}, repetition ${repetition}`);
      const result = await runCase({ ...workload, seed: 'baseline-v1' }, repetition, output,
        manifest.foregroundSamplesPerProbePerRepetition, manifest.detailSamplesPerRepetition);
      results.push(result);
      console.log(`Finished ${result.key}: details p50=${result.detailsSummary.p50?.toFixed(1)}ms; idle portfolio p95=${result.idle.byName.portfolio.latency.p95?.toFixed(1) ?? 'n/a'}ms`);
      await writeFile(join(output, 'run.json'), JSON.stringify({ manifest, results }, null, 2));
    }
  }
  expect(results).toHaveLength((pilot ? 1 : WORKLOADS.length) * manifest.repetitions);
}, 1_800_000);
