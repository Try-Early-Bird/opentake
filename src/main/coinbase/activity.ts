import { z } from 'zod';
import { coinbaseGet } from './rest';
import { CoinbaseError } from './errors';
import type { CoinbaseKey } from './key';
import { divideDecimals, multiplyDecimals, normalizeDecimal } from '../allocations/decimal';

const ref = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const amount = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,36})?$/).max(80);
const positive = amount.refine(value => /[1-9]/.test(value));
const time = z.iso.datetime({ offset: true });
const product = z.string().regex(/^[A-Z0-9._]{1,40}-[A-Z0-9._]{1,40}$/);
const orderSchema = z.object({ order_id: ref, client_order_id: z.string().max(200).optional(), retail_portfolio_id: z.uuid(),
  product_id: product, product_type: z.literal('SPOT'), side: z.enum(['BUY', 'SELL']), status: z.string().min(1).max(80),
  created_time: time, filled_size: amount, total_fees: amount, order_type: z.string().max(80).optional(),
  time_in_force: z.string().max(80).optional(), order_configuration: z.record(z.string(), z.object({base_size:amount.optional(),quote_size:amount.optional()})).optional() });
const fillSchema = z.object({ entry_id: ref, trade_id: ref, order_id: ref, retail_portfolio_id: z.uuid(),
  product_id: product, side: z.enum(['BUY','SELL']), trade_type: z.literal('FILL'), trade_time: time, sequence_timestamp: time,
  size: positive, size_in_quote: z.boolean(), price: positive, commission: amount,
  commission_detail_total: z.object({ total_commission: amount }).optional() });
export const activityRequest = z.discriminatedUnion('resource', [
  z.object({resource:z.literal('spot_orders'), cursor:z.string().max(4096).optional(), since:time.optional(), until:time}),
  z.object({resource:z.literal('spot_fills'), cursor:z.string().max(4096).optional(), since:time.optional(), until:time}),
  z.object({resource:z.literal('order'), orderId:ref}),
]);
export type ActivityRequest = z.infer<typeof activityRequest>;
export type CoinbaseOrder = ReturnType<typeof normalizeOrder>;
export type CoinbaseFill = ReturnType<typeof normalizeFill>;
export interface ActivityPage { orders: CoinbaseOrder[]; fills: CoinbaseFill[]; cursor: string | null }
export type ActivityRead = (key:CoinbaseKey, portfolio:string, signal:AbortSignal, request:ActivityRequest)=>Promise<ActivityPage>;
const terminal = new Set(['filled','cancelled','canceled','expired','failed','rejected']);
function normalizeOrder(raw:unknown, portfolio:string) {
  const order=orderSchema.parse(raw);
  if(order.retail_portfolio_id!==portfolio)throw new CoinbaseError('scope');
  const [symbol,currency]=order.product_id.split('-');
  const configurations=Object.values(order.order_configuration??{});
  return {providerOrderRef:order.order_id,clientOrderRef:order.client_order_id??null,productId:order.product_id,
    instrumentRef:`coinbase:${symbol}`,symbol,currency,side:order.side.toLowerCase(),state:order.status.toLowerCase(),
    terminal:terminal.has(order.status.toLowerCase()),quantity:configurations.length===1?configurations[0].base_size??null:null,
    quoteQuantity:configurations.length===1?configurations[0].quote_size??null:null,
    filledQuantity:order.filled_size,feeAmount:order.total_fees,sourceCreatedAt:new Date(order.created_time).toISOString(),
    orderType:order.order_type??null,timeInForce:order.time_in_force??null,assetClass:'crypto' as const,origin:'unknown' as const};
}
function normalizeFill(raw:unknown, portfolio:string) {
  const fill=fillSchema.parse(raw);
  if(fill.retail_portfolio_id!==portfolio)throw new CoinbaseError('scope');
  const [symbol,currency]=fill.product_id.split('-');
  // Keep the provider's denomination as evidence. Quote-sized fills are not base units.
  const quantity=fill.size_in_quote?divideDecimals(fill.size,fill.price,36):normalizeDecimal(fill.size,36);
  const notionalAmount=fill.size_in_quote?normalizeDecimal(fill.size,36):multiplyDecimals(fill.size,fill.price,36);
  return {providerExecutionRef:fill.entry_id,tradeRef:fill.trade_id,orderRef:fill.order_id,productId:fill.product_id,
    instrumentRef:`coinbase:${symbol}`,symbol,currency,side:fill.side.toLowerCase(),quantity,price:fill.price,
    notionalAmount,feeAmount:fill.commission,feeCurrency:currency,commissionTotal:fill.commission_detail_total?.total_commission??null,
    sourceSize:fill.size,sizeInQuote:fill.size_in_quote,occurredAt:new Date(fill.trade_time).toISOString(),
    sequenceAt:new Date(fill.sequence_timestamp).toISOString(),assetClass:'crypto' as const,origin:'unknown' as const};
}
export function createCoinbaseActivityReader(fetcher:typeof fetch=fetch):ActivityRead {
  return async(key,portfolio,signal,input)=>{
    const args=activityRequest.parse(input),get=coinbaseGet(key,signal,fetcher);
    if(args.resource==='order') {
      const raw=z.object({order:z.unknown()}).parse(await get(`/api/v3/brokerage/orders/historical/${args.orderId}`));
      const order=normalizeOrder(raw.order,portfolio);
      if(order.providerOrderRef!==args.orderId)throw new CoinbaseError('scope');
      return {orders:[order],fills:[],cursor:null};
    }
    const query=new URLSearchParams({limit:'100',retail_portfolio_id:portfolio,...(args.cursor?{cursor:args.cursor}:{})});
    if(args.resource==='spot_orders') {
      query.set('product_type','SPOT');query.set('end_date',args.until);
      if(args.since)query.set('start_date',args.since);
      const page=z.object({orders:z.array(z.unknown()).max(100),has_next:z.boolean(),cursor:z.string().max(4096).optional()})
        .parse(await get('/api/v3/brokerage/orders/historical/batch',query));
      if(page.has_next&&!page.cursor)throw new CoinbaseError('provider');
      return {orders:page.orders.map(o=>normalizeOrder(o,portfolio)),fills:[],cursor:page.has_next?page.cursor!:null};
    }
    query.set('product_types','SPOT');query.set('end_sequence_timestamp',args.until);
    if(args.since)query.set('start_sequence_timestamp',args.since);
    const page=z.object({fills:z.array(z.unknown()).max(100),cursor:z.string().max(4096),proof_token_required:z.boolean().optional()})
      .parse(await get('/api/v3/brokerage/orders/historical/fills',query));
    if(page.proof_token_required)throw new CoinbaseError('permissions');
    return {orders:[],fills:page.fills.map(f=>normalizeFill(f,portfolio)),cursor:page.cursor||null};
  };
}
