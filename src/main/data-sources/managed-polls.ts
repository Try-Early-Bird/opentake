import type { ManagedPollSetting } from '../../shared/managed-polls';
import { createDataSourceRuntime } from './runtime';
import type { SourceAdapter } from './contracts';

export interface ManagedPoll {
  id: string;
  intervalMs: number;
  run(): Promise<void>;
}
/** Migration bridge: runtime owns scheduling; existing providers own due checks,
 * single-flight requests, cancellation and writes. Completion is not quote freshness. */
export function createManagedPolls(jobs: readonly ManagedPoll[], enabled: () => boolean,
  options: Parameters<typeof createDataSourceRuntime>[1] & { policy?: (id: string) => ManagedPollSetting | undefined } = {}) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  if (byId.size !== jobs.length) throw Error('Duplicate managed poll');
  const lastRun = new Map<string, number>();
  const active = new Set<Promise<void>>();
  let started = false, closed = false;
  const adapter: SourceAdapter = {
    id:'managed-polls',version:'1',transport:'http',kinds:['boolean'],history:false,replay:false,
    async poll(context) {
      if (context.signal.aborted || !enabled()) return;
      const job = byId.get(context.feed.feedId);
      if (!job) { context.fail('invalid_data'); return; }
      const work = Promise.resolve().then(() => {
        if (context.signal.aborted || !enabled()) return;
        const policy = options.policy?.(job.id), now = options.clock?.monotonic() ?? performance.now();
        if (policy?.collection === 'off') return;
        const previous = lastRun.get(job.id);
        if (policy && previous !== undefined && now - previous < policy.intervalMs) return;
        lastRun.set(job.id, now);
        return job.run();
      });
      active.add(work);
      try {
        await work;
        if (!context.signal.aborted) { context.connected(); context.emit({payload:{kind:'boolean',value:true},eventTime:null,origin:'live'}); }
      } finally { active.delete(work); }
    },
  };
  // Legacy provider operations have their own deadlines. Keep their runtime permit
  // until settlement; a suspended/slow operation must never get a second copy.
  const runtime = createDataSourceRuntime([adapter], {random:()=>0.5,...options,limits:{deadlineMs:86_400_000,...options.limits}});
  return {
    start() {
      if (started || closed) return;
      started = true;
      for (const job of jobs) runtime.acquire({ownerId:'host',sourceId:job.id,configVersion:1,adapterId:adapter.id,authScope:'host-managed',feedId:job.id,schemaVersion:1,parameters:{},kind:'boolean',unit:'poll-pass',semantics:'state',ordering:'arrival',freshnessMs:Math.max(15000,job.intervalMs*3),pollIntervalMs:job.intervalMs},{mode:'latest',demand:'durable'});
    },
    suspend() { runtime.suspend(); },
    resume() { if (!closed) runtime.resume(); },
    async close() { closed = true; runtime.close(); await Promise.allSettled([...active]); },
  };
}
