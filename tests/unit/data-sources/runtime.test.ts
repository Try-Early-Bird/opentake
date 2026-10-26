import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDataSourceRuntime } from '../../../src/main/data-sources/runtime';
import type { AdapterContext } from '../../../src/main/data-sources/contracts';
import { deferred, definition, fakeHttp, fakeWebSocket, sample } from './fixtures';

const ui = { mode: 'latest', demand: 'ui' } as const;
const events = { mode: 'events', demand: 'durable' } as const;
const runtimes: ReturnType<typeof createDataSourceRuntime>[] = [];
function runtime(...args: Parameters<typeof createDataSourceRuntime>) {
  const instance = createDataSourceRuntime(args[0], { random: () => 0.5, ...args[1] });
  runtimes.push(instance); return instance;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T12:00:00Z')); });
afterEach(() => { for (const instance of runtimes.splice(0)) instance.close(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

test('provider Retry-After is a lower bound even when jitter would retry earlier', async () => {
  let calls = 0;
  const source = runtime([fakeHttp(async context => { calls++; context.fail('transport', { retryAfterMs: 120_000 }); })], { random: () => 0 });
  source.acquire(definition(), ui); await flush(); expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(119_900); expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(2);
});

test('observation persistence rejects overload and never receives backfill or late state', async () => {
  const ws = fakeWebSocket(), sink = vi.fn(() => true);
  const source = runtime([ws.adapter], { onObservation: sink });
  const handle = source.acquire(definition({ adapterId: 'ws' }), ui);
  ws.sessions[0].emit(sample('1', Date.now()));
  ws.sessions[0].emit(sample('2', Date.now() - 1000));
  ws.sessions[0].emit(sample('3', Date.now(), { origin: 'backfill' }));
  expect(sink).toHaveBeenCalledTimes(1);
  sink.mockReturnValue(false); ws.sessions[0].emit(sample('4'));
  expect(handle.read()).toMatchObject({ connection: 'retrying', issue: 'capacity' });
});

describe('shared acquisitions and independent progress', () => {
  test('two UI consumers and durable demand share HTTP acquisition, with immutable read copies', async () => {
    let calls = 0;
    const source = runtime([fakeHttp(async ctx => { calls++; ctx.emit(sample('0.5')); })]);
    const a = source.acquire(definition(), ui), b = source.acquire(definition(), ui);
    const take = source.acquire(definition(), { ...ui, demand: 'durable' });
    await flush(); expect(calls).toBe(1);
    expect(a.read()).toMatchObject({ connection: 'live', quality: 'fresh', latest: { unit: 'score', adapterId: 'http', payload: { value: '0.5' } } });
    const copy = a.read(); copy.latest!.unit = 'changed';
    expect(b.read().latest!.unit).toBe('score');
    a.release(); b.release();
    await vi.advanceTimersByTimeAsync(60_000); expect(calls).toBe(2);
    expect(take.read().quality).toBe('fresh'); take.release(); take.release();
    await vi.advanceTimersByTimeAsync(5000); expect(source.stats().feeds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('HTTP and WS expose the same consumer contract', async () => {
    const ws = fakeWebSocket();
    const source = runtime([ws.adapter, fakeHttp(async ctx => { ctx.emit(sample('7')); })]);
    const a = source.acquire(definition(), ui);
    const b = source.acquire(definition({ sourceId: 'stream', adapterId: 'ws' }), ui);
    ws.sessions[0].emit(sample('7')); await flush();
    expect(a.read().latest?.payload).toEqual(b.read().latest?.payload);
    expect(a.read().quality).toBe('fresh'); expect(b.read().quality).toBe('fresh');
  });
  test('canonical parameters share; owner, revision, credential scope and parameters isolate', async () => {
    let calls = 0;
    const source = runtime([fakeHttp(async () => { calls++; })], { limits: { http: 10 } });
    source.acquire(definition({ parameters: { a: '1', b: '2' } }), ui);
    source.acquire(definition({ parameters: { b: '2', a: '1' } }), ui);
    source.acquire(definition({ ownerId: 'other' }), ui);
    source.acquire(definition({ authScope: 'private' }), ui);
    source.acquire(definition({ configVersion: 2 }), ui);
    source.acquire(definition({ parameters: { a: 'different' } }), ui);
    await flush(); await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(5); expect(source.stats().feeds).toBe(5);
    expect(() => source.acquire(definition({ parameters: { a: '1', b: '2' }, unit: 'USD' }), ui)).toThrow('revision conflict');
  });
  test('a hung HTTP source cannot block another and retains its permit after timeout', async () => {
    const pending = deferred(); const seen: string[] = []; let held: AdapterContext | undefined;
    const source = runtime([fakeHttp(async ctx => {
      seen.push(ctx.feed.sourceId);
      if (ctx.feed.sourceId === 'hung') { held = ctx; await pending.promise; }
      ctx.emit(sample());
    })], { limits: { http: 2 } });
    const a = source.acquire(definition({ sourceId: 'hung' }), ui);
    const b = source.acquire(definition({ sourceId: 'good' }), ui);
    source.acquire(definition({ sourceId: 'hung', feedId: 'second' }), ui);
    await flush(); expect(b.read().quality).toBe('fresh');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(a.read().issue).toBe('timeout'); expect(held!.signal.aborted).toBe(true);
    expect(seen.filter(s => s === 'hung')).toHaveLength(1);
    expect(source.stats().httpActive).toBe(1);
    pending.resolve(); await flush();
    expect(a.read().latest).toBeNull(); // Timed-out completion is fenced out.
  });
  test('reads do not cause provider requests and releases before startup cancel queued polls', async () => {
    let calls = 0;
    const source = runtime([fakeHttp(async () => { calls++; })]);
    const lease = source.acquire(definition(), ui);
    source.close(); await flush(); expect(calls).toBe(0);
    expect(() => lease.read()).toThrow('released');
    expect(() => source.acquire(definition(), ui)).toThrow('closed');
  });
});

describe('quality and protocol boundaries', () => {
  test('heartbeat does not refresh data; absent event time is explicit receipt time', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws', ordering: 'arrival' }), ui);
    expect(lease.read()).toMatchObject({ connection: 'live', quality: 'missing' });
    ws.sessions[0].emit(sample('1', null));
    expect(lease.read().latest).toMatchObject({ eventTime: null, timeBasis: 'receipt' });
    await vi.advanceTimersByTimeAsync(30_000); ws.sessions[0].heartbeat();
    expect(lease.read()).toMatchObject({ connection: 'live', quality: 'stale' });
  });
  test('duplicates, older samples and backfill cannot regress or freshen state', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    const at = Date.now(); ws.sessions[0].emit(sample('2', at, { providerId: 'one' }));
    await vi.advanceTimersByTimeAsync(30_000);
    ws.sessions[0].emit(sample('9', Date.now(), { providerId: 'one' }));
    ws.sessions[0].emit(sample('1', at - 1000));
    ws.sessions[0].emit(sample('8', Date.now(), { origin: 'backfill' }));
    expect(lease.read()).toMatchObject({ quality: 'stale', latest: { payload: { value: '2' }, receivedAt: at } });
  });
  test('polls preserve deduplication across successful reads', async () => {
    const source = runtime([fakeHttp(async ctx => ctx.emit(sample('2', null, { providerId: 'same' })))]);
    const lease = source.acquire(definition({ ordering: 'arrival', pollIntervalMs: 15_000 }), ui);
    await flush(); const epoch = lease.read().latest!.epoch;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lease.read().quality).toBe('stale'); expect(lease.read().latest!.epoch).toBe(epoch);
  });
  test.each([
    sample('NaN'), sample('1', Date.now() + 86_400_000),
    { ...sample(), eventTime: undefined },
    { ...sample(), payload: { kind: 'boolean', value: 'false' } },
  ])('invalid samples are transient: back off, retry and expose no raw error', async raw => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    ws.sessions[0].emit(raw);
    expect(lease.read()).toMatchObject({ connection: 'retrying', quality: 'invalid', issue: 'invalid_data', latest: null });
    expect(ws.disposals()).toBe(1);
    await vi.advanceTimersByTimeAsync(1100); expect(ws.sessions).toHaveLength(2);
  });
  test('provider clock ahead retries with backoff; only configuration failures block', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    ws.sessions[0].emit(sample('1', Date.now() + 6000));
    expect(lease.read()).toMatchObject({ connection: 'retrying', issue: 'invalid_data' });
    await vi.advanceTimersByTimeAsync(1100); expect(ws.sessions).toHaveLength(2);
    ws.sessions[1].emit(sample('2')); expect(lease.read()).toMatchObject({ connection: 'live', quality: 'fresh', issue: null });
    ws.sessions[1].fail('invalid_data'); expect(lease.read().connection).toBe('retrying');
    await vi.advanceTimersByTimeAsync(2200); expect(ws.sessions).toHaveLength(3);
    ws.sessions[2].fail('invalid_data', { configuration: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(lease.read()).toMatchObject({ connection: 'blocked', issue: 'invalid_data' }); expect(ws.sessions).toHaveLength(3);
  });
  test('large/cyclic samples are rejected without leaking adapter payloads', () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter], { limits: { sampleBytes: 200 } });
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    ws.sessions[0].emit({ ...sample(), private: 'secret'.repeat(100) });
    expect(lease.read().issue).toBe('capacity'); expect(JSON.stringify(lease.read())).not.toContain('secret');
  });
  test('normalized sequence ordering rejects duplicates and old samples, reset belongs to a new epoch', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws', ordering: 'sequence' }), ui);
    ws.sessions[0].emit(sample('2', Date.now(), { sequence: '9007199254740993000' }));
    ws.sessions[0].emit(sample('1', Date.now(), { sequence: '9007199254740992999' }));
    expect(lease.read().latest?.payload).toEqual({ kind: 'metric', value: '2' });
    ws.sessions[0].fail('gap'); await vi.advanceTimersByTimeAsync(1000);
    ws.sessions[1].emit(sample('3', Date.now(), { sequence: '0' }));
    expect(lease.read()).toMatchObject({ quality: 'fresh', latest: { payload: { value: '3' }, epoch: 2 } });
  });
});

