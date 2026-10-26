const easternDate = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
import {
  decimalToScaledInteger,
  divideDecimals,
  scaledIntegerToDecimal,
} from "./decimal";

// Robinhood open tax lots for one symbol, and the two pure decisions built on
// them: which lot a strategy buy fill created, and which known lots a strategy
// sell should name so it never consumes self-directed shares.

export interface RobinhoodTaxLot {
  openLotId: string;
  quantity: string;
  /** Total cost of the lot when the provider reports it. */
  costBasis: string | null;
  /** Per-share cost, reported or derived from cost basis and quantity. */
  unitCost: string | null;
  acquiredAt: string | null;
  /**
   * Whether the provider lets a sell name this lot yet. Robinhood reports
   * false for a lot bought today until it syncs; absent when not reported.
   */
  selectable?: boolean;
}

export const MAX_SPECIFIED_LOTS = 30;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function decimal(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    const candidate = typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
    if (candidate !== null && DECIMAL.test(candidate)) return candidate;
  }
  return null;
}

function text(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return null;
}

function isoDate(record: Record<string, unknown>, ...keys: string[]): string | null {
  const value = text(record, ...keys);
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function lotRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 10 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => lotRecords(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (text(record, "open_lot_id", "lot_id", "id") !== null && decimal(record, "quantity") !== null) {
    return [record];
  }
  return Object.values(record).flatMap((item) => lotRecords(item, depth + 1));
}

function nextCursor(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const direct = text(record, "next_cursor");
  if (direct !== null && direct.length <= 4_096) return direct;
  const next = text(record, "next");
  if (next !== null) {
    try {
      const cursor = new URL(next).searchParams.get("cursor");
      if (cursor !== null && cursor.length > 0 && cursor.length <= 4_096) return cursor;
    } catch {
      // Non-URL pagination values are not safe cursor inputs.
    }
  }
  for (const item of Object.values(record)) {
    const cursor = nextCursor(item, depth + 1);
    if (cursor !== null) return cursor;
  }
  return null;
}

/** Tolerant reader for one page of `get_equity_tax_lots`. */
export function normalizeRobinhoodTaxLots(value: unknown): {
  lots: RobinhoodTaxLot[];
  nextCursor: string | null;
} {
  const lots = new Map<string, RobinhoodTaxLot>();
  for (const record of lotRecords(value)) {
    const openLotId = text(record, "open_lot_id", "lot_id", "id");
    const quantity = decimal(record, "quantity");
    if (openLotId === null || quantity === null || openLotId.length > 256) continue;
    if (decimalToScaledInteger(quantity.replace(/^-/u, "")) === 0n) continue;
    const costBasis = decimal(record, "cost_basis", "tax_cost_basis", "total_cost", "cost");
    const reportedUnit = decimal(record, "cost_per_share", "average_cost", "price", "unit_cost");
    const unitCost = reportedUnit ?? (
      costBasis === null ? null : divideDecimals(costBasis, quantity)
    );
    // Robinhood names the acquisition day `open_date` (a bare Eastern date).
    // Missing it left every lot undated, so "oldest first" fell back to lot id
    // order and a sell named a lot bought that morning (2026-09-30).
    const selectable = record.is_selectable;
    lots.set(openLotId, {
      openLotId,
      quantity,
      costBasis,
      unitCost,
      acquiredAt: isoDate(record, "open_date", "acquired_at", "acquisition_date", "purchase_date", "created_at", "date"),
      ...(typeof selectable === "boolean" ? { selectable } : {}),
    });
  }
  return { lots: [...lots.values()], nextCursor: nextCursor(value) };
}

/** Whether a lot's acquisition day is the fill's Eastern trading day; a bare date parses as UTC midnight, so its first ten characters are that day. */
function sameDay(left: string | null, right: string): boolean {
  return left !== null && left.slice(0, 10) === easternDate(Date.parse(right));
}

function distance(left: string | null, right: string): bigint {
  if (left === null) return 10n ** 30n;
  const delta = decimalToScaledInteger(left) - decimalToScaledInteger(right);
  return delta < 0n ? -delta : delta;
}

/**
 * Picks the open lot a strategy buy fill created. Quantity must match exactly;
 * ties break on same acquisition day, then closest unit cost. Lots already
 * claimed by other fills are excluded so two identical fills map to two lots.
 */
export function matchFillToLot(
  lots: readonly RobinhoodTaxLot[],
  fill: { quantity: string; price: string; occurredAt: string },
  claimedLotIds: ReadonlySet<string>,
): RobinhoodTaxLot | null {
  const quantity = decimalToScaledInteger(fill.quantity);
  const candidates = lots.filter((lot) =>
    !claimedLotIds.has(lot.openLotId) &&
    decimalToScaledInteger(lot.quantity) === quantity
  );
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const dayScore = Number(sameDay(right.acquiredAt, fill.occurredAt)) -
      Number(sameDay(left.acquiredAt, fill.occurredAt));
    if (dayScore !== 0) return dayScore;
    const costDelta = distance(left.unitCost, fill.price) - distance(right.unitCost, fill.price);
    return costDelta < 0n ? -1 : costDelta > 0n ? 1 : 0;
  });
  return candidates[0] ?? null;
}

