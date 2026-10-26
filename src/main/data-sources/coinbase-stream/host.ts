import {coinbaseInputProduct} from '../input-feed';
import {coinbaseSourceId} from '../../../shared/coinbase-source';
import type {DataFeedRef,DataSnapshot} from '../../../shared/data-sources';
import {defaultCoinbasePriceMappings,type CoinbasePriceMappings} from '../../../shared/coinbase-field-mappings';
import {isDeepStrictEqual} from 'node:util';
import { defaultCoinbaseSubscriptions, type CoinbaseSubscriptions } from '../../../shared/coinbase-source';
import { freshCoinbaseTrade } from '../../../shared/coinbase-live-price';
import { createWebsocketMessages } from '../websocket/messages';
import type { WebsocketMessages } from '../../../shared/websocket-sources';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DataLease } from '../../../shared/data-sources';
import type { CoinbaseStreamRead, CoinbaseStreamInspection } from '../../../shared/coinbase-stream';
import type { AdapterContext, SourceAdapter } from '../contracts';
import { createDataSourceRuntime } from '../runtime';
import { createCoinbaseProtocol } from './protocol';
import { openCoinbaseStreamSession, type PublicStreamTransport } from './session';
const ids = z.array(z.uuid()).max(32).refine(values => new Set(values).size === values.length);
const request = z.discriminatedUnion('action', [
  z.object({action:z.literal('reconnect')}).strict(),
  z.object({action:z.literal('inspect'),after:z.number().int().nonnegative().optional()}).strict(),
  z.object({ action: z.literal('messages'), leaseId: z.uuid(), after: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('acquire'), product: z.string().max(81), mode:z.enum(['prices','book']).optional(), usage:z.enum(['holdings','view','manual']).optional() }).strict(),
  ...(['read', 'renew', 'release'] as const).map(action => z.object({ action: z.literal(action), ids }).strict()),
]);
type Runtime = ReturnType<typeof createDataSourceRuntime>;
type Lease = { client: string; product: string; mode:'prices'|'book'; usage:'holdings'|'view'|'manual'|'rule'; expires: number };
/** One public connection per host, never per account. Runtime owns recovery and
 * retry escalation; leases own product demand. The volatile viewer exposes only
 * validated public frames and bounded omission notices. Transport is injected. */
