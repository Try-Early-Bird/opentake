import type {RuleEventSubscription} from './rule-events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DataFeedInfo, DataLease, DataLeaseRead } from '../../shared/data-sources';
import { feedSchema, type FeedDefinition, type SourceAdapter } from './contracts';
import { createDataSourceRuntime } from './runtime';

const refSchema = z.object({ sourceId: z.string().min(1).max(128), feedId: z.string().min(1).max(128),
  configVersion: z.number().int().positive(), schemaVersion: z.number().int().positive() }).strict();
const idsSchema = z.array(z.uuid()).max(32).refine(ids => new Set(ids).size === ids.length);
const key = (ref: z.infer<typeof refSchema>) => JSON.stringify([ref.sourceId, ref.feedId, ref.configVersion, ref.schemaVersion]);
type Handle = ReturnType<ReturnType<typeof createDataSourceRuntime>['acquire']>;
type Lease = { clientId: string; expiresAt: number; handle: Handle; feed: string };
const TTL = 30_000, RENEW = 10_000, MAX_LEASES = 128;

/** Host-owned catalog. No renderer-supplied definitions, URLs, auth scope or durable demand. */
export function createDataSourceHostService(adapters: readonly SourceAdapter[] = [], definitions: readonly FeedDefinition[] = [], options: {
  durable?: readonly FeedDefinition[];
  monotonic?: () => number; runtime?: Parameters<typeof createDataSourceRuntime>[1];
} = {}) {
  const now = options.monotonic ?? (() => performance.now());
  function build(raw: readonly FeedDefinition[], durable: readonly FeedDefinition[]) {
    const next = new Map<string, FeedDefinition>();
    if (raw.length > 200) throw Error('Data catalog capacity reached');
    for (const item of raw) {
      const feed = feedSchema.parse(item), id = key(feed);
      if (next.has(id)) throw Error('Duplicate data feed');
      next.set(id, feed);
    }
    for (const feed of durable) if (!next.has(key(feed))) throw Error('Durable feed unavailable');
    return next;
  }
  let catalog = build(definitions, options.durable ?? []);
  const runtime = createDataSourceRuntime(adapters, options.runtime);
  const durableHandles = new Map<string, Handle>();
  for (const feed of options.durable ?? []) if (!durableHandles.has(key(feed))) durableHandles.set(key(feed), runtime.acquire(catalog.get(key(feed))!, {mode:'latest',demand:'durable'}));
  const leases = new Map<string, Lease>();
  const eventHandles=new Map<string,{takeId:string;identity:string;handle:Handle}>();
  const ruleHandles=new Map<string,Handle>();
  const lastRead = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined, closed = false, suspended = false;
  function remove(id: string) {
    const lease = leases.get(id); if (!lease) return;
    lease.handle.release(); leases.delete(id);
    if (![...leases.values()].some(item => item.clientId === lease.clientId)) lastRead.delete(lease.clientId);
    if (!leases.size && timer) { clearInterval(timer); timer = undefined; }
  }
  function expire() { for (const [id, lease] of leases) if (lease.expiresAt <= now()) remove(id); }
  function owned(clientId: string, id: string) { const lease = leases.get(id); return lease?.clientId === clientId ? lease : undefined; }
  function receipt(id: string, lease: Lease): DataLease { return { leaseId: id, expiresInMs: Math.max(0, lease.expiresAt - now()), renewAfterMs: RENEW }; }
  function dropClient(clientId: string) { for (const [id, lease] of leases) if (lease.clientId === clientId) remove(id); }
  return {
    ruleEvents(takeId:string,subscriptions:RuleEventSubscription[],gap=false){
      z.uuid().parse(takeId);if(subscriptions.length>16)throw Error('Too many event rules');
      const wanted=new Map(subscriptions.map(item=>[`${takeId}:${z.uuid().parse(item.ruleId)}`,{...item,identity:JSON.stringify([item.revision,refSchema.parse(item.ref)])}]));
      for(const [id,item] of eventHandles)if(item.takeId===takeId&&wanted.get(id)?.identity!==item.identity){item.handle.release();eventHandles.delete(id);}
      if(closed)return;
      for(const [id,item] of wanted){
        if(eventHandles.has(id))continue;
        const feed=catalog.get(key(item.ref));if(!feed||feed.kind!=='event'||feed.semantics!=='event')continue;
        if(eventHandles.size>=128)throw Error('Event rule capacity reached');
        eventHandles.set(id,{takeId,identity:item.identity,handle:runtime.acquire(feed,{mode:'events',demand:'durable',initialGap:gap})});
      }
    },
    ruleEventBatch(takeId:string,ruleId:string){return !closed&&!suspended?eventHandles.get(`${takeId}:${ruleId}`)?.handle.batch(8)??null:null;},
    async ruleRead(ref:import('../../shared/data-sources').DataFeedRef,freshness:'latest'|'next',timeoutMs:number,signal:AbortSignal,accept?:(snapshot:import('../../shared/data-sources').DataSnapshot)=>Promise<boolean>){
      if(closed||suspended||signal.aborted)throw Error('Source unavailable');
      z.enum(['latest','next']).parse(freshness);z.number().int().min(1).max(5000).parse(timeoutMs);
      const feed=catalog.get(key(refSchema.parse(ref)));if(!feed)throw Error('Source unavailable');
      const started=Date.now(),handle=runtime.acquire(feed,{mode:'latest',demand:'durable'}),baseline=JSON.stringify(handle.read().latest);
      let unwatch=()=>{};
      // Event-driven: re-check only when the runtime reports an observation or connection change.
      try{return await new Promise<import('../../shared/data-sources').DataSnapshot>((resolve,reject)=>{
        let done=false,running=false,again=false;
        const finish=(snapshot?:import('../../shared/data-sources').DataSnapshot)=>{if(done)return;done=true;clearTimeout(timer);unwatch();signal.removeEventListener('abort',abort);snapshot?resolve(snapshot):reject(Error('Source unavailable'));};
        const abort=()=>finish();signal.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>finish(),Math.max(0,timeoutMs-(Date.now()-started)));
        const check=async()=>{
          if(done)return;if(running){again=true;return;}running=true;
          try{do{again=false;
            if(closed||suspended||signal.aborted||Date.now()-started>=timeoutMs){finish();return;}
            const snapshot=handle.read();
            if(snapshot.quality==='fresh'&&snapshot.connection==='live'&&snapshot.latest&&(freshness==='latest'||snapshot.latest.receivedAt>=started&&JSON.stringify(snapshot.latest)!==baseline)&&(!accept||await accept(snapshot))){if(closed||suspended||signal.aborted||Date.now()-started>=timeoutMs){finish();return;}finish(snapshot);return;}
          }while(again&&!done);}catch{finish();}finally{running=false;}
        };
        unwatch=handle.watch(()=>void check());void check();
      });}finally{unwatch();handle.release();}
    },
    ruleDemand(refs:import('../../shared/data-sources').DataFeedRef[]){
      const wanted=new Map(refs.map(ref=>{const parsed=refSchema.parse(ref);return [key(parsed),parsed];}));
      if(wanted.size>128)throw Error('Rule feed capacity reached');
      for(const [id,handle] of ruleHandles)if(!wanted.has(id)){handle.release();ruleHandles.delete(id);}
      if(closed)return;
      for(const id of wanted.keys()){const feed=catalog.get(id);if(feed&&!ruleHandles.has(id))ruleHandles.set(id,runtime.acquire(feed,{mode:'latest',demand:'durable'}));}
    },
    peek(refs:import('../../shared/data-sources').DataFeedRef[]){
      if(refs.length>16)throw Error('Too many Take inputs');
      return refs.map(ref=>{const feed=catalog.get(key(refSchema.parse(ref)));return !closed&&!suspended&&feed?runtime.peek(feed):null;});
    },
    dispatch(method: string, args: unknown[], clientId: string): DataFeedInfo[] | DataLease | DataLease[] | DataLeaseRead[] | null {
      if (closed) throw Error('Data sources stopping');
      z.uuid().parse(clientId); expire();
      if (method === 'dataSources:list' && args.length === 0) return [...catalog.values()].map(feed => ({
        sourceId: feed.sourceId, feedId: feed.feedId, configVersion: feed.configVersion, schemaVersion: feed.schemaVersion, kind: feed.kind, unit: feed.unit,
      }));
      if (method === 'dataSources:drop-client' && args.length === 0) { dropClient(clientId); return null; }
      if (args.length !== 1) throw Error('Invalid data source request');
      if (method === 'dataSources:acquire') {
        if (suspended) throw Error('Data sources suspended');
        const ref = refSchema.parse(args[0]), feed = catalog.get(key(ref));
        if (!feed) throw Error('Data feed unavailable');
        if (leases.size >= MAX_LEASES) throw Error('Data lease capacity reached');
        const handle = runtime.acquire(feed, { mode: 'latest', demand: 'ui' });
        const id = randomUUID(), lease = { clientId, handle, expiresAt: now() + TTL, feed: key(ref) };
        leases.set(id, lease); timer ??= setInterval(expire, 1000);
        return receipt(id, lease);
      }
      const ids = idsSchema.parse(args[0]);
      if (method === 'dataSources:release') { for (const id of ids) if (owned(clientId, id)) remove(id); return null; }
      if (method === 'dataSources:renew') {
        if (suspended) return [];
        return ids.flatMap(id => { const lease = owned(clientId, id); if (!lease) return [];
          lease.expiresAt = now() + TTL; return [receipt(id, lease)]; });
      }
      if (method === 'dataSources:read') {
        if (ids.some(id => owned(clientId, id))) {
          const previous = lastRead.get(clientId);
          if (previous !== undefined && now() - previous < 250) throw Error('Data read rate limited');
          lastRead.set(clientId, now());
        }
        const result = ids.map(leaseId => ({ leaseId, snapshot: owned(clientId, leaseId)?.handle.read() ?? null }));
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw Error('Data snapshot capacity reached');
        return result;
      }
      throw Error('Unknown data source method');
    },
    /** Apply a new catalog in place: only feeds whose definition changed or vanished stop; others keep running. */
    update(next: readonly FeedDefinition[], durable: readonly FeedDefinition[] = []) {
      if (closed) throw Error('Data sources stopping');
      const replacement = build(next, durable);
      const kept = (id: string) => { const before = catalog.get(id), after = replacement.get(id); return !!before && !!after && isDeepStrictEqual(before, after); };
      for (const [id, lease] of [...leases]) if (!kept(lease.feed)) remove(id);
      for (const [id, item] of [...eventHandles]) if (!kept(key(JSON.parse(item.identity)[1]))) { item.handle.release(); eventHandles.delete(id); }
      for (const [id, handle] of [...ruleHandles]) if (!kept(id)) { handle.release(); ruleHandles.delete(id); }
      const wanted = new Set(durable.map(feed => key(feed)));
      for (const [id, handle] of [...durableHandles]) if (!kept(id) || !wanted.has(id)) { handle.release(); durableHandles.delete(id); }
      catalog = replacement;
      runtime.prune(feed => { const current = catalog.get(key(feed)); return !!current && isDeepStrictEqual(current, feed); });
      for (const id of wanted) if (!durableHandles.has(id)) durableHandles.set(id, runtime.acquire(catalog.get(id)!, {mode:'latest',demand:'durable'}));
    },
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      for (const id of leases.keys()) remove(id);
      runtime.suspend();
    },
    resume() { if (!closed && suspended) { suspended = false; expire(); runtime.resume(); } },
    close() {
      if (closed) return;
      closed = true; for (const id of leases.keys()) remove(id);
      runtime.close(); eventHandles.clear();ruleHandles.clear();durableHandles.clear(); lastRead.clear();
    },
  };
}
