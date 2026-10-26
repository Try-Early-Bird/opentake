// Venue minimums/headroom are explicit inputs; no hosted activation or copy-trading limits.
import { decimalToScaledInteger, scaledIntegerToDecimal } from "./decimal";

// Taking money out without leaving the strategy (partial redemption).
// A redemption scales the whole basket down rather than closing positions:
// every holding is sold in proportion, so the allocation keeps the strategy's
// composition with less money in it. Selling one holding to raise the cash
// would be easier and would stop the allocation from maintaining its target weights.
// That proportionality is what bounds the amount at both ends. Each sell has
// to clear the provider's minimum, so the smallest holding's share of the
// withdrawal sets a floor; and the plan requires a allocation to keep at least
// its venue-derived floor of value, which sets a ceiling. The band between them can
// be empty, and then the honest answer is that only a full close is possible.

/**
 * What must remain is not a flat figure but the allocation's own floor: enough
 * for every holding's share to still clear the provider's minimum order.
 * Below it the allocation cannot hold what the strategy holds, so continuing to
 * follow is not on offer and closing is the honest answer.
 *
 * It is the same expression as the smallest withdrawal, because both are
 * bounded by the smallest holding: at weight `w` a withdrawal of `A` sells
 * `w x A`, and a remainder of `R` holds `w x R`.
 */

export interface RedemptionHolding {
  symbol: string;
  /** Marked value of the allocation's own attributed shares. */
  valueUsd: string;
}

export interface RedemptionBand {
  /** Smallest withdrawal whose smallest leg still clears the provider minimum. */
  minimumUsd: string;
  /** Largest withdrawal that leaves enough behind to still hold every holding. */
  maximumUsd: string;
  /** False when the floor is above the ceiling: what is left could not hold the strategy, so only closing is possible. */
  possible: boolean;
  /** Marked value of the holdings the band was computed from. */
  holdingsValueUsd: string;
}

export type RedemptionReasonCode =
  | "below_band"
  | "above_band"
  | "no_partial_redemption"
  | "nothing_to_sell";

export interface RedemptionLeg {
  symbol: string;
  /** Dollars of this holding to sell. */
  notionalUsd: string;
}

export interface RedemptionPlan {
  ok: boolean;
  band: RedemptionBand;
  legs: RedemptionLeg[];
  reasons: { code: RedemptionReasonCode; needed?: string }[];
  /** What the allocation would be worth afterwards, at the same marks. */
  remainingValueUsd: string;
}

const CENTS = 10n ** 16n;

function floorToCents(value: bigint): bigint {
  return value - (value % CENTS);
}

function ceilToCents(value: bigint): bigint {
  const remainder = value % CENTS;
  return remainder === 0n ? value : value + (CENTS - remainder);
}

function usd(value: bigint): string {
  return scaledIntegerToDecimal(value < 0n ? 0n : value);
}

/**
 * The strategy's own weights, as published. Supplying them is what allows an
 * uneven sell: without a target there is no measure of which uneven set is
 * better than another, so the proportional set is the only honest one.
 */
export interface RedemptionTarget {
  symbol: string;
  /** Percent of the whole allocation, cash included, as the allocation states it. */
  weightPercent: number;
}

/** Integer cents, the unit the uneven allocator works in. */
function cents(value: bigint): bigint {
  return value / CENTS;
}

/**
 * How much of a holding may be sold: everything above one minimum order, and
 * nothing at all unless it can both sell a minimum and keep one. A holding
 * reduced below the provider's minimum is one the allocation can no longer trade,
 * which is a worse position to leave a member in than not selling it.
 */
function sellableCents(holdingCents: bigint, minimumCents: bigint): bigint {
  return holdingCents >= minimumCents * 2n ? holdingCents - minimumCents : 0n;
}

/**
 * Adds `wanted` cents across `order` in proportion to `weights`, never taking
 * any symbol above its `cap`. Largest remainder decides the odd cents, ties by
 * symbol, so the same inputs always produce the same legs. Returns what could
 * not be placed.
 */