export function createCoinbaseStreamHost(options: {
  transport?: PublicStreamTransport; monotonic?: () => number; wall?: () => number; random?: () => number;
} = {}) {
  let policy:{enabled:boolean;collection:'automatic'|'when-open'|'off';subscriptions:CoinbaseSubscriptions;priceMappings?:CoinbasePriceMappings}={priceMappings:defaultCoinbasePriceMappings,enabled:true,collection:'automatic' as 'automatic'|'when-open'|'off',subscriptions:structuredClone(defaultCoinbaseSubscriptions)};
  function allowed(usage:Lease['usage']){return policy.enabled&&policy.collection!=='off'&&(usage==='view'?policy.subscriptions.views:policy.collection==='automatic'&&(usage==='rule'||usage==='manual'||policy.subscriptions.holdings));}
  const now = options.monotonic ?? (() => performance.now()), wall = options.wall ?? Date.now;
  let holdingAccounts: Array<{product:string;account:string}>=[];
  const journal = createWebsocketMessages(), messageReads = new Map<string, number>();
  const ruleClient=randomUUID();let streamEpoch=0,sourceRevision=1;
  const leases = new Map<string, Lease>(), reads = new Map<string, number>();
  let runtime: Runtime | undefined, handle: ReturnType<Runtime['acquire']> | undefined;
  let context: AdapterContext | undefined, session: ReturnType<typeof openCoinbaseStreamSession> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, closed = false, suspended = false;
  const watchers = new Set<() => void>();
  function notify() { for (const watcher of [...watchers]) try { watcher(); } catch { /* Watchers never affect the stream. */ } }
  const products = () => [...new Set([...leases.values()].map(lease => lease.product))].sort();
  const books = () => [...new Set([...leases.values()].filter(lease=>lease.mode==='book').map(lease=>lease.product))].sort();
  const demand = () => [...products().map(id=>'price:'+id),...books().map(id=>'book:'+id)];
  const receipt = (leaseId: string, lease: Lease): DataLease => ({ leaseId, expiresInMs: Math.max(0, lease.expires - now()), renewAfterMs: 10_000 });
  function stop() {
    journal.clear(); messageReads.clear();
    runtime?.close(); runtime = undefined; handle = undefined; context = undefined; session = undefined;
    if (timer) clearInterval(timer); timer = undefined;
  }
  function changed(before: string[]) {
    if (!leases.size) { stop(); reads.clear(); return; }
    // Product-set edits are incremental subscribe/unsubscribe on the live socket, never a failure or backoff.
    // Without a session, the next open (or pending retry) reads the newest desired products.
    if (JSON.stringify(before) !== JSON.stringify(demand())) { try { session?.update(products(), books()); } catch { context?.fail('gap', { retryAfterMs: 1000 }); } }
  }
  function remove(leaseId: string) {
    const before = demand(), lease = leases.get(leaseId); leases.delete(leaseId);
    if (lease && ![...leases.values()].some(item => item.client === lease.client)) { reads.delete(lease.client); messageReads.delete(lease.client); }
    changed(before);
  }
  function expire() { for (const [id, lease] of leases) if (lease.expires <= now()) remove(id); }
  function start() {
    if (runtime) return;
    const adapter: SourceAdapter = {
      id: 'coinbase-public-stream', version: '1', kinds: ['boolean'], transport: 'websocket', history: false, replay: false, heartbeatTimeoutMs: 5000,
      open(ctx) {
        context = ctx;streamEpoch++;
        const publish = () => {
          if (ctx.signal.aborted || session?.status() !== 'ready') return;
          ctx.connected();
          // This observation means connection readiness, never quote freshness.
          ctx.emit({ payload: { kind: 'boolean', value: true }, eventTime: wall(), origin: 'live' });
        };
        const current = openCoinbaseStreamSession({ priceMappings:policy.priceMappings,products: products(), bookProducts: books(), transport: options.transport!, signal: ctx.signal, monotonic: now, wall,
          onOpen() { journal.add('coinbase', 1, 'open', 'Connected · subscribing to public market data'); },
          onMessage(text) {
            const bytes = Buffer.byteLength(text);
            journal.add('coinbase', 1, bytes <= 64 * 1024 ? 'json' : 'notice', bytes <= 64 * 1024 ? text : `Public frame: ${bytes} bytes · omitted from viewer (64 KiB limit); processed by the stream`);
          },
          onChange() { publish(); notify(); }, onHeartbeat() { ctx.heartbeat(); publish(); }, onTrade: notify,
          onFailure(issue) { journal.add('coinbase', 1, 'close', `Connection interrupted: ${issue}`); ctx.fail(issue === 'invalid_data' ? 'invalid_data' : issue === 'transport' ? 'transport' : 'gap', { retryAfterMs: 1000 }); },
        });
        session = current;
        const dispose = () => { current.close(); if (session === current) session = undefined; if (context === ctx) context = undefined; };
        return dispose;
      },
    };
    runtime = createDataSourceRuntime([adapter], { clock: { wall, monotonic: now }, random: options.random, limits: { feeds: 1, sockets: 1 } });
    handle = runtime.acquire({ ownerId: 'local-host', sourceId: 'coinbase-public', configVersion: 1, adapterId: adapter.id,
      authScope: 'public', feedId: 'connection', schemaVersion: 1, parameters: {}, kind: 'boolean', unit: 'connection-ready',
      semantics: 'state', ordering: 'arrival', freshnessMs: 15_000, pollIntervalMs: 60_000 }, { mode: 'latest', demand: 'ui' });
    timer = setInterval(expire, 1000);
  }
  function acquire(product:string,mode:'prices'|'book',usage:Lease['usage'],client:string):DataLease{
        if(!allowed(usage)||(usage==='manual'&&!policy.subscriptions.products.includes(product)))throw Error('Collection disabled for this demand');
        if (!options.transport) throw Error('Coinbase streaming is not activated');
        if (suspended) throw Error('Coinbase stream suspended');
        createCoinbaseProtocol([product]); // Exact product and alias validation before I/O.
        if (leases.size >= 256) throw Error('Coinbase stream lease capacity reached');
        const before = demand();
        if (!products().includes(product) && products().length >= 100) throw Error('Coinbase stream product capacity reached');
        if(mode==='book'&&!books().includes(product)&&books().length>=5)throw Error('Coinbase order-book capacity reached');
        const id = randomUUID(), lease:Lease = { client, product: product, mode:mode, usage:usage, expires: now() + 30_000 };
        leases.set(id, lease); changed(before); start(); return receipt(id, lease);
  }
  return {
    ruleDemand(raw:string[]){
      const wanted=new Set(z.array(z.string()).max(100).parse(raw));
      for(const product of wanted)createCoinbaseProtocol([product]);
      expire();
      for(const [id,lease] of leases)if(lease.client===ruleClient&&(!wanted.has(lease.product)||!allowed('rule')||suspended||closed))remove(id);
      if(closed||suspended||!allowed('rule'))return;
      for(const product of wanted){
        const existing=[...leases.values()].find(lease=>lease.client===ruleClient&&lease.product===product);
        if(existing)existing.expires=now()+30000;
        else try{acquire(product,'prices','rule',ruleClient);}catch{/* Capacity or unavailable transport: inputs remain missing. */}
      }
    },
    inputSnapshot(ref:DataFeedRef):DataSnapshot|null{
      const product=coinbaseInputProduct(ref.feedId);
      if(ref.sourceId!==coinbaseSourceId||ref.configVersion!==sourceRevision||ref.schemaVersion!==1||!product||closed||suspended||!allowed('rule'))return null;
      const state=handle?.read(),sample=session?.latestLiveObservation(product);
      const live=state?.connection==='live'&&session?.status()==='ready';
      if(!live||!sample)return {connection:state?.connection??'idle',quality:state?.issue==='gap'?'gap':'missing',latest:null,issue:state?.issue??null,lastReceivedAt:null};
      const eventTime=Date.parse(sample.trade.time),receivedAt=sample.receivedAt,time=wall();
      return {connection:'live',quality:eventTime>time||receivedAt>time?'invalid':time-eventTime>15000||time-receivedAt>15000?'stale':'fresh',issue:null,lastReceivedAt:receivedAt,
        latest:{...ref,adapterId:'coinbase-public-stream',adapterVersion:'1',epoch:streamEpoch,unit:'USD',eventTime,receivedAt,timeBasis:'provider',clockSkewMs:Math.max(0,eventTime-receivedAt),origin:'live',providerId:sample.trade.trade_id,
          market:{venue:'coinbase',product,base:product.slice(0,-4),quote:'USD'},payload:{kind:'metric',value:sample.trade.price}}};
    },
    /** Subscribe to readiness/trade changes for event-driven rule reads. */
    watch(listener: () => void) { watchers.add(listener); return () => { watchers.delete(listener); }; },
    dispatch(raw: unknown, client: string, trusted = false): DataLease | DataLease[] | CoinbaseStreamRead[] | WebsocketMessages | CoinbaseStreamInspection | null {
      if (closed) throw Error('Coinbase stream stopping');
      z.uuid().parse(client); const input = request.parse(raw); expire();
      // Renderer IPC may only open viewer leases; holdings/manual demand is host-owned (trusted callers only).
      if (input.action === 'acquire' && (input.usage ?? 'view') !== 'view' && !trusted) throw Error('Coinbase stream usage unavailable');
      if(input.action==='reconnect'){
        if(suspended)throw Error('Coinbase stream suspended');
        stop();if(leases.size)start();return null;
      }
      if(input.action==='inspect'){
        if(messageReads.has(client)&&now()-messageReads.get(client)!<250)throw Error('Coinbase message read rate limited');
        if(messageReads.size>=256&&!messageReads.has(client))messageReads.delete(messageReads.keys().next().value!);
        messageReads.set(client,now());
        return {connection:policy.enabled&&policy.collection!=='off'?(handle?.read().connection??'idle'):'paused', issue:handle?.read().issue??null, subscriptions:products().map(product=>({
          product,channels:['market_trades',...(books().includes(product)?['level2']:[])],
          accounts:[...new Set(holdingAccounts.filter(item=>item.product===product).map(item=>item.account))],
          lastTick:session?.trades(product).find(trade=>trade.origin==='live')?.time??null,
          uses:[...new Set([...leases.values()].filter(lease=>lease.product===product).map(lease=>lease.usage))],
          confirmed:session?.subscribed(product)===true && ( !books().includes(product)||session?.book(product)!==null ),
        })),messages:journal.read('coinbase',1,input.after)};
      }
      if (input.action === 'acquire') return acquire(input.product,input.mode??'prices',input.usage??'view',client);
      const owned = (id: string) => { const lease = leases.get(id); return lease?.client === client ? lease : undefined; };
      if (input.action === 'messages') {
        if (!owned(input.leaseId)) return { messages: [], cursor: 0, total: 0, startedAt: null };
        if (messageReads.has(client) && now() - messageReads.get(client)! < 250) throw Error('Coinbase message read rate limited');
        messageReads.set(client, now());
        return journal.read('coinbase', 1, input.after);
      }
      if (input.action === 'release') { for (const id of input.ids) if (owned(id)) remove(id); return null; }
      if (input.action === 'renew') return input.ids.flatMap(id => { const lease = owned(id); if (!lease || suspended) return []; lease.expires = now() + 30_000; return [receipt(id, lease)]; });
      if (input.ids.some(id => owned(id))) {
        if (reads.has(client) && now() - reads.get(client)! < 250) throw Error('Coinbase stream read rate limited');
        reads.set(client, now());
      }
      const state = handle?.read();
      const result: CoinbaseStreamRead[] = input.ids.map(leaseId => {
        const lease = owned(leaseId); if (!lease || !state) return { leaseId, snapshot: null };
        const live = state.connection === 'live' && session?.status() === 'ready';
        return { leaseId, snapshot: { product: lease.product, connection: state.connection, issue: state.issue,
          continuity: live ? 'live' as const : 'unavailable' as const,
          book: live ? session!.book(lease.product) : null, trades: live ? session!.trades(lease.product) : [],
        } };
      });
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw Error('Coinbase stream snapshot capacity reached');
      return result;
    },
    configure(next:{revision?:number;enabled:boolean;collection:'automatic'|'when-open'|'off';subscriptions:CoinbaseSubscriptions;priceMappings?:CoinbasePriceMappings}){
      const remap=!isDeepStrictEqual(policy.priceMappings??defaultCoinbasePriceMappings,next.priceMappings??defaultCoinbasePriceMappings);
      sourceRevision=next.revision??sourceRevision;policy=structuredClone(next);for(const [id,lease] of leases)if(!allowed(lease.usage)||(lease.usage==='manual'&&!policy.subscriptions.products.includes(lease.product)))remove(id);
      if(remap){stop();if(leases.size)start();}
    },
    setHoldingAccounts(items:Array<{product:string;account:string}>){holdingAccounts=items.slice(0,1000).map(item=>({product:item.product,account:item.account.slice(0,80)}));},
    quotes():import('../../coinbase/stream-price-store').StreamPrice[]{
      if(handle?.read().connection!=='live'||session?.status()!=='ready')return [];
      return products().flatMap(product=>{const trade=session!.latestLiveTrade(product);const price=freshCoinbaseTrade({product,connection:'live',continuity:'live',issue:null,book:null,trades:trade?[trade]:[]},product,wall());return price&&trade?[{product,price,eventTime:Date.parse(trade.time)}]:[];});
    },
    price(product: string): string | null {
      if (!products().includes(product) || handle?.read().connection !== 'live' || session?.status() !== 'ready') return null;
      return freshCoinbaseTrade({ product, connection: 'live', continuity: 'live', issue: null, book: null, trades: (()=>{const trade=session.latestLiveTrade(product);return trade?[trade]:[];})() }, product, wall());
    },
    dropClient(client: string) { messageReads.delete(client); for (const [id, lease] of leases) if (lease.client === client) remove(id); },
    suspend() { if (closed || suspended) return; suspended = true; leases.clear(); reads.clear(); stop(); },
    resume() { if (!closed) suspended = false; },
    close() { if (closed) return; closed = true; leases.clear(); reads.clear(); stop(); },
  };
}
