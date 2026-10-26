import {randomUUID} from 'node:crypto';
import type { DataIssue, DataObservation, DataSnapshot } from '../../shared/data-sources';
import { feedSchema, sampleSchema, type FeedDefinition, type SourceAdapter, type RuntimeClock, type AdapterContext } from './contracts';

type Consumer = { mode: 'latest' | 'events'; demand: 'ui' | 'durable'; queue: DataObservation[]; bytes: number; gap: boolean; generation:number };
type Session = { controller: AbortController; dispose?: () => void; deadline: number; heartbeatAt: number; connected: boolean };
type Entry = {
  key: string; definition: string; feed: FeedDefinition; adapter: SourceAdapter; consumers: Set<Consumer>;
  epoch: number; session?: Session; connection: DataSnapshot['connection']; issue: DataIssue | null; warning: DataIssue | null;
  latest: DataObservation | null; latestMono: number; latestValid: boolean; lastReceivedAt: number | null;
  due: number; releaseAt: number | null; failures: number; healthyAt: number | null;
  sequence?: bigint; ids: Set<string>; listeners: Set<() => void>;
};
export interface RuntimeLimits {
  feeds: number; consumers: number; http: number; sockets: number;
  eventsPerConsumer: number; eventsTotal: number; eventBytes: number; sampleBytes: number;
  deadlineMs: number; graceMs: number;
}
const defaults: RuntimeLimits = {
  feeds: 32, consumers: 128, http: 4, sockets: 4,
  eventsPerConsumer: 1000, eventsTotal: 10_000, eventBytes: 16 * 1024 * 1024,
  sampleBytes: 16 * 1024, deadlineMs: 10_000, graceMs: 5000,
};
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}
/** Transport-agnostic core; host ownership lives in host-service.ts. No persistence or trading authority. */
export function createDataSourceRuntime(adapters: readonly SourceAdapter[], options: {
  clock?: RuntimeClock; random?: () => number; limits?: Partial<RuntimeLimits>;
  onObservation?: (feed: FeedDefinition, observation: DataObservation) => boolean;
  /** Host-side, non-blocking feed issue (e.g. storage quarantined its observations); reported only while the feed has no runtime issue. */
  issue?: (feed: FeedDefinition) => DataIssue | null;
} = {}) {
  const clock = options.clock ?? { wall: Date.now, monotonic: () => performance.now() };
  const random = options.random ?? Math.random;
  const limits = { ...defaults, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid runtime limit');
  const registry = new Map<string, SourceAdapter>();
  for (const adapter of adapters) {
    if (registry.has(adapter.id) || !adapter.id || !adapter.version || (adapter.transport === 'websocket' && (!Number.isFinite(adapter.heartbeatTimeoutMs) || adapter.heartbeatTimeoutMs <= 0))) throw Error('Invalid adapter');
    registry.set(adapter.id, adapter);
  }
  const runtimeId = randomUUID();
  const entries = new Map<string, Entry>();
  const httpSources = new Set<string>();
  let httpActive = 0, consumerCount = 0, eventCount = 0, eventBytes = 0, epoch = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false, suspended = false;
  let previousWall = clock.wall(), previousMono = clock.monotonic();
  const sourceKey = (entry: Entry) => stable([entry.feed.ownerId, entry.feed.sourceId, entry.feed.authScope]);
  // One adapter connection per source revision and credential scope, shared by all its feeds.
  const connectionKey = (entry: Entry) => stable([entry.feed.adapterId, entry.feed.ownerId, entry.feed.sourceId, entry.feed.configVersion, entry.feed.authScope]);
  const sockets = () => new Set([...entries.values()].filter(e => e.adapter.transport === 'websocket' && e.session).map(connectionKey));
  function notify(entry: Entry) { for (const listener of [...entry.listeners]) try { listener(); } catch { /* Watchers never affect delivery. */ } }
  function clearQueue(consumer: Consumer) {
    consumer.generation++;
    eventCount -= consumer.queue.length; eventBytes -= consumer.bytes;
    consumer.queue = []; consumer.bytes = 0;
  }
  function retire(entry: Entry) {
    const session = entry.session;
    entry.session = undefined; entry.latestValid = false; entry.healthyAt = null;
    if (session) {
      session.controller.abort();
      try { session.dispose?.(); } catch { /* Adapter errors never enter diagnostics. */ }
    }
  }
  function fail(entry: Entry, issue: DataIssue, retry = true, retryAfterMs = 0) {
    retire(entry); entry.issue = issue; entry.failures++;
    for (const consumer of entry.consumers) if (consumer.mode === 'events') { clearQueue(consumer); consumer.gap = true; }
    entry.connection = retry ? 'retrying' : 'blocked';
    const delay = entry.failures >= 5 ? 300_000 : Math.min(60_000, 1000 * 2 ** (entry.failures - 1));
    entry.due = clock.monotonic() + Math.max(delay * (0.9 + Math.min(1, Math.max(0, random())) * 0.2), Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0);
    notify(entry);
  }
  function receive(entry: Entry, session: Session, raw: unknown) {
    if (entry.session !== session || session.controller.signal.aborted || closed || suspended) return;
    entry.lastReceivedAt = clock.wall();
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(raw)); } catch { fail(entry, 'invalid_data'); return; }
    if (bytes > limits.sampleBytes) { fail(entry, 'capacity'); return; }
    const result = sampleSchema.safeParse(raw);
    // Provider data errors are transient: back off and retry. Only adapter configuration errors block.
    if (!result.success || result.data.payload.kind !== entry.feed.kind) { fail(entry, 'invalid_data'); return; }
    const sample = result.data;
    if (sample.payload.kind === 'event') {
      const fields = sample.payload.fields, declared = entry.feed.eventFields!;
      if ((entry.feed.parameters.partialFields!=='metadata'&&Object.keys(fields).length !== Object.keys(declared).length) || Object.entries(fields).some(([key,value])=>!Object.hasOwn(declared,key)||(value===null?'null':typeof value)!==declared[key])) {
        fail(entry, 'invalid_data'); return;
      }
    }
    const now = clock.wall();
    if ((sample.eventTime !== null && sample.eventTime > now + 5000) ||
        (entry.feed.ordering === 'event-time' && sample.eventTime === null) ||
        (entry.feed.ordering === 'sequence' && sample.sequence === undefined)) { fail(entry, 'invalid_data'); return; }
    // Historical samples cannot refresh latest state or enter live event delivery.
    if (sample.origin === 'backfill') return;
    if (sample.providerId && entry.ids.has(sample.providerId)) return;
    if (entry.feed.ordering === 'sequence') {
      const sequence = BigInt(sample.sequence!);
      if (entry.sequence !== undefined && sequence <= entry.sequence) return;
      // Sequence continuity belongs to the adapter; a source may use sparse counters.
      entry.sequence = sequence;
    }
    if (sample.providerId) {
      entry.ids.add(sample.providerId);
      if (entry.ids.size > 1000) entry.ids.delete(entry.ids.values().next().value!);
    }
    const observation: DataObservation = {
      sourceId: entry.feed.sourceId, feedId: entry.feed.feedId, configVersion: entry.feed.configVersion,
      schemaVersion: entry.feed.schemaVersion, adapterId: entry.adapter.id, adapterVersion: entry.adapter.version,
      runtimeId, epoch: entry.epoch, unit: entry.feed.unit, ...(entry.feed.market ? { market: structuredClone(entry.feed.market) } : {}),
      ...sample, receivedAt: now, timeBasis: sample.eventTime === null ? 'receipt' : 'provider',
      clockSkewMs: sample.eventTime === null ? 0 : Math.max(0, sample.eventTime - now),
    };
    // Routed streams interleave markets; the destination orders timestamps per market.
    const late = !['equity','crypto'].includes(entry.feed.parameters.marketRouting) && entry.latest !== null &&
      sample.eventTime !== null && entry.latest.eventTime !== null && sample.eventTime < entry.latest.eventTime;
    if (!late) {
      entry.latest = observation; entry.latestMono = clock.monotonic(); entry.latestValid = true; entry.issue = null; entry.warning = null;
    }
    const eventConsumers = [...entry.consumers].filter(c => c.mode === 'events');
    // Late events are not actionable; report lost continuity rather than silently skipping.
    if (late && eventConsumers.length) { fail(entry, 'gap'); return; }
    const observationBytes = Buffer.byteLength(JSON.stringify(observation));
    if (eventConsumers.some(c => c.queue.length >= limits.eventsPerConsumer) ||
        eventCount + eventConsumers.length > limits.eventsTotal || eventBytes + observationBytes * eventConsumers.length > limits.eventBytes) {
      fail(entry, 'capacity'); return;
    }
    if (!late && options.onObservation) {
      try { if (!options.onObservation(structuredClone(entry.feed), structuredClone(observation))) { fail(entry, 'capacity'); return; } }
      catch { fail(entry, 'capacity'); return; }
    }
    for (const consumer of eventConsumers) {
      consumer.queue.push(observation); consumer.bytes += observationBytes;
      eventCount++; eventBytes += observationBytes;
    }
    notify(entry);
  }
  function start(entry: Entry) {
    if (entry.adapter.transport !== 'http' || entry.connection !== 'live') {
      entry.epoch = ++epoch; entry.sequence = undefined; entry.ids.clear();
    }
    entry.connection = 'connecting'; entry.warning = null;
    const session: Session = { controller: new AbortController(), deadline: clock.monotonic() + limits.deadlineMs, heartbeatAt: clock.monotonic(), connected: false };
    entry.session = session;
    const current = () => entry.session === session && !session.controller.signal.aborted && !closed && !suspended;
    const context: AdapterContext = {
      feed: structuredClone(entry.feed), signal: session.controller.signal, epoch: entry.epoch,
      emit: raw => receive(entry, session, raw),
      connected() { if (current()) { session.connected = true; entry.connection = 'live'; entry.healthyAt ??= clock.monotonic(); notify(entry); } },
      heartbeat() { if (current()) session.heartbeatAt = clock.monotonic(); },
      fail(reason, policy) { if (current()) fail(entry, reason, policy?.configuration !== true, policy?.retryAfterMs); },
      warn(reason) { if (current() && reason === 'invalid_data' && entry.warning !== reason) { entry.warning = reason; notify(entry); } },
    };
    if (entry.adapter.transport === 'websocket') {
      try {
        const dispose = entry.adapter.open(context);
        if (current()) session.dispose = dispose;
        else dispose(); // Handles synchronous callbacks that failed or released during open.
      } catch { if (current()) fail(entry, 'transport'); }
    } else {
      const adapter = entry.adapter, key = sourceKey(entry);
      httpActive++; httpSources.add(key);
      // Reserve capacity before calling user code; cancellation before this microtask prevents I/O.
      void Promise.resolve().then(() => { if (current()) return adapter.poll(context); }).then(() => {
        if (!current()) return;
        entry.session = undefined; session.controller.abort();
        entry.connection = 'live'; entry.failures = 0;
        entry.due = clock.monotonic() + entry.feed.pollIntervalMs * (0.9 + Math.min(1, Math.max(0, random())) * 0.2);
        // Keep healthy sibling feeds of one HTTP source in phase so the adapter can share one response per poll.
        const connection = connectionKey(entry);
        for (const sibling of entries.values()) if (sibling !== entry && !sibling.session && sibling.connection === 'live' && sibling.due > clock.monotonic() && connectionKey(sibling) === connection) sibling.due = entry.due;
        notify(entry);
      }, () => { if (current()) fail(entry, 'transport'); }).finally(() => {
        // A poll ignoring cancellation retains its permit until it settles: never exceed the actual cap.
        httpActive--; httpSources.delete(key);
      });
    }
  }
  function tick() {
    if (closed) return;
    const now = clock.monotonic(), wall = clock.wall();
    if (Math.abs((wall - previousWall) - (now - previousMono)) > 5000) {
      for (const entry of entries.values()) if (entry.connection !== 'blocked') fail(entry, 'clock_changed');
    }
    previousWall = wall; previousMono = now;
    for (const entry of entries.values()) {
      if (!entry.consumers.size && entry.releaseAt !== null && now >= entry.releaseAt) {
        retire(entry); entries.delete(entry.key); continue;
      }
      if (suspended) continue;
      if (entry.session) {
        const session = entry.session;
        if ((!session.connected || entry.adapter.transport === 'http') && now >= session.deadline) fail(entry, 'timeout');
        else if (entry.adapter.transport === 'websocket' && session.connected && now - session.heartbeatAt >= entry.adapter.heartbeatTimeoutMs) fail(entry, 'timeout');
        else if (entry.healthyAt !== null && now - entry.healthyAt >= 30_000) entry.failures = 0;
      }
    }
    if (!suspended) {
      // Earliest due first; independent sources progress while a slow source retains its permit.
      const pending = [...entries.values()].filter(e => e.consumers.size && !e.session && e.connection !== 'blocked' && e.due <= now).sort((a, b) => a.due - b.due);
      for (const entry of pending) {
        if (entry.adapter.transport === 'http') {
          if (httpActive >= limits.http || httpSources.has(sourceKey(entry))) continue;
        } else { const open = sockets(); if (!open.has(connectionKey(entry)) && open.size >= limits.sockets) continue; }
        start(entry);
      }
    }
    if (!entries.size && timer) { clearInterval(timer); timer = undefined; }
  }
  function snapshot(entry: Entry, consumer: Consumer): DataSnapshot {
    const latest = entry.latest;
    const now = clock.wall();
    const stale = !entry.latestValid || (latest !== null && (clock.monotonic() - entry.latestMono >= entry.feed.freshnessMs ||
      (latest.eventTime !== null && (now - latest.eventTime >= entry.feed.freshnessMs || latest.eventTime > now + 5000))));
    const quality = consumer.gap || entry.issue === 'gap' || entry.issue === 'capacity' ? 'gap' :
      entry.issue === 'invalid_data' ? 'invalid' : latest === null ? 'missing' : stale ? 'stale' : 'fresh';
    let issue = entry.issue ?? entry.warning;
    if (issue === null && options.issue) try { issue = options.issue(structuredClone(entry.feed)); } catch { /* Diagnostics never affect reads. */ }
    return structuredClone({ connection: entry.connection, quality, latest, issue, lastReceivedAt: entry.lastReceivedAt });
  }
  return {
    peek(raw:unknown):DataSnapshot|null {
      if(closed||suspended)return null;
      const feed=feedSchema.parse(raw),entry=[...entries.values()].find(item=>item.definition===stable(feed));
      return entry?snapshot(entry,{mode:'latest',demand:'ui',queue:[],bytes:0,gap:false,generation:0}):null;
    },
    acquire(raw: unknown, request: { mode: 'latest' | 'events'; demand: 'ui' | 'durable';initialGap?:boolean }) {
      if (closed) throw Error('Data runtime closed');
      if (!['latest', 'events'].includes(request.mode) || !['ui', 'durable'].includes(request.demand)) throw Error('Invalid consumer');
      const feed = feedSchema.parse(raw), adapter = registry.get(feed.adapterId);
      if (!adapter || !adapter.kinds.includes(feed.kind)) throw Error('Unsupported data adapter');
      if (request.mode === 'events' && feed.semantics !== 'event') throw Error('Feed does not support event delivery');
      const key = stable([feed.ownerId, feed.sourceId, feed.configVersion, feed.authScope, feed.feedId, feed.schemaVersion, feed.parameters]);
      const definition = stable(feed);
      let entry = entries.get(key);
      if (entry && entry.definition !== definition) throw Error('Feed revision conflict');
      if (consumerCount >= limits.consumers || (!entry && entries.size >= limits.feeds)) throw Error('Data runtime capacity reached');
      if (!entry) {
        entry = { key, definition, feed, adapter, consumers: new Set(), epoch: 0, connection: 'idle', issue: null, warning: null,
          latest: null, latestMono: 0, latestValid: false, lastReceivedAt: null, due: clock.monotonic(), releaseAt: null,
          failures: 0, healthyAt: null, ids: new Set(), listeners: new Set() };
        entries.set(key, entry);
      }
      const consumer: Consumer = { ...request, queue: [], bytes: 0, gap: request.initialGap??false,generation:0 };
      entry.consumers.add(consumer); entry.releaseAt = null; consumerCount++;
      let released = false;
      const active = () => { if (released || closed) throw Error('Data consumer released'); };
      timer ??= setInterval(tick, 100);
      tick();
      return {
        read() { active(); return snapshot(entry, consumer); },
        /** Called after observations and connection changes; replaces polling waits. */
        watch(listener: () => void) { active(); entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
        /** Non-destructive, bounded read. Acknowledge only after durable evaluation commits. */
        batch(limit=32) {
          active();if(consumer.mode!=='events'||!Number.isInteger(limit)||limit<1||limit>32)throw Error('Invalid event batch');
          const generation=consumer.generation,gap=consumer.gap;
          const observations=gap?[]:consumer.queue.slice(0,limit);
          const valid=()=>!released&&!closed&&consumer.generation===generation;
          return {gap,observations:structuredClone(observations),snapshot:snapshot(entry,consumer),valid,
            ack(){if(!valid())return false;
              if(gap){clearQueue(consumer);consumer.gap=false;return true;}
              const removed=consumer.queue.splice(0,observations.length),bytes=removed.reduce((total,item)=>total+Buffer.byteLength(JSON.stringify(item)),0);
              consumer.bytes-=bytes;eventBytes-=bytes;eventCount-=removed.length;consumer.generation++;return true;
            }};
        },
        /** Draining acknowledges the gap; consumers must establish a fresh baseline after it. */
        drain() {
          active(); if (consumer.mode !== 'events') throw Error('Not an event consumer');
          const result = structuredClone({ gap: consumer.gap, observations: consumer.queue });
          clearQueue(consumer); consumer.gap = false; return result;
        },
        release() {
          if (released || closed) return;
          released = true; clearQueue(consumer); entry.consumers.delete(consumer); consumerCount--;
          if (!entry.consumers.size) entry.releaseAt = clock.monotonic() + limits.graceMs;
        },
      };
    },
    /** Retire unreferenced feeds immediately once their definition leaves the host catalog. */
    prune(keep: (feed: FeedDefinition) => boolean) {
      for (const entry of [...entries.values()]) if (!entry.consumers.size && !keep(structuredClone(entry.feed))) { retire(entry); entries.delete(entry.key); }
    },
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      for (const entry of entries.values()) if (entry.connection !== 'blocked') { fail(entry, 'suspended'); entry.connection = 'idle'; }
    },
    resume() {
      if (closed || !suspended) return;
      suspended = false; previousWall = clock.wall(); previousMono = clock.monotonic();
      for (const entry of entries.values()) { entry.due = clock.monotonic(); }
      tick();
    },
    stats() { return { feeds: entries.size, consumers: consumerCount, httpActive, sockets: sockets().size, queuedEvents: eventCount, queuedBytes: eventBytes }; },
    close() {
      if (closed) return;
      closed = true; if (timer) clearInterval(timer); timer = undefined;
      for (const entry of entries.values()) { retire(entry); for (const consumer of entry.consumers) clearQueue(consumer); }
      entries.clear(); consumerCount = 0;
    },
  };
}
