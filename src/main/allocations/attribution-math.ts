import {
  decimalToScaledInteger,
  multiplyDecimals,
  scaledIntegerToDecimal,
} from "./decimal";

const MAX_NUMERIC = 10n ** 38n - 1n;

export interface RobinhoodAttributionAmounts {
  quantityDelta: string;
  cashDelta: string;
  feeCashDelta: string | null;
}

function signedDecimal(value: bigint): string {
  if (value === 0n) return "0";
  if (value > MAX_NUMERIC || value < -MAX_NUMERIC) {
    throw new Error("Robinhood attribution amount exceeds database precision");
  }
  const absolute = value < 0n ? -value : value;
  const normalized = scaledIntegerToDecimal(absolute);
  return value < 0n ? `-${normalized}` : normalized;
}

export function deriveRobinhoodAttributionAmounts(input: {
  assetClass: "equity" | "option";
  side: string | null;
  quantity: string;
  price: string;
  notionalAmount: string | null;
  feeAmount: string | null;
}): RobinhoodAttributionAmounts | null {
  if (input.assetClass !== "equity") return null;
  if (input.side !== "buy" && input.side !== "sell") return null;

  const quantity = decimalToScaledInteger(input.quantity);
  const gross = decimalToScaledInteger(
    input.notionalAmount ?? multiplyDecimals(input.quantity, input.price),
  );
  const fee = input.feeAmount === null
    ? 0n
    : decimalToScaledInteger(input.feeAmount.replace(/^-/, ""));
  if (quantity === 0n || gross === 0n) return null;

  return {
    quantityDelta: signedDecimal(input.side === "buy" ? quantity : -quantity),
    cashDelta: signedDecimal(input.side === "buy" ? -gross : gross),
    feeCashDelta: fee === 0n ? null : signedDecimal(-fee),
  };
}

/**
 * How reinvested dividend shares divide among the allocations that held the
 * symbol. The dividend was paid on every share in the
 * account, so each allocation's share of the reinvestment is its share of the
 * position when the dividend was paid; whatever the member held outright
 * takes the rest and is not recorded, since their own shares are their own.
 * Split in millionths of a share, the provider's precision, with the odd
 * millionths going to the claims rounded down the most, so the parts sum to
 * the allocations' whole share.
 */
export function splitReinvestedShares(input: {
  /** Shares the reinvestment bought. */
  quantity: string;
  claims: ReadonlyArray<{ allocationId: string; attributedQuantity: string }>;
  /** Complete account holdings at entitlement; absence must defer attribution. */
  heldQuantity: string;
}): Array<{ allocationId: string; quantity: string }> {
  const MICRO = 10n ** 12n; // one millionth of a share, in 1e18 fixed point
  const total = decimalToScaledInteger(input.quantity) / MICRO;
  const claims = input.claims
    .map((claim) => ({ allocationId: claim.allocationId, units: decimalToScaledInteger(claim.attributedQuantity) / MICRO }))
    .filter((claim) => claim.units > 0n)
    .sort((left, right) => (right.units === left.units ? left.allocationId.localeCompare(right.allocationId) : (right.units > left.units ? 1 : -1)));
  const claimed = claims.reduce((sum, claim) => sum + claim.units, 0n);
  if (total <= 0n || claimed <= 0n) return [];
  const heldUnits = decimalToScaledInteger(input.heldQuantity) / MICRO;
  if (heldUnits < claimed) throw new Error("Entitlement holdings do not cover allocation claims");
  const denominator = heldUnits;
  const parts = claims.map((claim) => ({ allocationId: claim.allocationId, units: total * claim.units / denominator, remainder: (total * claim.units) % denominator }));
  // The allocations' whole share of the reinvestment, then the odd millionths.
  let placed = parts.reduce((sum, part) => sum + part.units, 0n);
  const allocationsShare = total * claimed / denominator;
  for (const part of [...parts].sort((left, right) => (right.remainder > left.remainder ? 1 : right.remainder < left.remainder ? -1 : 0))) {
    if (placed >= allocationsShare) break;
    part.units += 1n;
    placed += 1n;
  }
  return parts
    .filter((part) => part.units > 0n)
    .map((part) => ({ allocationId: part.allocationId, quantity: scaledIntegerToDecimal(part.units * MICRO) }));
}