describe('lifecycle and bounded event delivery', () => {
  test('grace period reuses a stream, then disposes it; old generation cannot publish', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const feed = definition({ adapterId: 'ws' }); const a = source.acquire(feed, ui);
    a.release(); await vi.advanceTimersByTimeAsync(4000);
    const b = source.acquire(feed, ui); expect(ws.sessions).toHaveLength(1);
    b.release(); await vi.advanceTimersByTimeAsync(5000); expect(ws.disposals()).toBe(1);
    const c = source.acquire(feed, ui); ws.sessions[0].emit(sample('old'));
    expect(c.read().latest).toBeNull(); ws.sessions[1].emit(sample('3'));
    expect(c.read().quality).toBe('fresh');
  });
  test('suspend aborts, resume coalesces polls and restores only fresh evidence', async () => {
    let calls = 0;
    const source = runtime([fakeHttp(async ctx => { calls++; ctx.emit(sample()); })]);
    const lease = source.acquire(definition(), ui); await flush();
    source.suspend(); expect(lease.read().quality).toBe('stale');
    await vi.advanceTimersByTimeAsync(600_000); expect(calls).toBe(1);
    source.resume(); await flush(); expect(calls).toBe(2); expect(lease.read().quality).toBe('fresh');
  });
  test('clock jumps invalidate continuity before revalidation', async () => {
    let wall = Date.now(); const ws = fakeWebSocket();
    const source = runtime([ws.adapter], { clock: { wall: () => wall, monotonic: () => performance.now() } });
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    ws.sessions[0].emit(sample('1', wall)); wall -= 60_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(lease.read()).toMatchObject({ quality: 'stale', issue: 'clock_changed' });
  });
  test('event queues preserve intermediates, latest reads coalesce, overflow explicitly gaps all consumers', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter], { limits: { eventsPerConsumer: 2 } });
    const feed = definition({ adapterId: 'ws', semantics: 'event' });
    const latest = source.acquire(feed, ui), take = source.acquire(feed, events);
    ws.sessions[0].emit(sample('1')); ws.sessions[0].emit(sample('2'));
    expect(latest.read().latest?.payload).toEqual({ kind: 'metric', value: '2' });
    expect(take.drain().observations.map(o => o.payload)).toEqual([{ kind: 'metric', value: '1' }, { kind: 'metric', value: '2' }]);
    for (let i = 0; i < 3; i++) ws.sessions[0].emit(sample(String(i)));
    expect(take.read().quality).toBe('gap'); expect(source.stats().queuedEvents).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); ws.sessions[1].emit(sample('9'));
    const result = take.drain(); expect(result.gap).toBe(true); expect(result.observations).toHaveLength(1);
    expect(take.read().quality).toBe('fresh');
  });
  test('global bytes/count budgets, feed/consumer capacity and event capability are enforced', () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter], { limits: { feeds: 1, consumers: 2, eventBytes: 20 } });
    const feed = definition({ adapterId: 'ws', semantics: 'event' });
    const a = source.acquire(feed, events); source.acquire(feed, events);
    expect(() => source.acquire(feed, ui)).toThrow('capacity');
    expect(() => source.acquire({ ...feed, sourceId: 'other' }, ui)).toThrow('capacity');
    ws.sessions[0].emit(sample()); expect(a.read().issue).toBe('capacity'); expect(source.stats().queuedBytes).toBe(0);
    a.release();
    expect(() => source.acquire(definition({ adapterId: 'ws', sourceId: 'state' }), events)).toThrow('event delivery');
  });
  test('heartbeat loss retries, repeated failures back off, shutdown cancels all timers', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    await vi.advanceTimersByTimeAsync(60_000); expect(lease.read().issue).toBe('timeout');
    await vi.advanceTimersByTimeAsync(1000); expect(ws.sessions).toHaveLength(2);
    ws.sessions[1].fail('transport'); await vi.advanceTimersByTimeAsync(1999); expect(ws.sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(ws.sessions).toHaveLength(3);
    source.close(); source.close(); expect(ws.disposals()).toBe(3); expect(vi.getTimerCount()).toBe(0);
  });
});


