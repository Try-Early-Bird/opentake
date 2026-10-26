import { afterEach, expect, test, vi } from 'vitest';
import { createCoinbaseProtocol, StreamProtocolError } from '../../../src/main/data-sources/coinbase-stream/protocol';
import { coinbaseStreamUrl, openCoinbaseStreamSession, type PublicStreamTransport } from '../../../src/main/data-sources/coinbase-stream/session';
const time = '2026-10-17T12:00:00.000Z';
const frame = (sequence_num: number, channel: string, events: unknown[]) => JSON.stringify({ channel, sequence_num, timestamp: time, events });
const level = (side: string, price_level: string, new_quantity: string) => ({ side, price_level, new_quantity, event_time: time });
const book = (type = 'snapshot', updates = [level('bid', '100', '1'), level('offer', '101', '2')], product_id = 'BTC-USD') => ({ type, product_id, updates });
const trade = (trade_id: string, overrides = {}) => ({ trade_id, product_id: 'BTC-USD', price: '100', size: '0.1', side: 'BUY', time, ...overrides });
const heartbeat = (seq: number) => frame(seq, 'heartbeats', [{ heartbeat_counter: String(seq), current_time: time }]);
afterEach(() => vi.useRealTimers());

test('exact decimal books replace quantities, canonicalize levels, retain deeper levels and expose bounded copies', () => {
  const parser = createCoinbaseProtocol(['BTC-USD']);
  const bids = Array.from({ length: 25 }, (_, i) => level('bid', String(100 - i), '0.1'));
  parser.accept(frame(0, 'l2_data', [book('snapshot', [...bids, level('offer', '101', '0.2')])]));
  expect(parser.book('BTC-USD')!.bids).toHaveLength(20);
  expect(parser.book('BTC-USD')!.bids[19].cumulativeSize).toBe('2');
  parser.accept(frame(1, 'l2_data', [book('update', [level('bid', '100.00', '0'), level('bid', '99.0', '0.3')])]));
  const view = parser.book('BTC-USD')!;
  expect(view.bids[0]).toEqual({ price: '99', size: '0.3', cumulativeSize: '0.3' });
  expect(view.bids[19].price).toBe('80');
  view.bids[0].size = '999'; expect(parser.book('BTC-USD')!.bids[0].size).toBe('0.3');
  const precise = createCoinbaseProtocol(['BTC-USD']);
  precise.accept(frame(0, 'l2_data', [book('snapshot', [level('bid', '9007199254740992.00000001', '0.00000001'), level('offer', '9007199254740992.00000002', '0.1')])]));
  expect(precise.book('BTC-USD')!.bids[0].price).toBe('9007199254740992.00000001');
});

test('connection sequence includes other products, acknowledgments and heartbeats; failure poisons all state', () => {
  const parser = createCoinbaseProtocol(['BTC-USD', 'ETH-USD']);
  parser.accept(frame(0, 'subscriptions', []));
  parser.accept(frame(1, 'l2_data', [book()]));
  parser.accept(heartbeat(2));
  parser.accept(frame(3, 'l2_data', [book('snapshot', undefined, 'ETH-USD')]));
  parser.accept(frame(4, 'l2_data', [book('update', [level('bid', '100', '2')])]));
  expect(parser.book('BTC-USD')!.bids[0].size).toBe('2');
  expect(() => parser.accept(heartbeat(6))).toThrow('gap');
  expect(parser.book('BTC-USD')).toBeNull(); expect(parser.book('ETH-USD')).toBeNull();
  expect(() => parser.accept(frame(7, 'l2_data', [book()]))).toThrow('gap');
  parser.reset(); parser.accept(frame(0, 'l2_data', [book()])); expect(parser.book('BTC-USD')).not.toBeNull();
});

test.each(['duplicate', 'old', 'update-first', 'crossed', 'malformed', 'wrong-product', 'oversized', 'levels', 'memory'])('%s fails closed without partial state', kind => {
  const parser = createCoinbaseProtocol(['BTC-USD'], kind === 'levels' ? { levels: 1 } : kind === 'memory' ? { stateBytes: 1 } : kind === 'oversized' ? { frameBytes: 10 } : {});
  let input = frame(0, 'l2_data', [book()]);
  if (kind === 'duplicate' || kind === 'old') { parser.accept(frame(10, 'l2_data', [book()])); input = frame(kind === 'duplicate' ? 10 : 9, 'l2_data', [book()]); }
  if (kind === 'update-first') input = frame(0, 'l2_data', [book('update')]);
  if (kind === 'crossed') input = frame(0, 'l2_data', [book('snapshot', [level('bid', '102', '1'), level('offer', '101', '2')])]);
  if (kind === 'malformed') input = frame(0, 'l2_data', [book(), { type: 'update' }]);
  if (kind === 'wrong-product') input = frame(0, 'l2_data', [book('snapshot', undefined, 'ETH-USD')]);
  expect(() => parser.accept(input)).toThrow(StreamProtocolError); expect(parser.book('BTC-USD')).toBeNull();
});