function distribute(
  wanted: bigint,
  order: readonly string[],
  weights: ReadonlyMap<string, bigint>,
  cap: ReadonlyMap<string, bigint>,
  into: Map<string, bigint>,
): bigint {
  let left = wanted;
  const totalWeight = order.reduce((sum, symbol) => sum + (weights.get(symbol) ?? 0n), 0n);
  const parts: { symbol: string; remainder: bigint }[] = [];
  if (totalWeight > 0n) {
    for (const symbol of order) {
      const weight = weights.get(symbol) ?? 0n;
      if (weight <= 0n) continue;
      const exact = wanted * weight;
      const room = (cap.get(symbol) ?? 0n) - (into.get(symbol) ?? 0n);
      let take = exact / totalWeight;
      if (take > room) take = room;
      if (take < 0n) take = 0n;
      into.set(symbol, (into.get(symbol) ?? 0n) + take);
      left -= take;
      parts.push({ symbol, remainder: exact % totalWeight });
    }
    parts.sort((left_, right) => (left_.remainder === right.remainder
      ? left_.symbol.localeCompare(right.symbol)
      : (right.remainder > left_.remainder ? 1 : -1)));
    for (const part of parts) {
      if (left <= 0n) break;
      if ((cap.get(part.symbol) ?? 0n) - (into.get(part.symbol) ?? 0n) <= 0n) continue;
      into.set(part.symbol, (into.get(part.symbol) ?? 0n) + 1n);
      left -= 1n;
    }
  }
  // Whatever proportion could not place, because of the caps, goes to
  // whoever still has room.
  for (const symbol of order) {
    if (left <= 0n) break;
    const room = (cap.get(symbol) ?? 0n) - (into.get(symbol) ?? 0n);
    if (room <= 0n) continue;
    const take = room < left ? room : left;
    into.set(symbol, (into.get(symbol) ?? 0n) + take);
    left -= take;
  }
  return left;
}

/**
 * Sells that leave the allocation as close to the strategy as the constraints
 * allow, for when selling every holding in proportion is not executable
 * (priority 4).
 *
 * The proportional set fails whenever one holding's share of the withdrawal
 * falls under the provider's minimum, which is true of any allocation holding a
 * small sleeve: a 1% position in a $150 investment can never be sold a dollar
 * at a time. Refusing there told the member their only option was to close the
 * whole thing, which is a worse answer than selling the holdings that can be
 * sold.
 *
 * Two decisions, taken in order. First, which holdings take part: every leg
 * placed has to be at least one minimum order, so at most `amount / minimum`
 * holdings can, and the most overweight are chosen, traded for roomier ones
 * only when the chosen set could not raise the amount. Second, how much each
 * sells: every participant is seated at one minimum order, and the rest is
 * taken first from whatever is above its target share of what remains, then
 * from every participant in proportion to what it may still sell. Seating
 * first is what makes the answer exact: a set of `k` holdings can raise the
 * amount if and only if `k` minimums fit under it and their room covers it,
 * and the largest such `k` has the most room, so if any set works that one
 * does. Returns null only when none does, which is the honest answer that
 * closing remains.
 */
