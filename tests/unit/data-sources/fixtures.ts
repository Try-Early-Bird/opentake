import type { AdapterContext, FeedDefinition, SourceAdapter } from '../../../src/main/data-sources/contracts';

export const definition = (overrides: Partial<FeedDefinition> = {}): FeedDefinition => ({
  ownerId: 'owner', sourceId: 'source', configVersion: 1, adapterId: 'http', authScope: 'public',
  feedId: 'sentiment', schemaVersion: 1, parameters: {}, kind: 'metric', unit: 'score',
  semantics: 'state', ordering: 'event-time', freshnessMs: 30_000, pollIntervalMs: 60_000, ...overrides,
});
export const sample = (value = '1', eventTime: number | null = Date.now(), extra = {}) => ({
  payload: { kind: 'metric', value }, eventTime, origin: 'live', ...extra,
});
export function fakeHttp(poll: (context: AdapterContext) => Promise<void>): SourceAdapter {
  return { id: 'http', version: 'test-1', transport: 'http', kinds: ['metric', 'boolean', 'event'], history: false, replay: false, poll };
}
export function fakeWebSocket() {
  const sessions: AdapterContext[] = [];
  let disposals = 0;
  const adapter: SourceAdapter = {
    id: 'ws', version: 'test-1', transport: 'websocket', kinds: ['metric', 'boolean', 'event'], history: false, replay: false,
    heartbeatTimeoutMs: 60_000,
    open(context) { sessions.push(context); context.connected(); return () => { disposals++; }; },
  };
  return { adapter, sessions, disposals: () => disposals };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
