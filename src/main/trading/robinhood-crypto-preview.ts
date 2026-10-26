import { verifyCryptoPreviewLimit } from '../orders/crypto-preview-price';
import { z } from 'zod';
import { bindRobinhoodCryptoAccount } from '../robinhood-account-binding';
import { cryptoDecimal, cryptoEligibilityInput, cryptoPreviewInput } from '../orders/crypto-preview-contract';
import { decimalToScaledInteger as units } from '../allocations/decimal';
import { evaluateEligibility, type EligibilityCheck } from './eligibility';

export const cryptoPairSchema = z.object({ id: z.string().min(1).max(256), symbol: z.string().regex(/^[A-Z0-9._]+-USD$/).max(80),
  asset_currency: z.object({ code: z.string().min(1) }), quote_currency: z.object({ code: z.literal('USD') }),
  tradability: z.string(), tradability_by_account_type: z.record(z.string(), z.string()).optional(), display_only: z.boolean(),
  min_order_size: cryptoDecimal, max_order_size: cryptoDecimal, min_order_quantity_increment: cryptoDecimal,
  min_order_price_increment: cryptoDecimal, min_order_quote_amount: cryptoDecimal.nullable().optional(),
  market_orders_only: z.boolean(), halted: z.boolean(), halted_regions: z.array(z.string()).nullable().optional() });
