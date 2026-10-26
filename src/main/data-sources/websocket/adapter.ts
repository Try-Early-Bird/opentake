import {coinbasePriceMappingSchema,defaultCoinbasePriceMappings} from '../../../shared/coinbase-field-mappings';
import { isDeepStrictEqual } from 'node:util';
import { coinbaseSubscriptionSchema, defaultCoinbaseSourceConfig } from '../../../shared/coinbase-source';
import { z } from 'zod';
import { sourceConfigBase, validateSourceConfig } from '../config';
import { mapHttpSample, MissingSourceField } from '../http-adapter';
import { feedSchema, type AdapterContext, type FeedDefinition, type SourceAdapter } from '../contracts';
import { websocketAuthConfig } from './authentication';
import type { createSourceWebsocketTransport } from './transport';

export const websocketSourceConfig = sourceConfigBase.omit({ endpoint: true, credentialId: true, pollIntervalMs: true }).extend({
  transport: z.literal('websocket'),
  provider:z.object({kind:z.literal('coinbase-market'),priceMappings:coinbasePriceMappingSchema.default(defaultCoinbasePriceMappings),subscriptions:coinbaseSubscriptionSchema}).strict().optional(),
  connection: websocketAuthConfig,
  freshnessMs: z.number().int().min(15_000).max(86_400_000).default(60_000),
}).superRefine(validateSourceConfig).superRefine((config, ctx) => {
  if(config.provider && (!isDeepStrictEqual(config.connection,websocketAuthConfig.parse(defaultCoinbaseSourceConfig.connection)) || !isDeepStrictEqual(config.feeds,defaultCoinbaseSourceConfig.feeds) || config.freshnessMs!==15000)) ctx.addIssue({code:'custom',message:'Coinbase market data requires its provider connection, decoder and live storage policy'});
  if (config.feeds.some(feed => (feed.mapping.kind === 'text') !== (config.connection.dataMode === 'text'))) ctx.addIssue({code:'custom',message:'Text messages require text feed mappings'});
});
export interface WebsocketSource {
  id: string; ownerId: string; revision: number; enabled: boolean; validated: boolean;
  config: z.infer<typeof websocketSourceConfig>;
}
export function websocketFeedDefinitions(source: WebsocketSource): FeedDefinition[] {
  const config = websocketSourceConfig.parse(source.config);
  return config.feeds.map(feed => feedSchema.parse({
    ownerId: source.ownerId, sourceId: source.id, configVersion: source.revision,
    adapterId: 'custom-websocket', authScope: config.connection.auth.mode === 'none' ? 'public' : `credential:${config.connection.auth.credentialId}`,
    feedId: feed.id, schemaVersion: 1, parameters: feed.destination?.kind==='market-prices'?{marketRouting:feed.destination.market.kind}:feed.destination?.kind==='market-metadata'?{partialFields:'metadata'}:{}, kind: feed.mapping.kind, unit: feed.unit,
    semantics: feed.mapping.kind === 'event' ? 'event' : 'state', ordering: feed.destination?.kind==='market-prices'?'arrival':feed.eventTimePath ? 'event-time' : 'arrival',
    freshnessMs: config.freshnessMs,
    ...(feed.mapping.kind === 'event' ? { eventFields: Object.fromEntries(Object.entries(feed.mapping.fields).map(([key, item]) => [key, item.type])) } : {}),
  }));
}
type Transport = ReturnType<typeof createSourceWebsocketTransport>;
type Group = { members: Set<AdapterContext>; controller: AbortController; close?: () => void; ready: boolean; config: WebsocketSource['config'];
  // Frames seen by each feed since it joined, until one matches its mapping.
  unmatched: Map<AdapterContext, number> };
type WebsocketAdapter = Extract<SourceAdapter, { transport: 'websocket' }>;
/** Frames without a match before a feed reports its mapping as a (non-blocking) issue. */
export const UNMATCHED_FRAME_LIMIT = 20;
/** Injected host-owned source resolution; renderer cannot supply definitions.
 * One authenticated subscription per source revision, shared across its feeds.
 * The runtime owns retries, stale quality, leases and observation persistence. */