function allocateTowardTarget(
  amountCents: bigint,
  holdings: ReadonlyArray<{ symbol: string; cents: bigint }>,
  targetBps: ReadonlyMap<string, bigint>,
  minimumCents: bigint,
): Map<string, bigint> | null {
  const order = holdings.map((holding) => holding.symbol).sort();
  const held = new Map(holdings.map((holding) => [holding.symbol, holding.cents]));
  const total = holdings.reduce((sum, holding) => sum + holding.cents, 0n);
  if (amountCents <= 0n || amountCents > total || minimumCents <= 0n) return null;
  const remainder = total - amountCents;
  const room = new Map(order.map((symbol) => [symbol, sellableCents(held.get(symbol)!, minimumCents)]));
  // The weights are shares of the whole strategy, cash and all, while what is
  // left here is only the equity this allocation holds. Comparing the two
  // directly would make every holding look overweight -- by the strategy's
  // cash, and by any sleeve the allocation does not hold -- and the sells would
  // come partly out of a holding that is actually short. Normalising over
  // what is held is the comparison that means something.
  const heldWeight = order.reduce((sum, symbol) => sum + (targetBps.get(symbol) ?? 0n), 0n);
  // What each holding is above its target share of what will remain, capped
  // at what may be sold of it.
  const surplus = new Map(order.map((symbol) => {
    const ideal = heldWeight <= 0n ? 0n : (targetBps.get(symbol) ?? 0n) * remainder / heldWeight;
    const value = held.get(symbol)!;
    const over = value > ideal ? value - ideal : 0n;
    const cap = room.get(symbol)!;
    return [symbol, over > cap ? cap : over];
  }));

  // Who takes part. A holding with no room cannot; and no more can than
  // there are minimum orders in the amount.
  const candidates = order.filter((symbol) => room.get(symbol)! > 0n);
  const seats = amountCents / minimumCents;
  const count = Number(seats < BigInt(candidates.length) ? seats : BigInt(candidates.length));
  if (count === 0) return null;
  const by = (key: ReadonlyMap<string, bigint>) => (left: string, right: string): number => {
    const difference = key.get(right)! - key.get(left)!;
    return difference === 0n ? left.localeCompare(right) : (difference > 0n ? 1 : -1);
  };
  const roomiest = [...candidates].sort(by(room));
  const roomOf = (set: readonly string[]): bigint => set.reduce((sum, symbol) => sum + room.get(symbol)!, 0n);
  if (roomOf(roomiest.slice(0, count)) < amountCents) return null;
  // The most overweight first, and only as many as it takes: a holding is
  // seated while what the seated ones are above target falls short of the
  // amount, never to make up numbers, since each seat sells a minimum order
  // of something the strategy may want kept. If their room is still short,
  // the roomiest outsiders are added while seats remain, and after that the
  // seated holding with the least room makes way for one; each step strictly
  // adds room, so this always ends at a set that can raise the amount.
  const chosen: string[] = [];
  const surplusOf = (set: readonly string[]): bigint => set.reduce((sum, symbol) => sum + surplus.get(symbol)!, 0n);
  for (const symbol of [...candidates].sort(by(surplus))) {
    if (chosen.length >= count || surplusOf(chosen) >= amountCents) break;
    chosen.push(symbol);
  }
  while (roomOf(chosen) < amountCents) {
    const outsider = roomiest.find((symbol) => !chosen.includes(symbol))!;
    if (chosen.length < count) {
      chosen.push(outsider);
      continue;
    }
    const out = [...chosen].sort(by(room)).at(-1)!;
    chosen.splice(chosen.indexOf(out), 1, outsider);
  }
  chosen.sort();

  // How much each. Seated at one minimum order; the rest toward the target,
  // then in proportion to what may still be sold.
  const sells = new Map(chosen.map((symbol) => [symbol, minimumCents]));
  const cap = new Map(chosen.map((symbol) => [symbol, room.get(symbol)!]));
  const beyondSeat = new Map(chosen.map((symbol) => {
    const above = surplus.get(symbol)! - minimumCents;
    return [symbol, above > 0n ? above : 0n];
  }));
  let left = amountCents - minimumCents * BigInt(chosen.length);
  left = distribute(left, chosen, beyondSeat, new Map(chosen.map((symbol) => [symbol, sells.get(symbol)! + beyondSeat.get(symbol)!])), sells);
  if (left > 0n) {
    const rest = new Map(chosen.map((symbol) => [symbol, cap.get(symbol)! - sells.get(symbol)!]));
    left = distribute(left, chosen, rest, cap, sells);
  }
  // The room check above is what guarantees this; it is asserted rather than
  // trusted because a wrong leg here is a wrong order.
  if (left !== 0n) return null;
  for (const symbol of order) if (!sells.has(symbol)) sells.set(symbol, 0n);
  return sells;
}

/**
 * The range a member may take out of this allocation. The floor comes from the
 * smallest holding: at weight `w`, a withdrawal of `A` sells `w × A` of it,
 * which must reach the provider's minimum, so `A ≥ minimum / w`. The ceiling
 * is whatever leaves the allocation its floor of value.
 */
export function redemptionBand(
  holdings: readonly RedemptionHolding[],
  options: {
    minimumOrderNotionalUsd: string;
    minimumRemainingUsd?: string;
    /** The strategy's weights; given, uneven sells widen the band. */
    targets?: readonly RedemptionTarget[];
  },
): RedemptionBand {
  const minimumOrder = decimalToScaledInteger(options.minimumOrderNotionalUsd);
  const positive = holdings.filter((holding) => decimalToScaledInteger(holding.valueUsd) > 0n);
  const total = positive.reduce((sum, holding) => sum + decimalToScaledInteger(holding.valueUsd), 0n);
  if (total === 0n) {
    return { minimumUsd: "0", maximumUsd: "0", possible: false, holdingsValueUsd: "0" };
  }
  const smallest = positive.reduce(
    (low, holding) => {
      const value = decimalToScaledInteger(holding.valueUsd);
      return value < low ? value : low;
    },
    decimalToScaledInteger(positive[0]!.valueUsd),
  );
  // minimum / (smallest / total), in one step to keep the precision.
  const floor = ceilToCents(minimumOrder * total / smallest);
  // What has to stay behind: the same floor, unless the caller names one.
  const remainingFloor = options.minimumRemainingUsd === undefined
    ? floor
    : decimalToScaledInteger(options.minimumRemainingUsd);
  const ceiling = floorToCents(total > remainingFloor ? total - remainingFloor : 0n);
  if (options.targets === undefined) {
    return {
      minimumUsd: usd(floor),
      maximumUsd: usd(ceiling),
      possible: ceiling >= floor && ceiling > 0n,
      holdingsValueUsd: usd(total),
    };
  }
  // With the strategy's weights in hand the sells need not be proportional,
  // so the band is whatever an uneven set can reach: a single minimum order
  // at the low end, and everything above one minimum order of every holding
  // that can spare it at the high end. Both ends are exactly achievable, and
  // this band contains the proportional one rather than replacing it -- an
  // amount inside the proportional band is still sold proportionally.
  const sellable = positive.reduce(
    (sum, holding) => sum + sellableCents(cents(decimalToScaledInteger(holding.valueUsd)), cents(minimumOrder)),
    0n,
  ) * CENTS;
  const unevenCeiling = sellable < ceiling ? ceiling : sellable;
  const unevenFloor = minimumOrder < floor ? minimumOrder : floor;
  return {
    minimumUsd: usd(unevenFloor),
    maximumUsd: usd(unevenCeiling),
    possible: unevenCeiling >= unevenFloor && unevenCeiling > 0n,
    holdingsValueUsd: usd(total),
  };
}