type Read = (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
const pageSchema = z.object({ data: z.object({ results: z.array(z.unknown()).nullable(), next: z.string().optional() }) });
export async function cryptoReadPages(read: Read, name: string, args: Record<string, unknown>, signal: AbortSignal) {
  const rows: unknown[] = [], cursors = new Set<string>(); let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    signal.throwIfAborted();
    const page = pageSchema.parse(await read(name, { ...args, ...(cursor ? { cursor } : {}) }, signal));
    signal.throwIfAborted(); rows.push(...(page.data.results ?? []));
    if (rows.length > 14000) throw Error('Too many provider rows');
    cursor = page.data.next;
    if (!cursor) return rows;
    if (cursors.has(cursor)) throw Error('Repeated provider cursor');
    cursors.add(cursor);
  }
  throw Error('Too many provider pages');
}
/** Preview-only adapter. It has no placement/cancellation callback or cash mutation. */
export async function robinhoodCryptoPreview(read: Read, accounts: unknown, accountRef: string | undefined,
  raw: unknown, signal: AbortSignal, preview: boolean) {
  const input = preview ? cryptoPreviewInput.parse(raw) : cryptoEligibilityInput.parse(raw);
  const account = bindRobinhoodCryptoAccount(accounts, accountRef);
  const rows = await cryptoReadPages(read, 'get_currency_pairs', { limit: 700 }, signal);
  const matches = rows.filter(row => row && typeof row === 'object' && (row as { id?: unknown }).id === input.currency_pair_id);
  if (matches.length !== 1) throw Error('Crypto pair unavailable or ambiguous');
  const pair = cryptoPairSchema.parse(matches[0]);
  if (pair.symbol !== `${pair.asset_currency.code}-USD`) throw Error('Crypto pair currency mismatch');
  // Provider order inputs use a symbol, so reject an ambiguous symbol even with an exact locator.
  if (rows.filter(row => row && typeof row === 'object' && (row as { symbol?: unknown }).symbol === pair.symbol).length !== 1) throw Error('Crypto symbol ambiguous');
  const checks: EligibilityCheck[] = [];
  const details: { check: string; satisfied: boolean | null }[] = [];
  const check = (satisfied: boolean | null, label = 'Order size and increments') => { details.push({ check: label, satisfied }); checks.push({ code: 'product_restricted', symbols: [pair.symbol], satisfied }); };
  check(account.state === 'active' && !account.deactivated && !account.permanentlyDeactivated, 'Account active');
  check(!pair.display_only, 'Pair available for trading');
  const tradability = pair.tradability_by_account_type?.[account.brokerageAccountType] ?? pair.tradability;
  check(tradability === 'tradable' || tradability === `${input.side}_only` ? true
    : ['untradable', 'buy_only', 'sell_only'].includes(tradability) ? false : null, 'Selected account type permits this side');
  check(!pair.halted ? (pair.halted_regions?.length ? null : true) : pair.halted_regions?.includes('ALL') ? false : null, 'No applicable trading halt');
  const order = preview ? cryptoPreviewInput.parse(raw) : null;
  if (order) {
    check(order.type === 'market' || !pair.market_orders_only, 'Order type supported');
    if (order.limit_price) check(units(pair.min_order_price_increment) > 0n && units(order.limit_price) % units(pair.min_order_price_increment) === 0n);
    if (order.dollar_amount && pair.min_order_quote_amount != null) check(units(order.dollar_amount) >= units(pair.min_order_quote_amount));
  }
  const size = (quantity: string) => {
    const q = units(quantity), min = units(pair.min_order_size), max = units(pair.max_order_size), step = units(pair.min_order_quantity_increment);
    check(step > 0n && max >= min && q > 0n && q >= min && q <= max && q % step === 0n);
  };
  if (order?.quantity) size(order.quantity);
  let transferable: string | null = null;
  if (input.side === 'sell') {
    const positions = await cryptoReadPages(read, 'get_crypto_positions', { rhs_account_number: account.rhsAccountNumber }, signal);
    const held = positions.filter(row => row && typeof row === 'object' && (row as { currency_pair_id?: unknown }).currency_pair_id === pair.id);
    if (held.length > 1) throw Error('Ambiguous crypto position');
    // Empty holdings are known zero; a malformed matching row stays unknown.
    const available = held.length ? z.object({ quantity_transferable: cryptoDecimal }).safeParse(held[0]) : null;
    transferable = !held.length ? '0' : available?.success ? available.data.quantity_transferable : null;
    check(transferable === null ? null : units(transferable) > 0n, 'Sellable units available');
    if (order?.quantity) check(transferable === null ? null : units(order.quantity) <= units(transferable), 'Sell quantity within available units');
  }
  const base = { pairId: pair.id, symbol: pair.symbol, side: input.side, observedAt: new Date().toISOString(), executionEnabled: false,
    checks: details, scope: 'Account and pair checks only; no cash reservation or permission to execute.', quantityAvailable: transferable };
  const eligibility = evaluateEligibility(checks);
  if (!order || !eligibility.ok) return { ...base, eligibility, preview: null };
  const { currency_pair_id: _id, ...parameters } = order;
  const rawPreview = await read('preview_crypto_order', { ...parameters, symbol: pair.symbol, rhs_account_number: account.rhsAccountNumber }, signal);
  signal.throwIfAborted();
  // Strip provider guidance and transient IDs: neither is an executable approval.
  const response = z.object({ data: z.object({
    order: z.object({ currency_pair_id: z.string(), side: z.string(), type: z.string(), time_in_force: z.literal('gtc'), quantity: cryptoDecimal,
      limit_price: cryptoDecimal.nullish(), price: cryptoDecimal.nullish(), net_rounded_estimated_notional: cryptoDecimal.nullish(),
      tax_withholding: z.object({ withholding_rate: z.string().max(100).optional(), estimated_withholding_amount: cryptoDecimal.nullish() }).nullish() }),
    crypto_account_number: z.string().optional(),
    estimated_fee: cryptoDecimal, fee_rate: z.string().max(100).optional(), fee_context: z.string().max(300).optional(),
    customer_approval_required: z.boolean().nullish(), customer_approval_required_reason: z.string().max(100).optional(),
  }) }).parse(rawPreview).data;
  if (response.crypto_account_number && response.crypto_account_number !== account.cryptoAccountNumber) throw Error('Crypto preview account mismatch');
  const result = response.order;
  if (result.currency_pair_id !== pair.id || result.side !== order.side || result.type !== order.type) throw Error('Crypto preview identity mismatch');
  if (order.quantity && units(order.quantity) !== units(result.quantity)) throw Error('Crypto preview quantity mismatch');
  if (order.limit_price) verifyCryptoPreviewLimit(order.limit_price, result);
  if (!order.quantity) size(result.quantity);
  if (input.side === 'sell') check(transferable === null ? null : units(result.quantity) <= units(transferable), 'Preview sell quantity within available units');
  if (pair.min_order_quote_amount != null) {
    const price = order.limit_price ?? result.price;
    check(price ? units(result.quantity) * units(price) >= units(pair.min_order_quote_amount) * 10n ** 18n : null);
  }
  return { ...base, eligibility: evaluateEligibility(checks), preview: {
    quantity: result.quantity, estimatedTotal: result.net_rounded_estimated_notional ?? null, estimatedFee: response.estimated_fee,
    feeRate: response.fee_rate ?? null, feeContext: response.fee_context ?? null, taxWithholding: result.tax_withholding ?? null,
    approvalRequired: response.customer_approval_required ?? null, approvalReason: response.customer_approval_required_reason ?? null,
    currency: 'USD', type: order.type, limitPrice: order.limit_price ?? null, timeInForce: 'gtc',
    message: 'Preview only. No order or approval request was submitted. Totals already include fees and withholding. Execution is disabled.',
  } };
}