test('trades are bounded, deduplicated, copied and keep backfill origin and maker side', () => {
  const parser = createCoinbaseProtocol(['BTC-USD'], { trades: 2 });
  parser.accept(frame(0, 'market_trades', [{ type: 'snapshot', trades: [trade('1')] }]));
  parser.accept(frame(1, 'market_trades', [{ type: 'update', trades: [trade('1'), trade('2', { side: 'SELL' })] }]));
  expect(parser.trades('BTC-USD').find(t => t.trade_id === '1')?.origin).toBe('backfill');
  expect(parser.trades('BTC-USD')[0]).toMatchObject({ trade_id: '2', side: 'SELL', origin: 'live' });
  parser.accept(frame(2, 'market_trades', [{ type: 'update', trades: [trade('3')] }]));
  expect(parser.trades('BTC-USD').map(t => t.trade_id)).toEqual(['3', '2']);
  const copy = parser.trades('BTC-USD'); copy[0].price = '999'; expect(parser.trades('BTC-USD')[0].price).toBe('100');
});

test('products reject aliases, duplicates and unsupported identities', () => {
  for (const products of [[], ['BTC-USDC'], ['BTC-USD', 'BTC-USD'], ['../bad']]) expect(() => createCoinbaseProtocol(products)).toThrow();
  expect(() => createCoinbaseProtocol(['USDT-USDC', 'EURC-USDC'])).not.toThrow();
});

function fixture() {
  vi.useFakeTimers();
  let callbacks!: Parameters<PublicStreamTransport['connect']>[1];
  const send = vi.fn(), close = vi.fn(), changed = vi.fn(), failure = vi.fn(), controller = new AbortController();
  const connect = vi.fn((_request, handlers) => { callbacks = handlers; return { send, close }; });
  const session = openCoinbaseStreamSession({ products: ['BTC-USD'], transport: { connect }, signal: controller.signal, onChange: changed, onFailure: failure, monotonic: Date.now });
  return { session, callbacks, send, close, changed, failure, controller, connect };
}

