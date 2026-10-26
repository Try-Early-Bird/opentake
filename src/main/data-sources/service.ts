import {readRuleEventInbox} from './event-inbox';
import {marketSuggestionRequest,marketSuggestions} from './market-suggestions';
import {takeInputSchema} from '../../shared/take-inputs';
import {evaluateTakeInput,evaluateStoredTakeInput} from './take-inputs';
import { createWebsocketMessages } from './websocket/messages';
import { savedSourceConfig, isWebsocketSource } from './saved-config';
import { createWebsocketAdapter, websocketFeedDefinitions } from './websocket/adapter';
import { createSourceWebsocketTransport } from './websocket/transport';
import { websocketAuthConfig, prepareWebsocketAuthentication } from './websocket/authentication';
import { previewWebsocket } from './websocket/preview';
import { mapHttpSample } from './http-adapter';
import { readStoredMarketPrice } from './market-price-reader';
import { credentialEchoValues } from './credential-echo';
import { readMarketMetadata } from './metadata-reader';
import { marketIdentitySchema } from '../../shared/search';
import { applyDestination } from './destinations';
import type { DataObservation } from '../../shared/data-sources';
import { createCredentials } from '../credentials';
import { endpointSchema } from './config';
import { inspectSourceResponse } from './inspection';
import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';
import type { SecretStore } from '../secret-store';
import { createSourceRepository } from './repository';
import { createObservationStorage } from './storage';
import { createSourceHttpClient } from './http';
import { createHttpAdapter, httpFeedDefinitions } from './http-adapter';
import { createDataSourceHostService } from './host-service';
import { sampleSchema } from './contracts';

