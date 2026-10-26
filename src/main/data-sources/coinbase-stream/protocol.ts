import {coinbasePriceMappingSchema,defaultCoinbasePriceMappings,readMappedField,type CoinbasePriceMappings} from '../../../shared/coinbase-field-mappings';
import { z } from 'zod';

const decimal = z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const positive = decimal.refine(value => /[1-9]/.test(value));
const timestamp = z.string().max(40).datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const product = z.string().max(81).regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/);
const envelope = z.object({ channel: z.string().max(64), sequence_num: z.number().int().nonnegative().safe(), timestamp, events: z.array(z.unknown()).max(1000) });
const bookEvent = z.object({ type: z.enum(['snapshot', 'update']), product_id: product, updates: z.array(z.object({
  side: z.enum(['bid', 'offer']), price_level: positive, new_quantity: decimal, event_time: timestamp,
})).max(100_000) });
const tradeSchema = z.object({ trade_id: z.string().min(1).max(128), product_id: product, price: positive, size: positive, side: z.enum(['BUY', 'SELL']), time: timestamp });
const tradeEvent = z.object({ type: z.enum(['snapshot', 'update']), trades: z.array(tradeSchema).max(10_000) });
const heartbeatEvent = z.object({ heartbeat_counter: z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d{1,30}$/)]), current_time: z.string().min(1).max(100) });
export type StreamTrade = z.infer<typeof tradeSchema> & { origin: 'live' | 'backfill' };
export type StreamIssue = 'invalid_data' | 'gap' | 'capacity' | 'transport';
export class StreamProtocolError extends Error {
  constructor(readonly issue: StreamIssue) { super(`Coinbase stream ${issue}`); }
}
export interface BookView {
  product: string; observedAt: string;
  bids: Array<{ price: string; size: string; cumulativeSize: string }>;
  asks: Array<{ price: string; size: string; cumulativeSize: string }>;
}
type Book = { bids: Map<string, string>; asks: Map<string, string>; observedAt: string; bytes: number; bestBid?: string; bestAsk?: string };
export const streamLimits = { products: 5, frameBytes: 16 * 1024 * 1024, levels: 50_000, stateBytes: 64 * 1024 * 1024, trades: 100 };
function canonical(value: string): string { return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value; }
function parts(value: string) { const [whole, fraction = ''] = value.split('.'); return { digits: BigInt(whole + fraction), scale: fraction.length }; }
function compare(a: string, b: string): number {
  const [aw, af = ''] = a.split('.'), [bw, bf = ''] = b.split('.');
  if (aw.length !== bw.length) return aw.length < bw.length ? -1 : 1;
  if (aw !== bw) return aw < bw ? -1 : 1;
  const width = Math.max(af.length, bf.length), left = af.padEnd(width, '0'), right = bf.padEnd(width, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}
const levelBytes = (price: string, size: string) => 256 + 2 * (price.length + size.length);
function best(side: Map<string, string>, bid: boolean): string | undefined {
  let result: string | undefined;
  for (const price of side.keys()) if (result === undefined || (bid ? compare(price, result) > 0 : compare(price, result) < 0)) result = price;
  return result;
}
function add(a: string, b: string): string {
  const left = parts(a), right = parts(b), scale = Math.max(left.scale, right.scale);
  const digits = (left.digits * 10n ** BigInt(scale - left.scale) + right.digits * 10n ** BigInt(scale - right.scale)).toString().padStart(scale + 1, '0');
  return canonical(scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
/** One decoder per socket epoch. Connection-global sequence policy is under proof;
 * this module is not registered in the production host until that gate closes.
 * A rejected frame poisons the epoch: no subsequent delta can repair it. */
export function createCoinbaseProtocol(products: readonly string[], overrides: Partial<typeof streamLimits> = {}, bookProducts: readonly string[] = products, rawMapping:CoinbasePriceMappings=defaultCoinbasePriceMappings) {
  const mapping=coinbasePriceMappingSchema.parse(rawMapping);
  const limits = { ...streamLimits, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid stream limit');
  function validate(products: readonly string[], bookProducts: readonly string[]) {
    const allowed = new Set(products.map(value => product.parse(value)));
    if (!allowed.size || allowed.size !== products.length || allowed.size > limits.products) throw Error('Invalid stream products');
    // Coinbase aliases most USDC products to USD. Never relabel their data.
    if (products.some(value => value.endsWith('-USDC') && !['USDT-USDC', 'EURC-USDC'].includes(value))) throw Error('Aliased Coinbase product unsupported');
    const allowedBooks = new Set(bookProducts);
    if (bookProducts.some(id=>!allowed.has(id)) || allowedBooks.size > 5) throw Error('Invalid book products');
    return { allowed, allowedBooks };
  }
  let { allowed, allowedBooks } = validate(products, bookProducts);
  // Products dropped this epoch: in-flight frames before the unsubscribe lands are skipped, not rejected.
  const retired = new Set<string>(), retiredBooks = new Set<string>(), awaitingSnapshot = new Set<string>();
  const subscribed = new Set<string>();
  const books = new Map<string, Book>(), trades = new Map<string, StreamTrade[]>();
  let sequence: number | undefined, poisoned = false, bookBytes = 0;
  const reject = (issue: StreamIssue): never => { poisoned = true; books.clear(); trades.clear(); bookBytes = 0; throw new StreamProtocolError(issue); };
  function requireProduct(id: string) { if (!allowed.has(id)) reject('invalid_data'); }
  function capacity() {
    let bytes = bookBytes;
    for (const list of trades.values()) bytes += list.length * 1024;
    if (bytes > limits.stateBytes) reject('capacity');
  }
  function accept(raw: string) {
    if (poisoned) throw new StreamProtocolError('gap');
    if (Buffer.byteLength(raw, 'utf8') > limits.frameBytes) reject('capacity');
    try {
      const message = envelope.parse(JSON.parse(raw));
      // Includes acknowledgments and heartbeats; never compare per-product counters.
      if (sequence !== undefined && message.sequence_num !== sequence + 1) reject('gap');
      sequence = message.sequence_num;
      const changed = new Set<string>(); let heartbeat = false;
      if (message.channel === 'l2_data') {
        for (const rawEvent of message.events) {
          const event = bookEvent.parse(rawEvent);
          if (!allowedBooks.has(event.product_id) && (retiredBooks.has(event.product_id) || retired.has(event.product_id))) continue;
          requireProduct(event.product_id); if(!allowedBooks.has(event.product_id))reject('invalid_data');
          // A re-added book ignores stale deltas from its previous subscription until the new snapshot.
          if (event.type === 'update' && awaitingSnapshot.has(event.product_id) && !books.has(event.product_id)) continue;
          if (event.type === 'snapshot') awaitingSnapshot.delete(event.product_id);
          let book = books.get(event.product_id);
          if (event.type === 'snapshot') { bookBytes -= book?.bytes ?? 0; book = { bids: new Map(), asks: new Map(), observedAt: message.timestamp, bytes: 0 }; books.set(event.product_id, book); }
          if (!book) reject('gap');
          let scanBid = false, scanAsk = false;
          for (const update of event.updates) {
            const side = update.side === 'bid' ? book!.bids : book!.asks;
            const price = canonical(update.price_level), size = canonical(update.new_quantity);
            const previous = side.get(price);
            const difference = (size === '0' ? 0 : levelBytes(price, size)) - (previous === undefined ? 0 : levelBytes(price, previous));
            book!.bytes += difference; bookBytes += difference;
            if (size === '0') {
              side.delete(price);
              if (update.side === 'bid' && book!.bestBid === price) scanBid = true;
              if (update.side === 'offer' && book!.bestAsk === price) scanAsk = true;
            } else {
              side.set(price, size);
              if (update.side === 'bid' && (book!.bestBid === undefined || compare(price, book!.bestBid) > 0)) book!.bestBid = price;
              if (update.side === 'offer' && (book!.bestAsk === undefined || compare(price, book!.bestAsk) < 0)) book!.bestAsk = price;
            }
            if (bookBytes > limits.stateBytes) reject('capacity');
            if (book!.bids.size + book!.asks.size > limits.levels) reject('capacity');
          }
          if (scanBid) book!.bestBid = best(book!.bids, true);
          if (scanAsk) book!.bestAsk = best(book!.asks, false);
          const { bestBid, bestAsk } = book!;
          if (bestBid !== undefined && bestAsk !== undefined && compare(bestBid, bestAsk) >= 0) reject('invalid_data');
          book!.observedAt = message.timestamp; changed.add(event.product_id);
        }
      } else if (message.channel === 'market_trades') {
        for (const rawEvent of message.events) {
          const event = tradeEvent.extend({trades:z.array(z.record(z.string(),z.unknown())).max(10000)}).parse(rawEvent);
          for (const raw of event.trades) {
            const trade=tradeSchema.parse({...raw,product_id:readMappedField(raw,mapping.product),price:readMappedField(raw,mapping.price),time:readMappedField(raw,mapping.time)});
            if (!allowed.has(trade.product_id) && retired.has(trade.product_id)) continue;
            requireProduct(trade.product_id);
            const list = trades.get(trade.product_id) ?? [];
            // Snapshot rows remain backfill even if repeated in a later update.
            if (list.some(item => item.trade_id === trade.trade_id)) continue;
            list.push({ ...trade, origin: event.type === 'snapshot' ? 'backfill' : 'live' });
            list.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || b.time.localeCompare(a.time) || b.trade_id.localeCompare(a.trade_id));
            list.length = Math.min(list.length, limits.trades); trades.set(trade.product_id, list);changed.add(trade.product_id);
          }
        }
      } else if (message.channel === 'subscriptions') {
        for (const event of message.events) {
          const ack=z.object({subscriptions:z.record(z.string(),z.array(z.string()))}).parse(event);
          for(const id of ack.subscriptions.market_trades??[])if(allowed.has(id))subscribed.add(id);
        }
      } else if (message.channel === 'heartbeats') {
        if (message.events.length !== 1) reject('invalid_data');
        heartbeatEvent.parse(message.events[0]); heartbeat = true;
      } // Unknown channels still consume their connection sequence, but publish nothing.
      capacity(); return { changed: [...changed], heartbeat };
    } catch (error) {
      if (error instanceof StreamProtocolError) throw error;
      return reject('invalid_data');
    }
  }
  return {
    accept,
    subscribed(id: string) { return subscribed.has(id); },
    hasBook(id: string) { return books.has(id); },
    book(id: string): BookView | null {
      requireProduct(id); const book = books.get(id); if (!book) return null;
      function view(side: Map<string, string>, descending: boolean) {
        let cumulativeSize = '0';
        return [...side].sort(([a], [b]) => descending ? compare(b, a) : compare(a, b)).slice(0, 20).map(([price, size]) => {
          cumulativeSize = add(cumulativeSize, size); return { price, size, cumulativeSize };
        });
      }
      return { product: id, observedAt: book.observedAt, bids: view(book.bids, true), asks: view(book.asks, false) };
    },
    latestLiveTrade(id:string):StreamTrade|null {requireProduct(id);const trade=trades.get(id)?.find(item=>item.origin==='live');return trade?{...trade}:null;},
    trades(id: string): StreamTrade[] { requireProduct(id); return structuredClone(trades.get(id) ?? []); },
    /** Change demand within one connection epoch; state for dropped products is discarded. */
    setProducts(nextProducts: readonly string[], nextBooks: readonly string[]) {
      const next = validate(nextProducts, nextBooks);
      for (const id of allowed) if (!next.allowed.has(id)) { retired.add(id); subscribed.delete(id); trades.delete(id); }
      for (const id of allowedBooks) if (!next.allowedBooks.has(id)) { retiredBooks.add(id); bookBytes -= books.get(id)?.bytes ?? 0; books.delete(id); }
      for (const id of next.allowedBooks) if (!allowedBooks.has(id) && (retiredBooks.has(id) || retired.has(id))) awaitingSnapshot.add(id);
      for (const id of next.allowed) retired.delete(id);
      for (const id of next.allowedBooks) retiredBooks.delete(id);
      allowed = next.allowed; allowedBooks = next.allowedBooks;
    },
    reset() { subscribed.clear(); books.clear(); trades.clear(); sequence = undefined; poisoned = false; bookBytes = 0; retired.clear(); retiredBooks.clear(); awaitingSnapshot.clear(); },
  };
}
