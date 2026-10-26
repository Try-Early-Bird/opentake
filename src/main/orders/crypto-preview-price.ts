import { cryptoDecimal } from './crypto-preview-contract';
import { decimalToScaledInteger as units } from '../allocations/decimal';

/** Carries only validated prices, never a raw provider response. */
export class CryptoPreviewPriceMismatch extends Error {
  readonly requested: string;
  readonly limit: string | null;
  readonly price: string | null;
  constructor(requested: string, limit: string | null | undefined, price: string | null | undefined) {
    super('Crypto preview limit mismatch');
    this.requested = cryptoDecimal.parse(requested);
    this.limit = cryptoDecimal.nullish().parse(limit) ?? null;
    this.price = cryptoDecimal.nullish().parse(price) ?? null;
  }
  publicMessage() {
    return `Robinhood’s preview could not verify your $${this.requested} limit. Returned limit_price: ${this.limit === null ? 'missing' : '$' + this.limit}; price: ${this.price === null ? 'missing' : '$' + this.price}. The preview was refused.`;
  }
}

/** For limit orders the captured provider contract defines price as the limit.
 * Both fields are optional. Require at least one and reject conflicting values;
 * entered_price is pre-collaring input, so cannot establish execution terms. */
export function verifyCryptoPreviewLimit(requested: string, order: {
  type: string; limit_price?: string | null; price?: string | null;
}) {
  const prices = [order.limit_price, order.price].filter((value): value is string => value != null);
  if (order.type !== 'limit' || !prices.length || prices.some(value => units(value) !== units(requested))) {
    throw new CryptoPreviewPriceMismatch(requested, order.limit_price, order.price);
  }
}