const revision = z.object({ id: z.uuid(), revision: z.number().int().positive() });
const requestSchema = z.discriminatedUnion('action', [
  marketSuggestionRequest,
  z.object({ action: z.literal('inspect'), endpoint: endpointSchema, credentialId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('websocket-list') }).strict(),
  revision.extend({ action:z.literal('websocket-messages'),after:z.number().int().nonnegative().optional() }).strict(),
  revision.extend({ action:z.literal('websocket-policy'),collection:z.enum(['automatic','when-open']).optional(),storage:z.enum(['live','latest','history']).optional(),sampleEveryMs:z.number().int().min(1000).max(86400000).optional(),retentionDays:z.union([z.literal(1),z.literal(7),z.literal(30),z.literal(90)]).optional() }).strict(),
  z.object({ action: z.literal('websocket-inspect'), connection: websocketAuthConfig }).strict(),
  z.object({ action: z.literal('market-price'), market: marketIdentitySchema }).strict(),
  z.object({ action: z.literal('market-metadata'), market: marketIdentitySchema }).strict(),
  z.object({ action: z.literal('destination-status'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('save'), config: z.unknown(), existing: revision.strict().optional() }).strict(),
  revision.extend({ action: z.literal('preview') }).strict(),
  revision.extend({ action: z.literal('enable'), enabled: z.boolean() }).strict(),
]);
/** One host coordinator; no renderer-supplied owner, transport, secret or durable demand. */
export function createCustomDataSources(database: Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>, secrets: SecretStore,
  client = createSourceHttpClient(), websocket?: ReturnType<typeof createSourceWebsocketTransport>) {
  const repository = createSourceRepository(database);
  const credentials = createCredentials(secrets);
  const wsTransport = websocket ?? createSourceWebsocketTransport({ credential: credentials.sourceWebsocketCredential });
  const messages = createWebsocketMessages();
  const storage = createObservationStorage(database);
  let service = createDataSourceHostService();
  let initialized = false, closed = false, suspended = false;
  let pending: Promise<unknown> = Promise.resolve();
  let operations = 0;
  let preview = new AbortController();
  let previewClientId: string | undefined;
  const owner = () => database.use(async db => {
    const rows = (await db.query<{id: string}>('SELECT id FROM local_owners LIMIT 2')).rows;
    if (rows.length !== 1) throw Error('Source owner unavailable');
    return rows[0].id;
  });
  const adapter = createHttpAdapter(client, async feed => {
    const source = (await repository.list(await owner())).find(source => source.id === feed.sourceId);
    return source && !isWebsocketSource(source) ? source : null;
  }, secrets);
  const wsAdapter = createWebsocketAdapter(wsTransport, async feed => {
    const source = (await repository.list(await owner())).find(source => source.id === feed.sourceId);
    return source && isWebsocketSource(source) ? source : null;
  }, {
    message(source,text) { let type:'json'|'text'='text';try {JSON.parse(text);type='json';}catch{} messages.add(source.id,source.revision,type,text); },
    status(source,type,text) { messages.add(source.id,source.revision,type,text); },
  });
  const eventDemands=new Map<string,import('./rule-events').RuleEventSubscription[]>();
  const ruleDemands=new Map<string,import('../../shared/data-sources').DataFeedRef[]>();
  function stop() { service.close(); messages.clear(); cancelPreview(); initialized = false; }
  function cancelPreview() { preview.abort(); preview = new AbortController(); }
  /** Incremental by default: only sources whose feeds changed restart. `full` rebuilds every connection. */
  async function refresh(full = false) {
    const sources = (await repository.list(await owner())).filter(source=>!isWebsocketSource(source)||!source.config.provider);
    if (closed) throw Error('Data sources stopping');
    const definitions = sources.filter(source => source.enabled && source.validated && source.config.collection !== 'off').flatMap(source => isWebsocketSource(source) ? websocketFeedDefinitions(source) : httpFeedDefinitions(source));
    const durable = suspended ? [] : sources.filter(source=>isWebsocketSource(source)&&source.enabled&&source.validated&&source.config.collection==='automatic').flatMap(source=>isWebsocketSource(source)?websocketFeedDefinitions(source):[]);
    if (initialized && !full) service.update(definitions, durable);
    else {
      const next = createDataSourceHostService([adapter, wsAdapter], definitions, { durable, runtime: { limits:{sampleBytes:512*1024}, onObservation: (feed, observation) => storage.enqueue(feed.ownerId, observation),
        // Quarantined (unpersistable) observations surface on the feed's existing issue field until one commits.
        issue: feed => storage.quarantinedFeed({sourceId:feed.sourceId,configVersion:feed.configVersion,feedId:feed.feedId}) ? 'invalid_data' : null } });
      service.close(); service = next;
      if (suspended) service.suspend();
    }
    service.ruleDemand([...ruleDemands.values()].flat());
    initialized = true;
  }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    if (closed || operations >= 8) return Promise.reject(Error('Data source request unavailable'));
    operations++;
    const result = pending.then(async () => { if (closed) throw Error('Data sources stopping'); return work(); });
    pending = result.catch(() => {}).finally(() => { operations--; });
    return result;
  }
  return {
    ruleEvents(takeId:string,subscriptions:import('./rule-events').RuleEventSubscription[]){
      z.uuid().parse(takeId);if(subscriptions.length>16)throw Error('Too many event rules');if(subscriptions.length)eventDemands.set(takeId,subscriptions);else eventDemands.delete(takeId);
    },
    async ruleEventBatch(takeId:string,ruleId:string){const subscription=eventDemands.get(takeId)?.find(item=>item.ruleId===ruleId);if(!subscription||closed||suspended)return null;return database.use(db=>readRuleEventInbox(db,takeId,subscription.revision,ruleId));},
    async ruleFetch(raw:import('../../shared/take-inputs').TakeInput,freshness:'latest'|'next',timeoutMs:number,signal:AbortSignal){
      const binding=takeInputSchema.parse(raw),ownerId=await owner();
      const before=(await repository.list(ownerId)).find(source=>source.id===binding.sourceId);
      if(!before||before.revision!==binding.sourceRevision||!before.enabled||!before.validated||before.config.collection==='off'||closed||suspended||signal.aborted)throw Error('Source unavailable');
      const metadata=before.config.feeds.find(feed=>feed.id===binding.feedId)?.destination?.kind==='market-metadata';
      const started=Date.now();
      const fingerprint=(value:Awaited<ReturnType<typeof evaluateStoredTakeInput>>|undefined)=>JSON.stringify(value?{value:value.value,observation:value.observation}:null);
      const baseline=metadata?await database.use(db=>evaluateStoredTakeInput(db,binding,{...before,current_revision:before.revision},service.peek([{sourceId:binding.sourceId,feedId:binding.feedId,configVersion:binding.sourceRevision,schemaVersion:1}])[0],started)):undefined;
      let committed:Awaited<ReturnType<typeof evaluateStoredTakeInput>>|undefined;
      const snapshot=await service.ruleRead({sourceId:binding.sourceId,feedId:binding.feedId,configVersion:binding.sourceRevision,schemaVersion:1},freshness,timeoutMs,signal,metadata?async snapshot=>{
        await storage.flush();
        committed=await database.use(db=>db.transaction(async tx=>{
          const current=(await tx.query<{id:string;current_revision:number;enabled:boolean;validated:boolean;config:unknown}>(`SELECT s.id,s.current_revision,s.enabled,s.validated,r.config FROM data_sources s JOIN data_source_revisions r ON r.source_id=s.id AND r.revision=s.current_revision WHERE s.owner_id=$1 AND s.id=$2 FOR SHARE OF s`,[ownerId,binding.sourceId])).rows[0];
          return evaluateStoredTakeInput(tx,binding,current,snapshot,Date.now());
        }));
        return committed.quality==='fresh'&&(freshness==='latest'||committed.observation!.receivedAt>=started&&fingerprint(committed)!==fingerprint(baseline));
      }:undefined);
      const current=(await repository.list(ownerId)).find(source=>source.id===binding.sourceId);
      if(closed||suspended||signal.aborted)throw Error('Source unavailable');
      if(metadata){if(!current||current.revision!==binding.sourceRevision||!current.enabled||!current.validated||current.config.collection==='off'||!committed)throw Error('Source unavailable');return committed;}
      return evaluateTakeInput(binding,current?{...current,current_revision:current.revision}:undefined,snapshot,Date.now());
    },
    ruleDemand(takeId:string,refs:import('../../shared/data-sources').DataFeedRef[]){
      const next=new Map(ruleDemands);if(refs.length)next.set(takeId,refs);else next.delete(takeId);
      service.ruleDemand([...next.values()].flat());ruleDemands.clear();for(const [id,items] of next)ruleDemands.set(id,items);
    },
    peek(refs:import('../../shared/data-sources').DataFeedRef[]){return service.peek(refs);},
    start() { return serial(refresh); },
    async dispatch(method: string, args: unknown[], clientId: string) {
      z.uuid().parse(clientId);
      if (method === 'dataSources:drop-client' && args.length === 0 && previewClientId === clientId) {
        preview.abort(); preview = new AbortController();
      }
      // Lease renewals/releases must not wait behind a network preview.
      if (!closed && initialized && method !== 'dataSources:configure') {
        return Promise.resolve(service.dispatch(method, args, clientId));
      }
      return serial(async () => {
        z.uuid().parse(clientId);
        if (method === 'dataSources:configure') {
          if (args.length !== 1) throw Error('Invalid source configuration request');
          const input = requestSchema.parse(args[0]), ownerId = await owner();
          if('id' in input){const target=(await repository.list(ownerId)).find(source=>source.id===input.id);if(target&&isWebsocketSource(target)&&target.config.provider)throw Error('Use the provider source editor');}
          if (input.action === 'inspect') {
            if (suspended) throw Error('Data sources suspended');
            const signal = preview.signal;
            previewClientId = clientId;
            try {
              const auth = input.credentialId ? await credentials.sourceHttpCredential(input.credentialId, input.endpoint) : undefined;
              if (signal.aborted || closed) throw Error();
              const body = await client.read(`inspect:${ownerId}`, input.endpoint, signal, auth, 'preview');
              if (signal.aborted || closed) throw Error();
              const hidden = credentialEchoValues(auth);
              return inspectSourceResponse(body, hidden);
            } catch { throw Error('Could not inspect source. Check the endpoint, credential and JSON response.'); }
            finally { previewClientId = undefined; }
          }
          if (input.action === 'market-suggestions') return database.use(db=>marketSuggestions(db,input.venue,input.query));
          if (input.action === 'market-price') return database.use(db => readStoredMarketPrice(db, input.market));
          if (input.action === 'market-metadata') return database.use(db => readMarketMetadata(db, ownerId, input.market));
          if (input.action === 'list') return (await repository.list(ownerId)).filter(source => !isWebsocketSource(source));
          if (input.action === 'websocket-list') return (await repository.list(ownerId)).filter(isWebsocketSource).filter(source=>!source.config.provider);
          if (input.action === 'websocket-inspect') {
            if (suspended) throw Error('Data sources suspended');
            const signal = preview.signal; previewClientId = clientId;
            try { const body=await previewWebsocket(wsTransport, input.connection, signal); return input.connection.dataMode==='text' ? {text:body} : inspectSourceResponse(body); }
            finally { previewClientId = undefined; }
          }
          if (input.action === 'destination-status') return database.use(async db => (await db.query(`SELECT d.feed_id,d.revision,d.target,d.outcome,d.checked_at FROM data_source_destination_status d JOIN data_sources s ON s.id=d.source_id AND s.current_revision=d.revision WHERE s.id=$1 AND s.owner_id=$2 ORDER BY d.feed_id`, [input.id, ownerId])).rows);
          if (input.action === 'websocket-messages') {
            const source=(await repository.list(ownerId)).find(item=>item.id===input.id&&item.revision===input.revision);
            if (!source || !isWebsocketSource(source)) throw Error('Source changed');
            return messages.read(input.id,input.revision,input.after);
          }
          if (input.action === 'websocket-policy') {
            const source=(await repository.list(ownerId)).find(item=>item.id===input.id&&item.revision===input.revision);
            if(!source || !isWebsocketSource(source)) throw Error('Source changed');
            cancelPreview();
            const next=await repository.save(ownerId,{...source.config,collection:input.collection??source.config.collection,feeds:source.config.feeds.map(feed=>({...feed,storage:{...feed.storage,mode:input.storage??feed.storage.mode,sampleEveryMs:input.sampleEveryMs??feed.storage.sampleEveryMs,retentionDays:input.retentionDays??feed.storage.retentionDays}}))},{id:source.id,revision:source.revision});
            // Only collection/retention changed; keep the exact connection/mapping validation.
            if(source.validated) await repository.validate(ownerId,next.id,next.revision);
            if(source.enabled && source.validated) await repository.enable(ownerId,next.id,next.revision,true);
            await refresh();return {...next,validated:source.validated,enabled:source.enabled&&source.validated};
          }
          if (input.action === 'save') {
            const config = savedSourceConfig.parse(input.config);
            if('provider' in config && config.provider)throw Error('Use the provider source editor');
            if(input.existing){const target=(await repository.list(ownerId)).find(source=>source.id===input.existing!.id);if(target&&isWebsocketSource(target)&&target.config.provider)throw Error('Use the provider source editor');}
            // Validate and persist before touching the running host: a failure leaves the previous configuration collecting.
            cancelPreview();
            if ('transport' in config) await prepareWebsocketAuthentication(config.connection, credentials.sourceWebsocketCredential, preview.signal);
            const source = await repository.save(ownerId, config, input.existing);
            await refresh(); return source;
          }
          if (input.action === 'enable') {
            cancelPreview(); await repository.enable(ownerId, input.id, input.revision, input.enabled);
            await refresh(); return null;
          }
          if (suspended) throw Error('Data sources suspended');
          const source = (await repository.list(ownerId)).find(item => item.id === input.id && item.revision === input.revision);
          if (!source) throw Error('Source changed; reload before preview');
          const samples: ReturnType<typeof sampleSchema.parse>[] = [];
          const signal = preview.signal;
          previewClientId = clientId;
          try {
            if (isWebsocketSource(source)) {
              const body = await previewWebsocket(wsTransport, source.config.connection, signal);
              for (const feed of source.config.feeds) samples.push(mapHttpSample(source.config, feed.id, body));
            } else {
              const candidate = { ...source, enabled: true, validated: true, config: { ...source.config, collection: 'when-open' as const } };
              let response: Promise<unknown> | undefined;
              const previewClient = { read: (...params: Parameters<typeof client.read>) => response ??= client.read(`preview:${params[0]}`, params[1], params[2], params[3], 'preview') };
              const probe = createHttpAdapter(previewClient, async () => candidate, secrets);
              if (probe.transport !== 'http') throw Error('Invalid source transport');
              for (const feed of httpFeedDefinitions(candidate)) {
                let failed = false;
                await probe.poll({ feed, epoch: 1, signal, connected() {}, heartbeat() {}, fail() { failed = true; }, emit(sample) { samples.push(sampleSchema.parse(sample)); } });
                if (failed || signal.aborted || closed) throw Error('Source preview failed; check endpoint, mapping and credential');
              }
            }
          } finally { previewClientId = undefined; }
          const destinations = await database.use(db => db.transaction(async tx => {
            const results: unknown[] = [];
            for (const [index, feed] of source.config.feeds.entries()) {
              const sample = samples[index], receivedAt = Date.now();
              if (!sample) throw Error('Source preview incomplete');
              const observation: DataObservation = { ...sample, sourceId: source.id, configVersion: source.revision, schemaVersion: 1, feedId: feed.id,
                adapterId: isWebsocketSource(source) ? 'custom-websocket' : 'custom-http', adapterVersion: '1', epoch: 0, unit: feed.unit, receivedAt, timeBasis: sample.eventTime === null ? 'receipt' : 'provider', clockSkewMs: 0 };
              const result = await applyDestination(tx, ownerId, feed, observation, receivedAt, true);
              if (result) {
                results.push({ feedId: feed.id, ...result });
                if (['invalid', 'stale', 'missing-market', 'namespace-conflict', 'holdings-unavailable'].includes(result.outcome)) throw Error('Destination preview rejected; check market, timestamp, namespace and write policy');
              }
            }
            return results;
          }));
          if (signal.aborted || closed) throw Error('Source preview cancelled');
          previewClientId = undefined;
          await repository.validate(ownerId, input.id, input.revision);
          return { samples, destinations };
        }
        if (!initialized) await refresh();
        return service.dispatch(method, args, clientId);
      });
    },
    invalidateCredentials() { stop(); void serial(() => refresh(true)).catch(()=>{}); },
    suspend() { suspended = true; preview.abort(); preview = new AbortController(); service.suspend(); },
    resume() { if (!closed) { suspended = false; service.resume(); void serial(refresh).catch(()=>{}); } },
    async close() { closed = true; stop(); await pending; await storage.close(); },
  };
}
