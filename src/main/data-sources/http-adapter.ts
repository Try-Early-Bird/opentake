import { createHash } from 'node:crypto';
import { credentialEchoValues, containsCredentialEcho } from './credential-echo';
import { createCredentials } from '../credentials';
import type { SecretStore } from '../secret-store';
import { sourceConfigSchema, type CustomSourceConfig, type StoredSource } from './config';
import { sampleSchema, type DataSample, type FeedDefinition, type SourceAdapter } from './contracts';
import { SourceHttpError, type createSourceHttpClient } from './http';

/** A response or frame lacking a mapped path: unmatched (WS) or transient (HTTP), never a configuration error. */
export class MissingSourceField extends Error { constructor() { super('Missing source field'); } }
function field(input: unknown, path: string[], optional=false): unknown {
  let value = input;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {if(optional)return undefined;throw new MissingSourceField();}
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
/** Exact decimal text for a JSON number or exponent-form string: 1e-7 -> 0.0000001, 1e+21 -> 1000000000000000000000. */
export function exactDecimal(raw: unknown): unknown {
  const text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : null) : typeof raw === 'string' ? raw : null;
  const match = text === null ? null : /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,3})$/.exec(text);
  if (!match) return typeof raw === 'number' && text !== null ? text : raw;
  const [, sign, whole, fraction = '', exponent] = match, digits = whole + fraction, point = whole.length + Number(exponent);
  const shifted = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  let [integer, decimals = ''] = shifted.split('.');
  integer = integer.replace(/^0+(?=\d)/, ''); decimals = decimals.replace(/0+$/, '');
  const value = decimals ? `${integer}.${decimals}` : integer;
  return sign && /[1-9]/.test(value) ? `-${value}` : value;
}
export function mapHttpSample(config: Pick<CustomSourceConfig, 'feeds'>, feedId: string, body: unknown): DataSample {
  const feed = config.feeds.find(item => item.id === feedId);
  if (!feed) throw Error('Unknown source feed');
  const mapping = feed.mapping;
  if (mapping.kind === 'text') return sampleSchema.parse({payload:{kind:'text',value:body},eventTime:null,origin:'live'});
  const raw = mapping.kind === 'event' ? null : field(body, mapping.valuePath);
  const payload = mapping.kind === 'event'
    ? { kind: 'event', fields: Object.fromEntries(Object.entries(mapping.fields).flatMap(([name, item]) => {
      const partial=feed.destination?.kind==='market-metadata';
      const value = field(body, item.path,partial);
      if(partial&&(value===null||value===undefined))return [];
      if ((value === null ? 'null' : typeof value) !== item.type) throw Error('Invalid source field type');
      return [[name, value]];
    })) }
    : { kind: mapping.kind, value: mapping.kind === 'metric' ? exactDecimal(raw) : raw };
  const eventTime = feed.eventTimePath ? field(body, feed.eventTimePath) : null;
  // Explicit Unix milliseconds only. Never infer seconds, fabricate provider time or coerce booleans.
  return sampleSchema.parse({ payload, eventTime, origin: 'live' });
}
export function httpFeedDefinitions(source: StoredSource): FeedDefinition[] {
  const config = sourceConfigSchema.parse(source.config);
  return config.feeds.map(feed => ({ ownerId: source.ownerId, sourceId: source.id, configVersion: source.revision,
    adapterId: 'custom-http', authScope: config.credentialId ? `credential:${config.credentialId}` : 'public', feedId: feed.id, schemaVersion: 1, parameters: feed.destination?.kind==='market-prices'?{marketRouting:feed.destination.market.kind}:feed.destination?.kind==='market-metadata'?{partialFields:'metadata'}:{} as Record<string,string>,
    kind: feed.mapping.kind, unit: feed.unit, semantics: feed.mapping.kind === 'event' ? 'event' : 'state',
    ordering: feed.destination?.kind==='market-prices'?'arrival':feed.eventTimePath ? 'event-time' : 'arrival', freshnessMs: Math.min(86_400_000, config.pollIntervalMs * 3), pollIntervalMs: config.pollIntervalMs,
    ...(feed.mapping.kind === 'event' ? { eventFields: Object.fromEntries(Object.entries(feed.mapping.fields).map(([key, item]) => [key, item.type])) } : {}),
  }));
}
/** Registry admission/enablement and the SecretStore remain host-owned. */
/** A stored source/credential that cannot work until the user edits it: block instead of retrying. */
class SourceConfigurationError extends Error { constructor() { super('Source configuration needs attention'); } }
export function createHttpAdapter(client: Pick<ReturnType<typeof createSourceHttpClient>, 'read'>, resolve: (feed: FeedDefinition) => Promise<StoredSource | null>, secrets?: SecretStore, now: () => number = () => performance.now()): SourceAdapter {
  const credentials = secrets ? createCredentials(secrets) : null;
  const blocked = { configuration: true };
  // One request per source poll: each sibling feed polled within half an interval reuses the same response (or
  // failure) once. A feed's own next poll or retry always fetches anew.
  const shared = new Map<string, { at: number; body: Promise<unknown>; feeds: Set<string>; waiting: number; controller: AbortController }>();
  async function credential(id: string, endpoint: string) {
    try { return await credentials!.sourceHttpCredential(id, endpoint); }
    catch {
      // The resolver hides its reason. A readable inventory means the credential is missing or out of scope;
      // an unreadable store is an internal, transient failure.
      let readable = false; try { await credentials!.list(); readable = true; } catch { /* store unavailable */ }
      throw readable ? new SourceConfigurationError() : Error('Credential store unavailable');
    }
  }
  return { id: 'custom-http', version: '1', transport: 'http', kinds: ['metric', 'boolean', 'event'], history: false, replay: false,
    async poll(context) {
      let source: StoredSource | null;
      // Repository/database errors are internal and transient; retry with backoff.
      try { source = await resolve(context.feed); } catch { if (!context.signal.aborted) context.fail('transport'); return; }
      try {
        if (context.signal.aborted) return;
        if (!source || !source.enabled || !source.validated || source.id !== context.feed.sourceId || source.ownerId !== context.feed.ownerId || source.revision !== context.feed.configVersion || source.config.collection === 'off') { context.fail('invalid_data', blocked); return; }
        const parsed = sourceConfigSchema.safeParse(source.config);
        if (!parsed.success) { context.fail('invalid_data', blocked); return; }
        const config = parsed.data;
        const authScope = config.credentialId ? `credential:${config.credentialId}` : 'public';
        if (context.feed.authScope !== authScope) { context.fail('invalid_data', blocked); return; }
        // Resolve on every poll so deletion/rotation takes effect without a secret cache.
        const auth = config.credentialId && credentials ? await credential(config.credentialId, config.endpoint) : undefined;
        if (context.signal.aborted) return;
        if (config.credentialId && !auth) { context.fail('invalid_data', blocked); return; }
        const hidden = credentialEchoValues(auth);
        const definition = config.feeds.find(feed => feed.id === context.feed.feedId);
        // Check paths as well as projected values; never emit the raw response.
        if (!definition || containsCredentialEcho({ mapping: definition.mapping, eventTimePath: definition.eventTimePath }, hidden)) { context.fail('invalid_data', blocked); return; }
        // A rotated credential never reuses a response fetched with the previous value.
        const key = JSON.stringify([source.ownerId, source.id, source.revision, authScope, config.endpoint, createHash('sha256').update(JSON.stringify(auth ?? null)).digest('hex')]), time = now();
        for (const [item, value] of shared) if (time - value.at >= config.pollIntervalMs / 2) shared.delete(item);
        let request = shared.get(key);
        if (!request || request.feeds.has(context.feed.feedId) || request.controller.signal.aborted) {
          // The shared read runs under its own signal, cancelled only once every joined feed has cancelled:
          // one feed's cancellation never fails the siblings waiting on the same response.
          const controller = new AbortController();
          const current = { at: time, controller, waiting: 0, feeds: new Set<string>(), body: client.read(`${source.ownerId}:${source.id}`, config.endpoint, controller.signal, auth) };
          current.body.catch(() => { if (controller.signal.aborted && shared.get(key) === current) shared.delete(key); }); shared.set(key, current);
          request = current;
        }
        request.feeds.add(context.feed.feedId);
        const joined = request, signal = context.signal;
        joined.waiting++;
        let leave = () => {};
        const body = await new Promise<unknown>((accept, reject) => {
          const abort = () => { leave(); reject(Error('Feed cancelled')); };
          leave = () => { leave = () => {}; signal.removeEventListener('abort', abort); if (--joined.waiting === 0 && signal.aborted) joined.controller.abort(); };
          signal.addEventListener('abort', abort, { once: true });
          joined.body.then(value => { leave(); accept(value); }, error => { leave(); reject(error); });
        });
        if (context.signal.aborted) return;
        let sample: DataSample;
        // A body missing a field or holding a malformed value is transient provider data: retry at the poll interval.
        try { sample = mapHttpSample(source.config, context.feed.feedId, body); }
        catch { context.fail('invalid_data', { retryAfterMs: config.pollIntervalMs }); return; }
        if (containsCredentialEcho(sample, hidden)) { context.fail('invalid_data', blocked); return; }
        context.connected(); context.emit(sample);
      } catch (error) {
        if (context.signal.aborted) return;
        if (error instanceof SourceHttpError) context.fail(error.code === 'authentication' || error.code === 'destination' ? 'invalid_data' : 'transport', { retryAfterMs: error.retryAfterMs, configuration: error.code === 'authentication' || error.code === 'destination' });
        else if (error instanceof SourceConfigurationError) context.fail('invalid_data', blocked);
        // Anything else (credential store, hashing, internal faults) is transient: back off and retry.
        else context.fail('transport');
      }
    },
  };
}