describe('schema and recovery regressions', () => {
  test('typed event fields reject drift and configuration blocks survive suspend/resume', () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const feed = definition({ adapterId: 'ws', kind: 'event', semantics: 'event', eventFields: { score: 'number', flag: 'boolean' } });
    const lease = source.acquire(feed, events);
    ws.sessions[0].emit({ payload: { kind: 'event', fields: { score: 2, flag: true } }, eventTime: Date.now(), origin: 'live' });
    expect(lease.drain().observations).toHaveLength(1);
    ws.sessions[0].emit({ payload: { kind: 'event', fields: { score: '2', flag: true } }, eventTime: Date.now(), origin: 'live' });
    expect(lease.read()).toMatchObject({ connection: 'retrying', issue: 'invalid_data' }); expect(lease.drain()).toMatchObject({ gap: true, observations: [] });
    source.suspend(); source.resume(); expect(ws.sessions).toHaveLength(2);
    ws.sessions[1].fail('invalid_data', { configuration: true });
    source.suspend(); source.resume();
    expect(lease.read().connection).toBe('blocked'); expect(ws.sessions).toHaveLength(2);
  });
  test('future timestamps report accepted skew, and larger skew is invalid', () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    ws.sessions[0].emit(sample('1', Date.now() + 1000));
    expect(lease.read().latest?.clockSkewMs).toBe(1000);
    ws.sessions[0].emit(sample('1', Date.now() + 5001));
    expect(lease.read().quality).toBe('invalid');
  });
  test('latest state never regresses across reconnects', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui); const now = Date.now();
    ws.sessions[0].emit(sample('2', now)); ws.sessions[0].fail('transport');
    await vi.advanceTimersByTimeAsync(1000); ws.sessions[1].emit(sample('1', now - 1000));
    expect(lease.read()).toMatchObject({ quality: 'stale', latest: { payload: { value: '2' } } });
    ws.sessions[1].emit(sample('3', Date.now())); expect(lease.read().quality).toBe('fresh');
  });
  test('socket capacity is bounded and waiting feeds progress after release', async () => {
    const ws = fakeWebSocket(); const source = runtime([ws.adapter], { limits: { sockets: 1 } });
    const first = source.acquire(definition({ adapterId: 'ws' }), ui);
    const second = source.acquire(definition({ adapterId: 'ws', sourceId: 'second' }), ui);
    expect(ws.sessions).toHaveLength(1); expect(second.read().connection).toBe('idle');
    first.release(); await vi.advanceTimersByTimeAsync(5000);
    expect(ws.sessions).toHaveLength(2); expect(second.read().connection).toBe('live');
  });
  test('synchronous adapter failure cleans up and a cyclic payload cannot escape validation', () => {
    let disposed = 0;
    const ws = fakeWebSocket();
    const source = runtime([{ ...ws.adapter, transport: 'websocket', heartbeatTimeoutMs: 60_000, open(ctx) {
      const payload: Record<string, unknown> = {}; payload.self = payload;
      ctx.emit(payload); return () => { disposed++; };
    } }]);
    const lease = source.acquire(definition({ adapterId: 'ws' }), ui);
    expect(disposed).toBe(1); expect(lease.read().quality).toBe('invalid');
  });
});

