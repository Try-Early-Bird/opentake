import { z } from 'zod';
import contracts from './read-contracts.json';
import { metadataHash } from '../mcp-metadata';
import type { ReadTool } from '../opentake-mcp/catalog';
import { CoinbaseError } from './errors';
const product = z.string().regex(/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/);
const productIds = z.array(product).min(1).max(20);
const page = { limit: z.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(2048).optional() };
const history = { ...page, product_ids: product.optional(), side: z.enum(['BUY','SELL']).optional(), start: z.iso.datetime().optional(), end: z.iso.datetime().optional() };
const read = (name: string, description: string, schema: z.ZodType): ReadTool => ({ platform: 'coinbase', name, upstream: name, description, schema, account: true });
export const coinbaseReadTools = [
  read('coinbase_portfolios_get', 'Read balances and positions for the Coinbase portfolio identified by accountRef. Never trades.', z.object({}).strict()),
  read('coinbase_orders_list', 'Read one bounded page of orders for the Coinbase portfolio identified by accountRef. Check the returned cursor for more; never places orders.', z.object({ ...history, status: z.enum(['OPEN','FILLED','CANCELLED','EXPIRED','FAILED','PENDING']).optional() }).strict()),
  read('coinbase_orders_fills', 'Read one bounded page of fills and fees for the Coinbase portfolio identified by accountRef. Coverage may be partial.', z.object({ ...history, order_ids: z.array(z.uuid()).min(1).max(20).optional() }).strict()),
  read('coinbase_products_list', 'List a page of Coinbase spot markets. Market availability does not establish trading eligibility.', z.object({ ...page, symbol: z.string().regex(/^[A-Z0-9]{1,20}$/).optional() }).strict()),
  read('coinbase_products_get', 'Read Coinbase market details, rules and indicative price for an exact pair such as BTC-USD.', z.object({ product_id: product }).strict()),
  read('coinbase_products_best_bid_ask', 'Read Coinbase best bid and ask for up to 20 exact market pairs.', z.object({ product_ids: productIds }).strict()),
  read('coinbase_products_ticker', 'Read Coinbase recent trades and current bid/ask for an exact pair.', z.object({ product_id: product, limit: z.number().int().min(1).max(100).default(10) }).strict()),
  read('coinbase_products_book', 'Read bounded Coinbase order-book depth for an exact pair.', z.object({ product_id: product, limit: z.number().int().min(1).max(50).default(20) }).strict()),
  read('coinbase_products_candles', 'Read up to 350 Coinbase OHLCV candles for an exact pair. Missing intervals do not imply zero prices.', z.object({ product_id: product, start: z.iso.datetime().optional(), end: z.iso.datetime().optional(), granularity: z.enum(['1m','5m','15m','30m','1h','2h','4h','6h','1d']).default('1h'), limit: z.number().int().min(1).max(350).default(100) }).strict()),
];
export type CoinbaseChatRead = keyof typeof contracts;
export function checkedCoinbaseArgs(name: string, args: unknown, portfolio: string) {
  const tool = coinbaseReadTools.find(t => t.name === name);
  if (!tool) throw new CoinbaseError('contract');
  const parsed = tool.schema.parse(args) as Record<string, unknown>;
  if (typeof parsed.start === 'string' && typeof parsed.end === 'string' && parsed.start >= parsed.end) throw new CoinbaseError('contract');
  return { ...parsed, ...(['coinbase_portfolios_get','coinbase_orders_list','coinbase_orders_fills'].includes(name) ? { portfolio_id: portfolio } : {}),
    ...(['coinbase_products_list','coinbase_orders_list'].includes(name) ? { product_type: 'SPOT' } : {}) };
}
// Snapshot from bundled CLI 0.0.10 tools/list, without making account requests.
export function assertCoinbaseReadContract(name: string, tool: { inputSchema: unknown; outputSchema?: unknown; annotations?: unknown } | undefined) {
  const expected = contracts[name as CoinbaseChatRead];
  if (!expected || !tool || metadataHash({inputSchema:tool.inputSchema,outputSchema:tool.outputSchema ?? null,annotations:tool.annotations}) !== metadataHash(expected)) throw new CoinbaseError('contract');
}

/** Missing provider collections are failures, never inferred empty balances/history. */
export function checkCoinbaseReadResult(name: string, data: unknown, args: Record<string, unknown>) {
  const object = z.record(z.string(), z.unknown()).safeParse(data);
  if (!object.success) throw new CoinbaseError('provider');
  const value = object.data;
  const collections: Record<string, string> = { coinbase_orders_list: 'orders', coinbase_orders_fills: 'fills', coinbase_products_list: 'products', coinbase_products_best_bid_ask: 'pricebooks', coinbase_products_ticker: 'trades', coinbase_products_candles: 'candles' };
  const collection = collections[name];
  if (collection && !Array.isArray(value[collection])) throw new CoinbaseError('provider');
  const productId = args.product_id;
  if (name === 'coinbase_products_get' && (value.product_id !== productId || (value.product_type !== undefined && value.product_type !== 'SPOT'))) throw new CoinbaseError('provider');
  if (name === 'coinbase_products_book' && (value.pricebook as { product_id?: unknown } | undefined)?.product_id !== productId) throw new CoinbaseError('provider');
  if (name === 'coinbase_products_ticker' && (value.trades as { product_id?: unknown }[]).some(trade => !trade || trade.product_id !== productId)) throw new CoinbaseError('provider');
  if (name === 'coinbase_products_best_bid_ask' && (value.pricebooks as { product_id?: unknown }[]).some(book => !book || !(args.product_ids as unknown[]).includes(book.product_id))) throw new CoinbaseError('provider');
  if (name === 'coinbase_products_list' && (value.products as { product_type?: unknown }[]).some(product => !product || (product.product_type !== undefined && product.product_type !== 'SPOT'))) throw new CoinbaseError('provider');
}
