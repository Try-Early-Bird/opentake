// Shared subscription/contribution preflight.
type StrategyAllocationWeight = { symbol: string; instrumentRef?: string; weightPercent: number };

import { decimalToScaledInteger, scaledIntegerToDecimal } from "../allocations/decimal";
import { minimumAllocationFor, MINIMUM_ORDER_NOTIONAL_USD } from "./limits";
/** What the provider said about each symbol (the fields preflight reads). */
export interface InstrumentPolicy { symbols?: Record<string, { tradable: boolean; fractional: boolean }> }

// The account-specific preflight a subscription or contribution must pass
// before money moves.
// It is deterministic and local: a fresh model, capability per symbol from
// what the provider has already told us, the follower's own target per leg
// against the minimum order, and the cash actually available. The provider's
// exact, non-executing review stays where it belongs, immediately before each
// leg is confirmed, because a review creates an order intent meant to be
// confirmed; running fifty of them to answer "would this work" would leave
// fifty intents behind.
// The rule that matters: when a required holding cannot be bought for this
// follower, the whole transaction is blocked. The product promises complete
// replication, so quietly buying a subset is not an option.

export type PreflightReasonCode =
  | "fresh_position_snapshot_required"
  | "crypto_sizing_evidence_required"
  | "sizing_unavailable"
  | "incomplete_basket"
  | "model_stale"
  | "no_targets"
  | "symbol_not_tradable"
  | "symbol_not_fractional"
  | "symbol_blocked"
  | "leg_below_minimum"
  | "insufficient_cash"
  | "exceeds_account_value";

export interface PreflightReason {
  code: PreflightReasonCode;
  /** Symbols the reason is about, when it is about symbols. */
  symbols: string[];
  /** What the member needs, when the reason is about an amount. */
  needed?: string;
}

export interface PreflightLeg {
  symbol: string;
  /** Exact sizing identity when supplied; symbol remains display text. */
  instrumentRef?: string;
  weightPercent: number;
  /** Dollars this follower would buy of that holding. */
  notionalUsd: string;
}

export interface PreflightResult {
  orderReserveUsd?:string;
  existingCashUsed?:string;
  ok: boolean;
  reasons: PreflightReason[];
  legs: PreflightLeg[];
  /** Cash the snapshot intends to keep rather than invest. */
  retainedCashUsd: string;
  /** Smallest amount at which every leg clears the minimum order. */
  minimumAllocationUsd: string;
}

export interface PreflightInput {
  /** What the member is putting in. */
  amountUsd: string;
  /**
   * What the bucket already holds, per symbol, in dollars. Absent for a first
   * investment, which buys the whole basket; present for money added to an
   * existing one, which only buys each holding up to its share of the larger
   * bucket. A deposit never sells, so a holding already above its share is
   * simply not bought.
   */
  currentValuesUsd?: Readonly<Record<string, string>>;
  /** Weights new money buys: the model's current exposure once valued, else the published snapshot. */
  weights: readonly StrategyAllocationWeight[];
  /** Percent of the snapshot deliberately held as cash. */
  cashPercent: number;
  /** The day the model was valued, and the day it must have reached; null when no valuation is expected yet. */
  modelValuedOn: string | null;
  expectedValuedOn: string | null;
  /** What the provider said about each symbol, from the published snapshot's record. */
  instrumentPolicy: InstrumentPolicy | null;
  /** Cash available to this bucket after other strategies, when known. */
  availableCashUsd?: string | null;
  /**
   * What the account is worth less what its other buckets already claim.
   * Activation refuses an allocation past it, so the preview says so first.
   */
  accountRoomUsd?: string | null;
  minimumOrderNotionalUsd?: string;
  /** Tickers the member has blocked (trading/preferences.ts). */
  blockedSymbols?: readonly string[];
}

const CENTS = 10n ** 16n;

/** Dollars and cents, the precision an order is actually placed in. */
function usd(value: bigint): string {
  const positive = value < 0n ? 0n : value;
  return scaledIntegerToDecimal(positive - positive % CENTS);
}

/** Whole dollars, rounded up: what a member has to type to clear a floor. */
function wholeDollarsUp(value: bigint): string {
  const scale = 10n ** 18n;
  return scaledIntegerToDecimal(((value + scale - 1n) / scale) * scale);
}

/**
 * Checks one subscription or contribution end to end and returns every reason
 * it cannot proceed, not just the first: a member fixing an amount should not
 * discover a second problem afterwards.
 */