test('one bounded public session paces subscriptions, coalesces views and fences callbacks after abort', async () => {
  const f = fixture();
  expect(f.connect).toHaveBeenCalledWith({ url: coinbaseStreamUrl, maxFrameBytes: 16 * 1024 * 1024 }, expect.any(Object));
  f.callbacks.open(); await vi.advanceTimersByTimeAsync(1);
  expect(f.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.send.mock.calls.map(([text]) => JSON.parse(text))).toEqual([
    { type: 'subscribe', channel: 'heartbeats' },
    { type: 'subscribe', channel: 'level2', product_ids: ['BTC-USD'] },
    { type: 'subscribe', channel: 'market_trades', product_ids: ['BTC-USD'] },
  ]);
  f.callbacks.message(frame(0, 'l2_data', [book()]));
  f.callbacks.message(frame(1, 'l2_data', [book('update', [level('bid', '100', '3')])]));
  expect(f.changed).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(250);
  expect(f.changed).toHaveBeenCalledTimes(1); expect(f.session.book('BTC-USD')!.bids[0].size).toBe('3');
  f.controller.abort(); f.callbacks.message(frame(2, 'l2_data', [book()])); f.callbacks.close();
  expect(f.session.book('BTC-USD')).toBeNull(); expect(f.failure).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

test('missing open, heartbeat and first snapshot terminate the epoch with no timers left', async () => {
  const unopened = fixture(); await vi.advanceTimersByTimeAsync(10_000); expect(unopened.failure).toHaveBeenCalledWith('transport');
  const silent = fixture(); silent.callbacks.open(); await vi.advanceTimersByTimeAsync(5500); expect(silent.failure).toHaveBeenCalledWith('transport');
  const empty = fixture(); empty.callbacks.open();
  for (let i = 0; i < 11; i++) { empty.callbacks.message(heartbeat(i)); await vi.advanceTimersByTimeAsync(1000); }
  expect(empty.failure).toHaveBeenCalledWith('gap'); expect(vi.getTimerCount()).toBe(0);
});

test('protocol failure closes the socket and rejects late data; a replacement epoch needs a new snapshot', async () => {
  const f = fixture(); f.callbacks.open(); f.callbacks.message(frame(0, 'l2_data', [book()]));
  f.callbacks.message(frame(2, 'l2_data', [book('update')]));
  expect(f.failure).toHaveBeenCalledExactlyOnceWith('gap'); expect(f.session.status()).toBe('closed');
  f.callbacks.message(frame(3, 'l2_data', [book()])); expect(f.session.book('BTC-USD')).toBeNull();
  const next = fixture(); next.callbacks.open(); next.callbacks.message(frame(0, 'l2_data', [book('update')]));
  expect(next.failure).toHaveBeenCalledExactlyOnceWith('gap'); expect(vi.getTimerCount()).toBe(0);
});

test('a 50,000-level synthetic snapshot fits the configured cap, and the next level invalidates it', () => {
  const parser = createCoinbaseProtocol(['BTC-USD']);
  const updates = Array.from({ length: 50_000 }, (_, i) => level(i < 25_000 ? 'bid' : 'offer', String(i + 1), '0.00000001'));
  const raw = frame(0, 'l2_data', [book('snapshot', updates)]);
  parser.accept(raw);
  const view = parser.book('BTC-USD')!;
  expect(view.bids[0].price).toBe('25000'); expect(view.asks[0].price).toBe('25001');
  expect(view.bids[19].cumulativeSize).toBe('0.0000002');
  expect(Buffer.byteLength(raw)).toBeLessThan(16 * 1024 * 1024);
  expect(() => parser.accept(frame(1, 'l2_data', [book('update', [level('offer', '50001', '1')])]))).toThrow('capacity');
  expect(parser.book('BTC-USD')).toBeNull();
});

test('an already aborted session never opens a transport', () => {
  const controller = new AbortController(); controller.abort(); const connect = vi.fn();
  const session = openCoinbaseStreamSession({ products: ['BTC-USD'], signal: controller.signal, transport: { connect }, onChange: vi.fn(), onFailure: vi.fn() });
  expect(connect).not.toHaveBeenCalled(); expect(session.status()).toBe('closed');
});


test('unknown channels consume connection sequence without modifying book timestamps', () => {
  const parser = createCoinbaseProtocol(['BTC-USD']);
  parser.accept(frame(0, 'l2_data', [book()]));
  const before = parser.book('BTC-USD');
  parser.accept(frame(1, 'future_channel', [])); parser.accept(heartbeat(2));
  expect(parser.book('BTC-USD')).toEqual(before);
  parser.accept(frame(3, 'l2_data', [book('update', [level('bid', '100', '3')])]));
  expect(parser.book('BTC-USD')!.bids[0].size).toBe('3');
});


test('observed public numeric heartbeat counters are accepted, malformed counters are rejected', () => {
  const parser = createCoinbaseProtocol(['BTC-USD']);
  expect(parser.accept(frame(0, 'heartbeats', [{ heartbeat_counter: 223382, current_time: '2026-10-18 21:58:13 +0000 UTC' }])).heartbeat).toBe(true);
  expect(() => parser.accept(frame(1, 'heartbeats', [{ heartbeat_counter: -1, current_time: time }]))).toThrow('invalid_data');
});

test('incremental best-price and byte accounting survive deletion, replacement and new snapshots', () => {
  const parser = createCoinbaseProtocol(['BTC-USD'], { stateBytes: 1100 });
  parser.accept(frame(0, 'l2_data', [book('snapshot', [level('bid', '99', '1'), level('bid', '100', '1'), level('offer', '101', '1'), level('offer', '102', '1')])]));
  parser.accept(frame(1, 'l2_data', [book('update', [level('bid', '100', '0'), level('offer', '101', '0'), level('bid', '98', '1'), level('offer', '103', '1')])]));
  expect(parser.book('BTC-USD')!.bids[0].price).toBe('99'); expect(parser.book('BTC-USD')!.asks[0].price).toBe('102');
  parser.accept(frame(2, 'l2_data', [book()]));
  parser.accept(frame(3, 'l2_data', [book('update', [level('bid', '100', '0'), level('offer', '101', '0')])]));
  expect(parser.book('BTC-USD')!.bids).toEqual([]); expect(parser.book('BTC-USD')!.asks).toEqual([]);
  parser.accept(frame(4, 'l2_data', [book('update', [level('bid', '200', '1'), level('offer', '201', '1')])]));
  expect(parser.book('BTC-USD')!.bids[0].price).toBe('200');
  expect(() => parser.accept(frame(5, 'l2_data', [book('update', [level('offer', '199', '1')])]))).toThrow('invalid_data');
});

test('incremental book results match a simple reference across many price replacements and deletions', () => {
  const parser = createCoinbaseProtocol(['BTC-USD']);
  const expected = new Map<string, string>(); parser.accept(frame(0, 'l2_data', [book('snapshot', [level('offer', '1000', '1')])]));
  for (let i = 1; i <= 200; i++) {
    const price = String(1 + i * 17 % 40), size = i % 3 === 0 ? '0' : String(1 + i % 9);
    if (size === '0') expected.delete(price); else expected.set(price, size);
    parser.accept(frame(i, 'l2_data', [book('update', [level('bid', price, size)])]));
    expect(parser.book('BTC-USD')!.bids.map(({price, size}) => [price, size])).toEqual([...expected].sort(([a], [b]) => Number(b) - Number(a)).slice(0, 20));
  }
});
