import { decimalToScaledInteger, scaledIntegerToDecimal } from "./decimal";

// The arithmetic and the refusal for a member's own orders, kept apart from
// the database so the API's error handling can name the error without
// loading the driver. The reasoning is in self-directed.ts.

export type SelfDirectedRefusal =
  | "sell_reaches_strategy_shares"
  | "buy_reaches_strategy_cash"
  | "lot_belongs_to_strategy"
  | "self_directed_unmeasured";

export class SelfDirectedOrderError extends Error {
  constructor(message: string, readonly code: SelfDirectedRefusal) {
    super(message);
  }
}

export function signed(value: string): bigint {
  const trimmed = value.trim();
  return trimmed.startsWith("-") ? -decimalToScaledInteger(trimmed.slice(1)) : decimalToScaledInteger(trimmed);
}

export function plain(value: bigint): string {
  return scaledIntegerToDecimal(value < 0n ? 0n : value);
}

export function cents(value: bigint): string {
  const positive = value < 0n ? 0n : value;
  const unit = 10n ** 16n;
  return (Number(positive / unit) / 100).toFixed(2);
}

/** Shares the member may sell themselves: what the account holds less what the strategies claim. */
export function ownShares(held: string, claimed: string): string {
  return plain(signed(held) - signed(claimed));
}

/** Cash the member may spend themselves: the account's cash less what the strategies hold. */
export function ownCash(cash: string, reserved: string): string {
  return plain(signed(cash) - signed(reserved));
}