export function preflightSubscription(input: PreflightInput): PreflightResult {
  const reasons: PreflightReason[] = [];
  const minimumOrder = decimalToScaledInteger(input.minimumOrderNotionalUsd ?? MINIMUM_ORDER_NOTIONAL_USD);
  const amount = decimalToScaledInteger(input.amountUsd);
  const targets = input.weights.filter((weight) => weight.weightPercent > 0);
  const minimumAllocationUsd = minimumAllocationFor(targets, {
    ...(input.minimumOrderNotionalUsd === undefined ? {} : { minimumOrderNotionalUsd: input.minimumOrderNotionalUsd }),
  });

  // Requested notionals conserve the member's capital exactly: the
  // snapshot's weights and its cash percent already sum to 100, so each leg
  // is its weight of the whole amount and the legs sum to the amount less the
  // cash kept back. Sizing legs against "amount minus cash" would hold the
  // reserve twice.
  const retained = amount * BigInt(Math.round(input.cashPercent * 100)) / 10_000n;
  const held = input.currentValuesUsd;
  // Money added to an existing bucket buys each holding up to its share of
  // the larger bucket, so a bucket already on the model's weights is topped up
  // in proportion and its weights do not move, while one that has drifted is
  // brought back toward the model without selling anything.
  const bucketValue = held === undefined
    ? 0n
    : Object.values(held).reduce((total, value) => total + decimalToScaledInteger(value), 0n);
  const enlarged = bucketValue + amount;
  const legs: PreflightLeg[] = targets.flatMap((weight) => {
    const bps = BigInt(Math.round(weight.weightPercent * 100));
    if (held === undefined) {
      return [{
        symbol: weight.symbol,
        ...(weight.instrumentRef ? {instrumentRef:weight.instrumentRef} : {}),
        weightPercent: weight.weightPercent,
        notionalUsd: usd(amount * bps / 10_000n),
      }];
    }
    const target = enlarged * bps / 10_000n;
    const current = decimalToScaledInteger(held[weight.instrumentRef ?? weight.symbol] ?? "0");
    const delta = target - current;
    return delta <= 0n
      ? []
      : [{ symbol: weight.symbol, ...(weight.instrumentRef ? {instrumentRef:weight.instrumentRef} : {}), weightPercent: weight.weightPercent, notionalUsd: usd(delta) }];
  });

  if (targets.length === 0) reasons.push({ code: "no_targets", symbols: [] });

  // A model that has not been valued through the day it should have is not a
  // basis for spending money.
  if (input.expectedValuedOn !== null && (input.modelValuedOn === null || input.modelValuedOn < input.expectedValuedOn)) {
    reasons.push({ code: "model_stale", symbols: [] });
  }

  const policy = input.instrumentPolicy;
  if (policy !== null) {
    const notTradable: string[] = [];
    const notFractional: string[] = [];
    for (const leg of legs) {
      const verdict = policy.symbols?.[leg.instrumentRef ?? leg.symbol];
      if (verdict === undefined) continue;
      if (!verdict.tradable) notTradable.push(leg.symbol);
      else if (!verdict.fractional) notFractional.push(leg.symbol);
    }
    if (notTradable.length > 0) reasons.push({ code: "symbol_not_tradable", symbols: notTradable.sort() });
    if (notFractional.length > 0) reasons.push({ code: "symbol_not_fractional", symbols: notFractional.sort() });
  }

  // A strategy holding a ticker the member blocked is not followed at all:
  // the product copies whole baskets, and they said never to buy this one.
  // Judged on every target, not only the legs this amount buys, so a deposit
  // into a bucket already over its share of the ticker is refused as well.
  if (input.blockedSymbols !== undefined && input.blockedSymbols.length > 0) {
    const blocked = new Set(input.blockedSymbols.map((symbol) => symbol.toUpperCase()));
    const named = targets.map((weight) => weight.symbol).filter((symbol) => blocked.has(symbol.toUpperCase())).sort();
    if (named.length > 0) reasons.push({ code: "symbol_blocked", symbols: named });
  }

  // Blocked, never trimmed: a leg under the provider's minimum means this
  // amount cannot buy the whole basket. Money added to an existing bucket is
  // judged the same way, because a share too small to order is not bought at
  // all and the cash would simply sit there; what differs is the amount that
  // would fix it, which is measured against the enlarged bucket.
  const tooSmall = legs
    .filter((leg) => decimalToScaledInteger(leg.notionalUsd) < minimumOrder)
    .map((leg) => leg.symbol)
    .sort();
  if (tooSmall.length > 0) {
    reasons.push({
      code: "leg_below_minimum",
      symbols: tooSmall,
      needed: held === undefined ? minimumAllocationUsd : wholeDollarsUp(contributionFloor(targets, minimumOrder)),
    });
  }

  if (input.availableCashUsd !== undefined && input.availableCashUsd !== null) {
    const available = decimalToScaledInteger(input.availableCashUsd);
    if (available < amount) {
      reasons.push({ code: "insufficient_cash", symbols: [], needed: usd(amount) });
    }
  }
  // The account-value cap activation applies, said here rather than after
  // the button: `needed` is the most that could be invested, which is what
  // the member wants to know.
  if (input.accountRoomUsd !== undefined && input.accountRoomUsd !== null) {
    const room = decimalToScaledInteger(input.accountRoomUsd);
    if (room < amount) {
      reasons.push({ code: "exceeds_account_value", symbols: [], needed: usd(room) });
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    legs,
    retainedCashUsd: usd(retained),
    minimumAllocationUsd,
  };
}

/**
 * Smallest addition at which every holding's share of the larger bucket
 * clears the provider's minimum. For weight `w` and a bucket worth `V`, the
 * addition `A` must satisfy `w × (V + A) − current ≥ minimum` for the
 * tightest holding; with a bucket already on the model's weights that reduces
 * to `minimum / smallest weight`.
 */
function contributionFloor(
  targets: readonly StrategyAllocationWeight[],
  minimumOrder: bigint,
): bigint {
  let floor = 0n;
  for (const weight of targets) {
    const bps = BigInt(Math.round(weight.weightPercent * 100));
    if (bps === 0n) continue;
    // A = (minimum + current − w×V) / w, and current is at most w×V for a
    // holding that needs buying, so the bound below is the one that binds.
    const needed = (minimumOrder * 10_000n) / bps;
    if (needed > floor) floor = needed;
  }
  return floor;
}