test('runtime instance identity distinguishes observations even when epoch numbers repeat',()=>{
 const a=fakeWebSocket(),b=fakeWebSocket();
 const first=runtime([a.adapter]).acquire(definition({adapterId:'ws'}),ui);
 const second=runtime([b.adapter]).acquire(definition({adapterId:'ws'}),ui);
 a.sessions[0].emit(sample('1'));b.sessions[0].emit(sample('1'));
 expect(first.read().latest?.epoch).toBe(second.read().latest?.epoch);
 expect(first.read().latest?.runtimeId).toMatch(/^[0-9a-f-]{36}$/);
 expect(first.read().latest?.runtimeId).not.toBe(second.read().latest?.runtimeId);
});

test('the socket cap counts source connections, not feeds sharing one socket', () => {
  const ws = fakeWebSocket(); const source = runtime([ws.adapter], { limits: { sockets: 1 } });
  for (let i = 0; i < 10; i++) source.acquire(definition({ adapterId: 'ws', feedId: `feed-${i}` }), ui);
  expect(ws.sessions).toHaveLength(10); expect(source.stats().sockets).toBe(1);
  source.acquire(definition({ adapterId: 'ws', sourceId: 'other' }), ui);
  expect(ws.sessions).toHaveLength(10);
});
test('sibling HTTP feeds stay in phase so each poll cycle reaches the adapter back to back', async () => {
  const seen: Array<[string, number]> = [];
  const source = runtime([fakeHttp(async ctx => { seen.push([ctx.feed.feedId, Date.now()]); ctx.emit(sample()); })], { random: () => Math.random() });
  for (const id of ['a', 'b', 'c']) source.acquire(definition({ feedId: id }), ui);
  await vi.advanceTimersByTimeAsync(1000); seen.length = 0;
  await vi.advanceTimersByTimeAsync(10 * 66_000);
  expect(seen.length).toBeGreaterThanOrEqual(27); expect(seen.length % 3).toBe(0);
  // Every poll of every feed lands within the same short window as its siblings.
  for (let i = 0; i < seen.length; i += 3) expect(seen[i + 2][1] - seen[i][1]).toBeLessThan(1000);
});
test('handle watchers fire on observations and failures and can unsubscribe', () => {
  const ws = fakeWebSocket(); const source = runtime([ws.adapter]);
  const lease = source.acquire(definition({ adapterId: 'ws' }), ui), listener = vi.fn();
  const stop = lease.watch(listener); ws.sessions[0].emit(sample()); expect(listener).toHaveBeenCalledTimes(1);
  ws.sessions[0].fail('transport'); expect(listener).toHaveBeenCalledTimes(2);
  stop(); ws.sessions[0].emit(sample()); expect(listener).toHaveBeenCalledTimes(2);
});
