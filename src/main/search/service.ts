import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { marketHitSchema, marketKey, rankMarkets, searchInputSchema, type MarketHit, type SearchSnapshot, type SearchSource } from '../../shared/search';
import { connectionFailure } from '../connection-errors';

export interface SearchAdapter {
  id: string; label: string;
  status(): Promise<SearchSource>;
  lookup(query: string, signal: AbortSignal): Promise<{ markets: MarketHit[]; truncated: boolean; incomplete?: boolean }>;
  /** Optional display-only quotes. Basic matches are published before this runs. */
  enrich?(markets: MarketHit[], signal: AbortSignal): Promise<MarketHit[]>;
  resolve(hit: MarketHit, signal: AbortSignal): Promise<MarketHit | null>;
  clear?(): void;
  owns(hit: MarketHit): boolean;
}
export type LocalSearch = (query: string, archived: boolean) => Promise<{ takes: SearchSnapshot['takes']; truncated: boolean }>;

// Fence adapters even when an upstream ignores cancellation; late promises cannot
// publish into a completed/cancelled query. No raw provider errors cross IPC.
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms);
  try {
    if (parent.aborted) abort();
    controller.signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const stop = () => reject(new Error('Search cancelled or timed out'));
      controller.signal.addEventListener('abort', stop, { once: true });
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop));
    });
  } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); controller.abort(); }
}

export function createSearchService(adapters: SearchAdapter[], local: LocalSearch, timeoutMs = 15_000, remoteDelayMs = 650) {
  const requests = new Map<string, { owner: string; controller: AbortController; snapshot: SearchSnapshot; expiry: ReturnType<typeof setTimeout> }>();
  const copy = (snapshot: SearchSnapshot) => structuredClone(snapshot);
  function discard(id: string) {
    const request = requests.get(id);
    if (!request) return;
    request.controller.abort(); clearTimeout(request.expiry); requests.delete(id);
  }
  return {
    async sources(): Promise<SearchSource[]> {
      return Promise.all(adapters.map(adapter => bounded(() => adapter.status(), new AbortController().signal, timeoutMs)
        .catch(() => ({ id: adapter.id, label: adapter.label, connected: false, capabilities: { lookup: true, details: false, screening: false } }))));
    },
    start(raw: unknown, owner: string): SearchSnapshot {
      const input = searchInputSchema.parse(raw);
      const selected = [...new Set(input.sources)].map(id => {
        const adapter = adapters.find(a => a.id === id);
        if (!adapter) throw new Error('Unknown search source');
        return adapter;
      });
      // One live query per renderer client, bounded across clients as well.
      if (requests.has(input.id)) throw new Error('Search request already exists');
      for (const [id, request] of requests) if (request.owner === owner) discard(id);
      if (requests.size >= 16) throw new Error('Too many search clients');
      const controller = new AbortController();
      const snapshot: SearchSnapshot = {
        id: input.id, query: input.query, takes: [], localState: 'pending', localTruncated: false, done: false,
        sources: selected.map(a => ({ id: a.id, label: a.label, state: 'pending', markets: [], truncated: false })),
      };
      const expiry = setTimeout(() => discard(input.id), 90_000); expiry.unref();
      requests.set(input.id, { owner, controller, snapshot, expiry });
      const done = () => { snapshot.done = snapshot.localState !== 'pending' && snapshot.sources.every(s => s.state !== 'pending'); };
      void bounded(() => local(input.query, input.archived), controller.signal, timeoutMs).then(result => {
        if (controller.signal.aborted) return;
        snapshot.takes = result.takes.slice(0, 20); snapshot.localTruncated = result.truncated; snapshot.localState = 'complete';
      }).catch(() => { snapshot.localState = controller.signal.aborted ? 'cancelled' : 'failed'; }).finally(done);
      let cursor = 0;
      const worker = async () => {
        while (cursor < selected.length && !controller.signal.aborted) {
          const index = cursor++; const adapter = selected[index]; const result = snapshot.sources[index];
          let incomplete = false;
          try {
            await bounded(async signal => {
              // Local results arrive first. A longer pause keeps MCP calls away
              // from individual keystrokes, including when lookup found nothing.
              if (remoteDelayMs) await delay(remoteDelayMs, undefined, { signal });
              const source = await adapter.status(); signal.throwIfAborted();
              if (!source.connected) { result.state = 'disconnected'; return; }
              if (!source.capabilities.lookup) { result.state = 'unsupported'; return; }
              const response = await adapter.lookup(input.query, signal); signal.throwIfAborted();
              const unique = new Map<string, MarketHit>();
              for (const value of response.markets.slice(0, 3000)) {
                const hit = marketHitSchema.parse(value);
                if (!adapter.owns(hit)) throw new Error('Wrong source');
                unique.set(marketKey(hit), hit);
              }
              result.markets = rankMarkets([...unique.values()], input.query);
              result.truncated = response.truncated || response.markets.length > 3000;
              incomplete = response.incomplete === true;
              if (incomplete) result.message = 'Some results are unavailable. Try again.';
              if (!adapter.enrich) result.state = incomplete ? 'partial' : 'complete';
            }, controller.signal, timeoutMs);
            if (result.state === 'pending' && adapter.enrich) {
              try {
                const enriched = await bounded(signal => adapter.enrich!(result.markets, signal), controller.signal, Math.min(timeoutMs, 4000));
                controller.signal.throwIfAborted();
                // Enrichment can add display data, never substitute a market.
                const quotes = new Map(enriched.map(value => {
                  const hit = marketHitSchema.parse(value); return [marketKey(hit), hit] as const;
                }));
                result.markets = result.markets.map(hit => {
                  const update = quotes.get(marketKey(hit));
                  return update?.symbol === hit.symbol ? { ...hit, ...(update.quote ? { quote: update.quote } : {}) } : hit;
                });
              } catch { /* A missing quote must not discard a matching market. */ }
              controller.signal.throwIfAborted();
              result.state = incomplete ? 'partial' : 'complete';
            }
          } catch (error) {
            result.state = controller.signal.aborted ? 'cancelled' : connectionFailure(error).code === 'reauth_required' ? 'disconnected' : 'failed';
            result.message = result.state === 'failed' ? 'Search unavailable. Try again.' : undefined;
          } finally { done(); }
        }
      };
      for (let i = 0; i < Math.min(3, selected.length); i++) void worker();
      return copy(snapshot);
    },
    snapshot(raw: unknown, owner: string): SearchSnapshot | null {
      const request = requests.get(z.uuid().parse(raw));
      return request?.owner === owner ? copy(request.snapshot) : null;
    },
    cancel(raw: unknown, owner: string) {
      const id = z.uuid().parse(raw);
      if (requests.get(id)?.owner === owner) discard(id);
    },
    async resolve(raw: unknown): Promise<MarketHit | null> {
      const hit = marketHitSchema.parse(raw);
      const adapter = adapters.find(a => a.owns(hit));
      if (!adapter) return null;
      return bounded(async signal => {
        const status = await adapter.status(); signal.throwIfAborted();
        if (!status.connected || !status.capabilities.details) return null;
        const result = await adapter.resolve(hit, signal); signal.throwIfAborted();
        if (!result) return null;
        const validated = marketHitSchema.parse(result);
        return adapter.owns(validated) && marketKey(validated) === marketKey(hit) ? validated : null;
      }, new AbortController().signal, timeoutMs).catch(() => null);
    },
    clear() { for (const id of requests.keys()) discard(id); for (const adapter of adapters) adapter.clear?.(); },
    busy() { return [...requests.values()].some(request => !request.snapshot.done); },
  };
}
