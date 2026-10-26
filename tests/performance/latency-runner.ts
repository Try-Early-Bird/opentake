import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { backgroundDatabaseWork } from '../../src/main/database-client';
import { createFixture, fixtureId, type FixtureSize } from './fixture';
import { createServices } from './services';
import type { Sample } from './measurement';

export function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { count: sorted.length, p50: percentile(.5), p95: sorted.length >= 100 ? percentile(.95) : null,
    max: sorted.at(-1) ?? null, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null };
}
export const WORKLOADS = [
  { name: '10-takes-10k-history', accountsPerVenue: 1, allocationsPerAccount: 5, historyRows: 10_000 },
  { name: '100-takes-1k-history', accountsPerVenue: 5, allocationsPerAccount: 10, historyRows: 1_000 },
  { name: '100-takes-10k-history', accountsPerVenue: 5, allocationsPerAccount: 10, historyRows: 10_000 },
  { name: '100-takes-100k-history', accountsPerVenue: 5, allocationsPerAccount: 10, historyRows: 100_000 },
  { name: '500-takes-10k-history', accountsPerVenue: 25, allocationsPerAccount: 10, historyRows: 10_000 },
] as const;

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Services = ReturnType<typeof createServices>;
interface Probe { name: string; start: number; end: number; outcome: 'ok' | 'error' }

/** One in-flight bundle (four reads); missed cadence slots are counted, not queued. */
export async function readWindow(f: Fixture, s: Services, phase: string, target: number, background?: (collecting: () => boolean) => Promise<void>) {
  const probes: Probe[] = [];
  const first = f.allocations[0], account = f.accounts.find(a => a.venue === 'coinbase')!;
  const reads = [
    ['take-history-list', () => s.history.takes(false)],
    ['messages', () => s.history.messages(first.takeId, first.headId)],
    ['portfolio', () => s.portfolio.snapshot(account.id)],
    ['inbox', () => s.notifications.list()],
  ] as const;
  const started = performance.now();
  let next = started, pending: Promise<void> | undefined, completed = 0, missed = 0;
  let backgroundStart: number | null = null, backgroundEnd: number | null = null;
  let backgroundError: unknown;
  let collecting = true;
  const job = background ? (async () => {
    backgroundStart = performance.now();
    try { await backgroundDatabaseWork(() => background(() => collecting)); }
    catch (error) { backgroundError = error; }
    finally { backgroundEnd = performance.now(); }
  })() : Promise.resolve();
  try {
    while (completed < target && performance.now() - started < 120_000) {
      await delay(Math.max(0, next - performance.now()));
      if (completed >= target) break;
      const lateSlots = Math.max(0, Math.floor((performance.now() - next) / 25));
      missed += lateSlots;
      next += (lateSlots + 1) * 25;
      if (pending) { missed++; continue; }
      pending = Promise.all(reads.map(async ([name, read]) => {
        const start = performance.now();
        let outcome: Probe['outcome'] = 'error';
        try { await f.measurement.scope<unknown>(`${phase}.${name}`, read); outcome = 'ok'; }
        finally { probes.push({ name, start, end: performance.now(), outcome }); }
      })).then(() => { completed++; }).finally(() => { pending = undefined; });
      // Keep rejection observed while the fixed-cadence loop runs.
      void pending.catch(() => {});
    }
  } finally { collecting = false; await pending; await job; }
  if (backgroundError) throw backgroundError;
  const byName = Object.fromEntries(reads.map(([name]) => {
    const all = probes.filter(p => p.name === name);
    const overlap = all.filter(p => backgroundStart !== null && backgroundEnd !== null && p.start < backgroundEnd && p.end > backgroundStart);
    return [name, { latency: stats(all.map(p => p.end - p.start)), overlapping: stats(overlap.map(p => p.end - p.start)), errors: all.filter(p => p.outcome === 'error').length }];
  }));
  return { phase, cadenceMs: 25, maxConcurrentBundles: 1, target, completed, missed, elapsedMs: performance.now() - started,
    backgroundDurationMs: backgroundStart !== null && backgroundEnd !== null ? backgroundEnd - backgroundStart : null, probes, byName };
}

function querySummary(samples: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const s of samples.filter(s => s.operation.endsWith('query'))) {
    const group = groups.get(s.label) ?? []; group.push(s); groups.set(s.label, group);
  }
  return [...groups].map(([label, values]) => ({ label, ...stats(values.map(v => v.elapsedMs)), errors: values.filter(v => v.outcome === 'error').length }))
    .sort((a, b) => (b.mean ?? 0) * b.count - (a.mean ?? 0) * a.count);
}