export function createWebsocketAdapter(transport: Transport, resolve: (feed: FeedDefinition) => Promise<WebsocketSource | null>, events?: {message(source: WebsocketSource,text:string):void; status(source:WebsocketSource,type:'open'|'close'|'notice',text:string):void}): WebsocketAdapter {
  const groups = new Map<string, Group>();
  const blocked = { configuration: true };
  return { id: 'custom-websocket', version: '1', transport: 'websocket', kinds: ['text', 'metric', 'boolean', 'event'], history: false, replay: false, heartbeatTimeoutMs: 45_000,
    open(context) {
      let group: Group | undefined, key = '', disposed = false;
      function dispose() {
        if (disposed) return;
        disposed = true; context.signal.removeEventListener('abort', dispose);
        if (!group) return;
        group.members.delete(context); group.unmatched.delete(context);
        if (!group.members.size) { if (groups.get(key) === group) groups.delete(key); group.controller.abort(); group.close?.(); }
      }
      context.signal.addEventListener('abort', dispose, { once: true });
      if (context.signal.aborted) dispose();
      void (async () => {
        if (disposed) return;
        let source: WebsocketSource | null;
        // Repository/database errors are internal and transient; retry with backoff.
        try { source = await resolve(context.feed); } catch { if (!disposed) context.fail('transport'); return; }
        if (disposed) return;
        if (!source || !source.enabled || !source.validated || source.config.collection === 'off') throw Error();
        const config = websocketSourceConfig.parse(source.config);
        const expected = websocketFeedDefinitions({ ...source, config }).find(feed => feed.feedId === context.feed.feedId);
        if (!expected || JSON.stringify(expected) !== JSON.stringify(feedSchema.parse(context.feed))) throw Error();
        key = JSON.stringify([source.ownerId, source.id, source.revision]);
        group = groups.get(key);
        if (group) {
          if (JSON.stringify(group.config) !== JSON.stringify(config)) throw Error();
          group.members.add(context); group.unmatched.set(context, 0);
          if (group.ready) { context.connected(); context.heartbeat(); }
          return;
        }
        const current: Group = { members: new Set([context]), controller: new AbortController(), ready: false, config, unmatched: new Map([[context, 0]]) };
        group = current; groups.set(key, current);
        function fail(reason: 'invalid_data' | 'transport', configuration = false) {
          if (current.controller.signal.aborted) return;
          groups.delete(key); events?.status(source!, 'close', configuration ? 'Connection stopped · response or credential needs attention' : 'Connection interrupted · retry scheduled'); current.controller.abort(); current.close?.();
          for (const member of [...current.members]) member.fail(reason, configuration ? blocked : undefined);
        }
        const connection = transport.connect(key, config.connection, current.controller.signal, {
          ready() { if (!current.controller.signal.aborted) { current.ready = true; events?.status(source!, 'open', 'Connected · subscription confirmed'); for (const member of current.members) { member.connected(); member.heartbeat(); } } },
          heartbeat() { if (!current.controller.signal.aborted) for (const member of current.members) member.heartbeat(); },
          message(text) { if (!current.controller.signal.aborted) events?.message(source!,text); },
          data(body) {
            if (current.controller.signal.aborted) return;
            try {
              // Validate every projection before emitting any part of this message. A frame lacking a
              // feed's mapped path is unmatched for that feed (heartbeat, ack, other channel), not an error.
              const samples = [...current.members].flatMap(member => {
                try { return [[member, mapHttpSample(config, member.feed.feedId, body)] as const]; }
                catch (error) { if (error instanceof MissingSourceField) return []; throw error; }
              });
              const matched = new Set(samples.map(([member]) => member));
              for (const member of current.members) {
                const seen = current.unmatched.get(member);
                if (seen === undefined) continue;
                if (matched.has(member)) { current.unmatched.delete(member); continue; }
                current.unmatched.set(member, seen + 1);
                // A connection that keeps delivering frames none of which match this feed: likely a wrong path.
                if (seen + 1 === UNMATCHED_FRAME_LIMIT) {
                  member.warn?.('invalid_data');
                  const name = config.feeds.find(feed => feed.id === member.feed.feedId)?.name ?? member.feed.feedId;
                  events?.status(source!, 'notice', `${name} · no match in ${UNMATCHED_FRAME_LIMIT} messages · check its mapped path`);
                }
              }
              for (const [member, sample] of samples) member.emit(sample);
            } catch { fail('invalid_data'); } // Malformed matched data is transient: reconnect with backoff.
          },
          failed(reason) { fail(['configuration', 'authentication', 'invalid_data', 'destination'].includes(reason) ? 'invalid_data' : 'transport', ['configuration', 'authentication', 'destination'].includes(reason)); },
        });
        current.close = connection.close;
        if (current.controller.signal.aborted) connection.close();
      })().catch(() => { if (!disposed) context.fail('invalid_data', blocked); });
      return dispose;
    },
  };
}
