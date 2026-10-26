import type {CoinbasePriceMappings} from '../../../shared/coinbase-field-mappings';
import { createCoinbaseProtocol, StreamProtocolError, streamLimits, type StreamIssue } from './protocol';

export const coinbaseStreamUrl = 'wss://advanced-trade-ws.coinbase.com';
/** The transport must enforce maxFrameBytes before buffering/decoding. No auth
 * fields or arbitrary URLs: this session is exclusively Coinbase public data. */
export interface PublicStreamTransport {
  connect(request: { url: typeof coinbaseStreamUrl; maxFrameBytes: number }, callbacks: {
    open(): void; message(text: string): void; error(): void; close(): void;
  }): { send(text: string): void; close(): void };
}
/** One fixed-product socket epoch. The future host owner handles shared demand
 * and reconnect backoff by replacing the entire session. No automatic activation. */
export function openCoinbaseStreamSession(options: {
  priceMappings?:CoinbasePriceMappings;
  products: readonly string[];
  bookProducts?: readonly string[];
  transport: PublicStreamTransport;
  signal: AbortSignal;
  onChange(): void;
  onOpen?(): void;
  onMessage?(text: string): void;
  onHeartbeat?(): void;
  onFailure(issue: StreamIssue): void;
  /** Synchronous notice that a product's latest live trade changed. */
  onTrade?(products: string[]): void;
  /** Pacing between subscribe/unsubscribe commands; Coinbase allows several public messages per second. */
  commandIntervalMs?: number;
  monotonic?: () => number;
  wall?: () => number;
}) {
  const received=new Map<string,{trade:import('../../../shared/coinbase-stream').CoinbaseStreamTrade;receivedAt:number}>();
  let products = [...options.products];
  let bookProducts = [...(options.bookProducts ?? products)];
  const pace = options.commandIntervalMs ?? 250;
  // What the socket has been asked for; the pump converges it on the desired sets one command at a time.
  const sentTrades = new Set<string>(), sentBooks = new Set<string>();
  let heartbeatsSent = false, pumping = false;
  const protocol = createCoinbaseProtocol(products, {products:100}, bookProducts, options.priceMappings);
  const now = options.monotonic ?? (() => performance.now());
  let stopped = false, opened = false, healthy = false, dirty = false, heartbeatSeen = false;
  let heartbeatAt = now(), openedAt = now();
  let socket: ReturnType<PublicStreamTransport['connect']> | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(callback: () => void, delay: number) {
    const timer = setTimeout(() => { timers.delete(timer); if (!stopped) callback(); }, delay);
    timers.add(timer);
  }
  function stop() {
    if (stopped) return; stopped = true; healthy = false;
    for (const timer of timers) clearTimeout(timer); timers.clear();
    options.signal.removeEventListener('abort', stop);
    protocol.reset();received.clear();
    try { socket?.close(); } catch { /* No provider payloads in errors. */ }
  }
  function fail(issue: StreamIssue) { if (!stopped) { stop(); options.onFailure(issue); } }
  function publish() {
    if (dirty) { dirty = false; options.onChange(); }
    later(publish, 250);
  }
  function watch() {
    if (!opened || now() - heartbeatAt > 5000) return fail('transport');
    if (!healthy && now() - openedAt >= 10_000) return fail('gap');
    later(watch, 250);
  }
  function next(): {type:string;channel:string;product_ids?:string[]} | null {
    if (!heartbeatsSent) { heartbeatsSent = true; return {type:'subscribe',channel:'heartbeats'}; }
    const take = (set: Set<string>, wanted: readonly string[], add: boolean) => (add ? wanted.filter(id => !set.has(id)) : [...set].filter(id => !wanted.includes(id))).slice(0, 16);
    for (const [channel, set, wanted] of [['level2', sentBooks, bookProducts], ['market_trades', sentTrades, products]] as const) {
      const removed = take(set, wanted, false);
      if (removed.length) { for (const id of removed) set.delete(id); return {type:'unsubscribe',channel,product_ids:removed}; }
    }
    for (const [channel, set, wanted] of [['level2', sentBooks, bookProducts], ['market_trades', sentTrades, products]] as const) {
      const added = take(set, wanted, true);
      if (added.length) { for (const id of added) set.add(id); return {type:'subscribe',channel,product_ids:added}; }
    }
    return null;
  }
  /** Paced, coalescing: each send reads the newest desired sets, so rapid lease edits collapse. */
  function pump() {
    if (stopped || !opened || pumping) return;
    const command = next(); if (!command) return;
    try { socket!.send(JSON.stringify(command)); } catch { fail('transport'); return; }
    pumping = true; later(() => { pumping = false; pump(); }, pace);
  }
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  if (!stopped) {
    later(() => { if (!opened) fail('transport'); }, 10_000);
    try {
      socket = options.transport.connect({ url: coinbaseStreamUrl, maxFrameBytes: streamLimits.frameBytes }, {
        open() {
          if (stopped || opened) return;
          opened = true; openedAt = heartbeatAt = now();
          options.onOpen?.();
          // Defer to ensure a synchronous injected open callback has a socket.
          later(() => { pump(); later(watch, 250); later(publish, 250); }, 0);
        },
        message(text) {
          if (stopped) return;
          if (!opened || typeof text !== 'string') return fail('invalid_data');
          try {
            const result = protocol.accept(text);
            const traded:string[]=[];
            for(const product of result.changed){const trade=protocol.latestLiveTrade(product),previous=received.get(product);
              if(trade&&(!previous||Date.parse(trade.time)>Date.parse(previous.trade.time))){received.set(product,{trade,receivedAt:(options.wall??Date.now)()});traded.push(product);}
            }
            if(traded.length)try{options.onTrade?.(traded);}catch{/* Observers never affect the stream. */}
            options.onMessage?.(text);
            if (result.heartbeat) { heartbeatAt = now(); heartbeatSeen = true; }
            // Readiness latches per epoch: later product additions confirm individually via subscribed()/book().
            healthy ||= heartbeatSeen && bookProducts.every(id => protocol.hasBook(id)) && (bookProducts.length>0 || products.every(id=>protocol.subscribed(id)));
            if (result.heartbeat) options.onHeartbeat?.();
            if (!result.heartbeat) dirty = true;
          } catch (error) { fail(error instanceof StreamProtocolError ? error.issue : 'invalid_data'); }
        },
        error() { fail('transport'); },
        close() { fail('transport'); },
      });
      if (stopped) socket.close();
    } catch { fail('transport'); }
  }
  return {
    latestLiveObservation:(product:string)=>received.get(product)??null,
    subscribed: protocol.subscribed,
    book: protocol.book,
    trades: protocol.trades,
    latestLiveTrade:protocol.latestLiveTrade,
    status: () => stopped ? 'closed' as const : healthy ? 'ready' as const : 'connecting' as const,
    /** Incremental subscribe/unsubscribe on the open socket; never a reconnect or failure. */
    update(nextProducts: readonly string[], nextBooks: readonly string[]) {
      if (stopped) return;
      protocol.setProducts(nextProducts, nextBooks);
      products = [...nextProducts]; bookProducts = [...nextBooks];
      for (const id of [...received.keys()]) if (!products.includes(id)) received.delete(id);
      // Defer one turn so synchronous lease edits coalesce into one command per channel.
      if (opened && !pumping) { pumping = true; later(() => { pumping = false; pump(); }, 0); }
    },
    close: stop,
  };
}