export async function runCase(size: FixtureSize & { name: string }, repetition: number, output: string, samples = 100, detailSamples = 40) {
  const setupStart = performance.now();
  const f = await createFixture(size);
  const s = createServices(f);
  const setupMs = performance.now() - setupStart;
  const key = `${size.name}-r${repetition}`;
  await mkdir(output, { recursive: true });
  const tables = ['takes', 'take_messages', 'strategy_allocations', 'coinbase_allocations', 'strategy_reconciliation_cases', 'coinbase_portfolio_observations', 'strategy_attribution_entries', 'coinbase_allocation_entries', 'notifications'];
  const counts: Record<string, number> = {};
  const artifacts: string[] = [];
  async function flush(label: string) {
    const name = `${key}-${label}.json.gz`;
    await writeFile(join(output, name), gzipSync(JSON.stringify({ samples: f.measurement.samples, queries: Object.fromEntries(f.measurement.queries) })));
    artifacts.push(name);
    f.measurement.samples.length = 0;
    f.measurement.queries.clear();
  }
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  try {
    for (const table of tables) counts[table] = Number((await f.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count);
    if (counts.takes !== size.accountsPerVenue * size.allocationsPerAccount * 2 || counts.take_messages === 0) throw new Error('Invalid fixture counts');
    const first = f.allocations[0];
    if (!(await s.history.messages(first.takeId, first.headId)).messages.length) throw new Error('Empty foreground message fixture');
    // Warm service paths once; cold setup and first visit are not mixed into p95.
    await Promise.all([s.history.takes(false), s.history.messages(first.takeId, first.headId), s.notifications.list(), s.portfolio.snapshot(f.accounts.find(a => a.venue === 'coinbase')!.id)]);
    const warmDetails = await s.takeDetails();
    if (warmDetails.length !== counts.takes || warmDetails.some(d => !d.detail?.title) || warmDetails.filter(d => d.funding?.valuation?.value === '100').length !== counts.coinbase_allocations) throw new Error('Take-detail fixture was not fully read');
    eventLoop.enable();
    const memoryBefore = process.memoryUsage();
    const idle = await readWindow(f, s, 'idle', samples);
    const idleQueries = querySummary(f.measurement.samples);
    await flush('idle');
    const details: number[] = [];
    for (let i = 0; i < detailSamples; i++) {
      const start = performance.now();
      await f.measurement.scope('takes-detail-fanout', () => s.takeDetails());
      details.push(performance.now() - start);
    }
    const detailsQueries = querySummary(f.measurement.samples);
    const detailsQueryCount = f.measurement.samples.filter(q => q.operation.endsWith('query')).length;
    await flush('details');
    const notificationPasses: { kind: string; elapsedMs: number }[] = [];
    async function notificationPass(kind: string) {
      const start = performance.now();
      await f.measurement.scope(`notifications.${kind}`, () => backgroundDatabaseWork(() => s.notifications.tick()));
      notificationPasses.push({ kind, elapsedMs: performance.now() - start });
    }
    await notificationPass('first');
    f.advance(61_000);
    await notificationPass('unchanged');
    await flush('notification-passes');
    // Seed a fixed 100-event increment outside timed work, with distinct identities.
    const affected = f.allocations.filter(a => a.venue === 'robinhood');
    for (let i = 0; i < 100; i++) {
      const a = affected[i % affected.length];
      await f.db.query(`INSERT INTO strategy_reconciliation_cases(id,account_id,scope,cause,impacts,evidence,created_at,updated_at)
        VALUES($1,$2,$3,'unmatched_fill',$4,'{}',$5,$5)`, [fixtureId(size.seed, `increment:${i}`), a.accountId, `increment:${i}`, JSON.stringify([{ allocationId: a.id }]), new Date(f.clock()).toISOString()]);
    }
    f.advance(61_000);
    const schedulerPasses: { venue: string; elapsedMs: number; calls: number }[] = [];
    const concurrent = await readWindow(f, s, 'background-window', samples, async () => {
      await notificationPass('incremental-100');
      for (const [venue, scheduler] of [['robinhood', s.robinhood], ['coinbase', s.coinbase]] as const) {
        const start = performance.now(), before = s.calls.length;
        await f.measurement.scope(`scheduler.${venue}`, () => scheduler.tick());
        schedulerPasses.push({ venue, elapsedMs: performance.now() - start, calls: s.calls.length - before });
      }
    });
    const concurrentQueries = querySummary(f.measurement.samples);
    await flush('background-window');
    eventLoop.disable();
    if (s.unexpectedCalls.length || f.measurement.failures.length || idle.completed !== samples || concurrent.completed !== samples || [...idle.probes, ...concurrent.probes].some(p => p.outcome !== 'ok')) throw new Error('Incomplete or failed baseline run');
    const expectedRobinhood = Math.min(50, counts.strategy_allocations);
    if (schedulerPasses[0].calls !== expectedRobinhood || schedulerPasses[1].calls !== counts.coinbase_allocations) throw new Error('Scheduler eligibility mismatch');
    const result = { key, fixture: f.manifest, counts, setupMs, idle, concurrent, details, detailsSummary: stats(details), detailsQueryCount, notificationPasses, schedulerPasses,
      querySummaries: { idle: idleQueries, details: detailsQueries, concurrent: concurrentQueries },
      memory: { before: memoryBefore, after: process.memoryUsage(), note: 'Whole Vitest process RSS includes worker; JS heap excludes worker. Raw sample buffers add overhead.' },
      eventLoop: { p50Ms: eventLoop.percentile(50) / 1e6, p95Ms: eventLoop.percentile(95) / 1e6, maxMs: eventLoop.max / 1e6, note: 'Includes raw serialization/export between phases, not renderer frame timing.' }, artifacts };
    await writeFile(join(output, `${key}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally { eventLoop.disable(); await s.stop(); await f.close(); }
}
