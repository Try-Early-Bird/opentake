import { decimalToScaledInteger, scaledIntegerToDecimal } from "./decimal";

// Whether a sale made outside Earlybird reached shares a strategy owns
// (manual and external trades).
// A member's account holds one number of shares per symbol. Some of them are
// claimed by the strategies the member follows, and the rest are the member's
// own. A sale the member makes in the Robinhood app comes out of that single
// pool, so it only touches a strategy when the account ends up holding fewer
// shares than the strategies together claim. A sale covered by the member's
// own shares leaves every strategy whole, and pausing them for it would
// freeze someone's investments for trading stock they own outright.
// The account's share count after the sale is the newest complete position
// snapshot moved forward by every fill recorded since it was taken, the sale
// itself included. Without a complete snapshot there is nothing to measure
// against, and the answer is "cannot tell", which the caller treats as a
// shortfall: pausing wrongly is recoverable, and trading on a share count
// that is not there is not.

export interface AccountFill {
  side: string | null;
  quantity: string;
}

export type ExternalSaleVerdict =
  | {
      /** The account still holds at least what the strategies claim. */
      touchesStrategies: false;
      heldAfter: string;
      claimed: string;
    }
  | {
      touchesStrategies: true;
      /** Null when there was no complete snapshot to measure from. */
      heldAfter: string | null;
      claimed: string;
      /** Shares the strategies claim that the account no longer holds; null when unmeasured. */
      shortfall: string | null;
      /** Held minus claimed, negative for a shortfall: the sign the reconciliation case stores. */
      difference: string | null;
    };

function signed(value: string): bigint {
  const trimmed = value.trim();
  return trimmed.startsWith("-")
    ? -decimalToScaledInteger(trimmed.slice(1))
    : decimalToScaledInteger(trimmed);
}

function unsigned(value: bigint): string {
  return value < 0n ? `-${scaledIntegerToDecimal(-value)}` : scaledIntegerToDecimal(value);
}

/**
 * Compares what the account holds after an outside sale with what the
 * strategies claim. `snapshotQuantity` is the symbol's quantity in the newest
 * complete snapshot (zero when a complete snapshot does not list it), or null
 * when there is no complete snapshot at all. `fillsSince` are every fill of
 * the symbol in the account recorded after that snapshot, strategy and
 * outside alike, including the sale being judged.
 */
export function judgeExternalSale(input: {
  snapshotQuantity: string | null;
  fillsSince: readonly AccountFill[];
  claimedQuantities: readonly string[];
}): ExternalSaleVerdict {
  const claimed = input.claimedQuantities.reduce((total, quantity) => total + signed(quantity), 0n);
  // A fill whose direction is unknown could be either, so the count after it
  // is unknown too; that is the same "cannot tell" as a missing snapshot.
  if (input.snapshotQuantity === null || input.fillsSince.some((fill) => fill.side !== "buy" && fill.side !== "sell")) {
    return { touchesStrategies: true, heldAfter: null, claimed: unsigned(claimed), shortfall: null, difference: null };
  }
  let held = signed(input.snapshotQuantity);
  for (const fill of input.fillsSince) {
    const quantity = decimalToScaledInteger(fill.quantity);
    held += fill.side === "buy" ? quantity : -quantity;
  }
  if (held >= claimed) {
    return { touchesStrategies: false, heldAfter: unsigned(held), claimed: unsigned(claimed) };
  }
  return {
    touchesStrategies: true,
    heldAfter: unsigned(held),
    claimed: unsigned(claimed),
    shortfall: unsigned(claimed - held),
    difference: unsigned(held - claimed),
  };
}

// Which strategy an outside sale reached, when it reached more than one.
// The sale is one number; the strategies sharing the ticker each claim part
// of the account's shares. Robinhood's tax lots are the evidence: every
// strategy buy is tied to the lot it created, so the lots a sale consumed
// name the strategies it reached. That is only evidence for a strategy whose
// every buy of the symbol has a known lot; one with an unmatched buy could
// have lost shares the lots cannot show. When every strategy involved has
// that evidence and it shows a loss, the split follows the lots and is
// recorded without asking. Otherwise it is proposed in proportion to each
// strategy's claim, and the member may move it.

export interface LotEvidenceAllocation {
  allocationId: string;
  /** Shares the allocation claims of the symbol. */
  claimed: string;
  /** Lots the allocation's buys created. */
  lotIds: readonly string[];
  /** Whether any buy of the symbol has no known lot. */
  unmatchedBuys: boolean;
}

/**
 * Shares each allocation lost according to the lots still open: what it claims
 * minus what its own lots still hold, never below zero. Null for a allocation the
 * lots cannot speak for.
 */
export function lotLosses(
  allocations: readonly LotEvidenceAllocation[],
  liveLots: ReadonlyMap<string, string>,
): Map<string, string | null> {
  const losses = new Map<string, string | null>();
  for (const allocation of allocations) {
    if (allocation.unmatchedBuys || allocation.lotIds.length === 0) {
      losses.set(allocation.allocationId, null);
      continue;
    }
    const remaining = allocation.lotIds.reduce(
      (total, lotId) => total + signed(liveLots.get(lotId) ?? "0"),
      0n,
    );
    const claimed = signed(allocation.claimed);
    losses.set(allocation.allocationId, unsigned(claimed > remaining ? claimed - remaining : 0n));
  }
  return losses;
}

/**
 * Whether the lots speak for every strategy the sale reached and show a loss.
 * Only then is the split theirs to settle; otherwise nobody can say whose
 * shares went, and each strategy is shown the whole gap.
 */
export function lotsSettleIt(
  losses: ReadonlyMap<string, string | null>,
): Record<string, string> | null {
  const entries = [...losses];
  if (entries.length === 0 || entries.some(([, loss]) => loss === null)) return null;
  const total = entries.reduce((sum, [, loss]) => sum + signed(loss!), 0n);
  return total > 0n ? Object.fromEntries(entries.map(([allocationId, loss]) => [allocationId, loss!])) : null;
}

/**
 * What comes off one strategy's claim when the member answers for it.
 *
 * The shortfall is measured again at that moment rather than fixed when the
 * case opened, because a strategy that stopped following in the meantime
 * handed its whole claim back and may already have covered the others.
 *
 * With the lots' answer, each strategy takes what its own lots show it lost.
 * Without one, nobody can say whose shares went, so every strategy that
 * shares the ticker is shown the whole gap and whoever the member answers
 * first takes it; the rest are covered and resolve on their own. That is a
 * choice the member makes by acting, rather than a split we invent for them.
 * No strategy ever loses more than it holds.
 */
export function deductionFor(input: {
  shortfallNow: string;
  allocationId: string;
  claimedNow: string;
  /** From the lots, when they could say; absent means nobody could. */
  losses?: Readonly<Record<string, string>>;
}): string {
  const shortfall = signed(input.shortfallNow);
  if (shortfall <= 0n) return "0";
  const claimed = signed(input.claimedNow);
  const share = input.losses === undefined
    ? shortfall
    : signed(input.losses[input.allocationId] ?? "0");
  const capped = share > claimed ? claimed : share;
  return unsigned(capped < 0n ? 0n : capped);
}