/**
 * Sells every holding in proportion to what the allocation holds of it, so the
 * mix afterwards is the mix before. Amounts are cents; the rounding remainder
 * goes to the largest legs so the member receives the gross amount they asked
 * for, and no leg is ever larger than the holding it sells.
 */
export function planRedemption(
  amountUsd: string,
  holdings: readonly RedemptionHolding[],
  options: {
    minimumOrderNotionalUsd: string;
    minimumRemainingUsd?: string;
    /** The strategy's weights; given, an uneven set is tried when the
     *  proportional one is not executable. */
    targets?: readonly RedemptionTarget[];
  },
): RedemptionPlan {
  const band = redemptionBand(holdings, options);
  // What the proportional set can reach, which is the first choice whenever
  // it is available: the mix afterwards is the mix before, and the plan ranks
  // reaching the requested gross that way above minimising drift.
  const proportional = options.targets === undefined
    ? band
    : redemptionBand(holdings, { ...options, targets: undefined });
  const amount = decimalToScaledInteger(amountUsd);
  const total = decimalToScaledInteger(band.holdingsValueUsd);
  const reasons: RedemptionPlan["reasons"] = [];
  const remaining = total > amount ? total - amount : 0n;
  if (total === 0n) {
    return { ok: false, band, legs: [], reasons: [{ code: "nothing_to_sell" }], remainingValueUsd: "0" };
  }
  if (!band.possible) {
    // The smallest holding's share can never clear the provider's minimum
    // while leaving enough behind to hold the strategy: closing is the only
    // honest option.
    return {
      ok: false,
      band,
      legs: [],
      reasons: [{ code: "no_partial_redemption" }],
      remainingValueUsd: usd(remaining),
    };
  }
  if (amount < decimalToScaledInteger(band.minimumUsd)) {
    reasons.push({ code: "below_band", needed: band.minimumUsd });
  }
  if (amount > decimalToScaledInteger(band.maximumUsd)) {
    reasons.push({ code: "above_band", needed: band.maximumUsd });
  }

  const positive = holdings
    .filter((holding) => decimalToScaledInteger(holding.valueUsd) > 0n)
    .map((holding) => ({ symbol: holding.symbol, value: decimalToScaledInteger(holding.valueUsd) }));

  const proportionalFits = proportional.possible
    && amount >= decimalToScaledInteger(proportional.minimumUsd)
    && amount <= decimalToScaledInteger(proportional.maximumUsd);
  if (options.targets !== undefined && !proportionalFits && reasons.length === 0) {
    // Every holding cannot be sold in proportion, so sell what can be sold,
    // taking first from whatever the allocation is overweight in.
    const minimumOrder = decimalToScaledInteger(options.minimumOrderNotionalUsd);
    const targetBps = new Map(options.targets.map((target) => [
      target.symbol,
      BigInt(Math.round(target.weightPercent * 100)),
    ]));
    const allocated = allocateTowardTarget(
      cents(floorToCents(amount)),
      positive.map((holding) => ({ symbol: holding.symbol, cents: cents(holding.value) })),
      targetBps,
      cents(minimumOrder),
    );
    if (allocated === null) {
      return {
        ok: false,
        band,
        legs: [],
        reasons: [{ code: "no_partial_redemption" }],
        remainingValueUsd: usd(remaining),
      };
    }
    return {
      ok: true,
      band,
      legs: positive
        .filter((holding) => allocated.get(holding.symbol)! > 0n)
        .map((holding) => ({ symbol: holding.symbol, notionalUsd: usd(allocated.get(holding.symbol)! * CENTS) })),
      reasons: [],
      remainingValueUsd: usd(remaining),
    };
  }

  const sized = positive.map((holding) => ({
    symbol: holding.symbol,
    value: holding.value,
    // Floored, so no leg can exceed its holding; the remainder is placed below.
    amount: floorToCents(holding.value * amount / total),
  }));
  let remainderCents = (floorToCents(amount) - sized.reduce((sum, leg) => sum + leg.amount, 0n)) / CENTS;
  const byLargest = [...sized].sort((left, right) =>
    right.value === left.value ? left.symbol.localeCompare(right.symbol) : (right.value > left.value ? 1 : -1));
  for (let index = 0; remainderCents > 0n && index < byLargest.length * 1000; index += 1) {
    const leg = byLargest[index % byLargest.length]!;
    // Never sell more of a holding than the allocation owns of it.
    if (leg.amount + CENTS > leg.value) continue;
    leg.amount += CENTS;
    remainderCents -= 1n;
  }
  return {
    ok: reasons.length === 0,
    band,
    legs: sized.map((leg) => ({ symbol: leg.symbol, notionalUsd: usd(leg.amount) })),
    reasons,
    remainingValueUsd: usd(remaining),
  };
}