export interface SpecifiedLotSelection {
  /** Lots to name on the sell, oldest first; empty when nothing is known. */
  taxLots: Array<{ openLotId: string; quantity: string }>;
  /** True when the named lots cover the full sell quantity. */
  covered: boolean;
  /** Quantity the known lots could not cover. */
  shortfall: string;
}

/**
 * Chooses which of the allocation's known lots a sell should name. Only lots the
 * allocation bought (by stored id) are eligible; live quantities come from the
 * provider so lots partly consumed elsewhere are respected. FIFO by
 * acquisition, capped at the provider's per-order lot limit.
 */
export function selectLotsForSale(
  liveLots: readonly RobinhoodTaxLot[],
  knownLotIds: ReadonlySet<string>,
  quantity: string,
): SpecifiedLotSelection {
  const eligible = liveLots
    .filter((lot) => knownLotIds.has(lot.openLotId))
    .sort((left, right) =>
      (left.acquiredAt ?? "").localeCompare(right.acquiredAt ?? "") ||
      left.openLotId.localeCompare(right.openLotId)
    );
  let remaining = decimalToScaledInteger(quantity);
  const taxLots: SpecifiedLotSelection["taxLots"] = [];
  for (const lot of eligible) {
    if (remaining <= 0n || taxLots.length >= MAX_SPECIFIED_LOTS) break;
    const available = decimalToScaledInteger(lot.quantity);
    if (available <= 0n) continue;
    const take = available < remaining ? available : remaining;
    taxLots.push({ openLotId: lot.openLotId, quantity: scaledIntegerToDecimal(take) });
    remaining -= take;
  }
  return {
    taxLots,
    covered: remaining <= 0n,
    shortfall: scaledIntegerToDecimal(remaining < 0n ? 0n : remaining),
  };
}

export interface LotSelectionWithFallback extends SpecifiedLotSelection {
  /** Quantity named from lots no strategy claims, standing in for the allocation's own. */
  borrowed: string;
}

/**
 * The allocation's own lots first, then lots no strategy claims, oldest first.
 *
 * The second step is only for one situation, and the caller must establish
 * it: the account holds at least what every strategy claims, yet this
 * allocation's recorded lots no longer cover its shares. That happens when the
 * member sells shares of their own in Robinhood and the provider's
 * first-in-first-out picks the strategy's older lots instead of the member's
 * newer ones. The count is right -- the member sold what they owned -- but
 * the lots that now carry the strategy's shares are the member's surviving
 * ones, and nothing claims them. Naming those keeps the strategy selling
 * only shares it owns; without it, every later sell of the symbol would
 * stall.
 */
export function selectLotsWithFallback(
  liveLots: readonly RobinhoodTaxLot[],
  knownLotIds: ReadonlySet<string>,
  unclaimedLotIds: ReadonlySet<string>,
  quantity: string,
): LotSelectionWithFallback {
  const own = selectLotsForSale(liveLots, knownLotIds, quantity);
  if (own.covered) return { ...own, borrowed: "0" };
  const stand = selectLotsForSale(
    liveLots.filter((lot) => unclaimedLotIds.has(lot.openLotId) && !knownLotIds.has(lot.openLotId)),
    unclaimedLotIds,
    own.shortfall,
  );
  // One order names at most MAX_SPECIFIED_LOTS lots; a sell that would need
  // more is not covered rather than silently falling back to the provider's
  // own choice.
  if (own.taxLots.length + stand.taxLots.length > MAX_SPECIFIED_LOTS) {
    return { ...own, borrowed: "0" };
  }
  const borrowed = decimalToScaledInteger(own.shortfall) - decimalToScaledInteger(stand.shortfall);
  return {
    taxLots: [...own.taxLots, ...stand.taxLots],
    covered: stand.covered,
    shortfall: stand.shortfall,
    borrowed: scaledIntegerToDecimal(borrowed),
  };
}