export interface RedemptionSale {
  symbol: string;
  /** Shares to sell, at the precision the provider accepts. */
  quantity: string;
  /** What that many shares is worth at the mark the plan used. */
  notionalUsd: string;
}

/**
 * Turns each dollar leg into a share count at the current mark, floored to
 * the provider's quantity precision and never above what the allocation is
 * attributed. Selling by shares rather than by dollars is deliberate: a
 * dollar-denominated sell becomes a quantity at execution time, and a price
 * move between request and fill could take more shares than the allocation owns,
 * eating into the member's own holding of the same symbol. Gross proceeds therefore move with the price, which the plan
 * allows; quantity conservation does not.
 */
export function redemptionSales(
  legs: readonly RedemptionLeg[],
  marks: ReadonlyMap<string, { markPriceUsd: string; attributedQuantity: string; quantityIncrement?: string; minimumOrderNotionalUsd?: string }>,
  options: { quantityScale?: number; minimumOrderNotionalUsd: string; sellHeadroomBps: number },
): { sales: RedemptionSale[]; unpriced: string[] } {
  const defaultScale = BigInt(10) ** BigInt(18 - (options.quantityScale ?? 6));
  // Floored shares at the mark come out at or under the leg's dollars, and the
  // fill is at a live price; a leg near the provider's minimum is sized up to
  // clear it with headroom, never past what the allocation owns.
  const minimum = decimalToScaledInteger(options.minimumOrderNotionalUsd);
  if (!Number.isSafeInteger(options.sellHeadroomBps) || options.sellHeadroomBps < 0) throw new Error("Invalid venue sell headroom");

  const sales: RedemptionSale[] = [];
  const unpriced: string[] = [];
  for (const leg of legs) {
    const mark = marks.get(leg.symbol);
    const price = mark === undefined ? 0n : decimalToScaledInteger(mark.markPriceUsd);
    if (mark === undefined || price <= 0n) {
      unpriced.push(leg.symbol);
      continue;
    }
    const scale=mark.quantityIncrement===undefined?defaultScale:decimalToScaledInteger(mark.quantityIncrement);
    if(scale<=0n)throw new Error('Positive quantity increment required');
    const legMinimum=mark.minimumOrderNotionalUsd===undefined?minimum:decimalToScaledInteger(mark.minimumOrderNotionalUsd);
    const legFloor=legMinimum*(10_000n+BigInt(options.sellHeadroomBps))/10_000n;
    const wanted = decimalToScaledInteger(leg.notionalUsd) * 10n ** 18n / price;
    const owned = decimalToScaledInteger(mark.attributedQuantity);
    const floorShares = (legFloor * 10n ** 18n + price - 1n) / price;
    const floorQuantity = floorShares + (scale - floorShares % scale) % scale;
    // Only a leg planned at or over the minimum: a smaller one is not an order.
    const orderable = decimalToScaledInteger(leg.notionalUsd) >= legMinimum;
    const sized = orderable && wanted < floorQuantity ? floorQuantity : wanted;
    const capped = sized > owned ? owned : sized;
    const quantity = capped - (capped % scale);
    if (quantity <= 0n) continue;
    sales.push({
      symbol: leg.symbol,
      quantity: scaledIntegerToDecimal(quantity),
      notionalUsd: usd(quantity * price / 10n ** 18n),
    });
  }
  return { sales, unpriced: unpriced.sort() };
}
