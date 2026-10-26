import { decimalToScaledInteger, scaledIntegerToDecimal } from "./decimal";

// Member instructions on an allocation.
// One instruction becomes many provider orders, so the legs point back at a
// `strategy_allocation_transactions` row. Pure: the naming and the derived state
// are unit tested without a database.

/** Leg statuses that are settled for good; anything else is still in flight. */
const TERMINAL_LEG_STATUSES = new Set(["filled", "failed", "cancelled"]);

/**
 * What an instruction has come to, read from its legs rather than stored: a
 * leg's state is moved from eight places, so a copy on the transaction would
 * rot. `open` while any leg can still change, including one waiting on
 * reconciliation; `settled` once every leg is done and at least one filled;
 * `failed` when every leg is done and none filled; `cancelled` when every leg
 * was cancelled. An instruction with no legs at all (a corporate action, or an
 * attribution release) is settled: there is nothing to wait for.
 */
export function allocationTransactionStatus(
  legs: readonly { status: string }[],
): "open" | "settled" | "failed" | "cancelled" {
  if (legs.length === 0) return "settled";
  if (legs.some((leg) => !TERMINAL_LEG_STATUSES.has(leg.status))) return "open";
  if (legs.some((leg) => leg.status === "filled")) return "settled";
  if (legs.some((leg) => leg.status === "failed")) return "failed";
  return "cancelled";
}

export type InstructionStatus = "pending" | "open" | "settled" | "failed" | "cancelled" | "superseded";

/**
 * An instruction's status once it can wait. An outcome reached without legs, or by cancelling them, is
 * stored because the legs cannot say it; a recorded instruction with no legs
 * yet is pending; everything else is still read from the legs.
 */
export function instructionStatus(input: {
  outcome: "cancelled" | "superseded" | "failed" | null;
  pendingReason: string | null;
  legs: readonly { status: string }[];
}): InstructionStatus {
  if (input.outcome !== null) return input.outcome;
  if (input.pendingReason !== null) return "pending";
  return allocationTransactionStatus(input.legs);
}

/**
 * Whether the member can still cancel: always while pending, and while
 * planned only if no leg has gone past `queued`. A reviewed leg may already
 * be at the provider, and a market order at the open fills in seconds, so a
 * cancel offered then would mostly fail.
 */
export function instructionCancellable(status: InstructionStatus, legs: readonly { status: string }[]): boolean {
  if (status === "pending") return true;
  if (status !== "open") return false;
  return legs.every((leg) => leg.status === "queued" || leg.status === "cancelled" || leg.status === "failed");
}

/**
 * Whether a redemption recomputed at run time still sells what the member
 * was shown. The amount is fixed and prices move, so notionals may differ;
 * a different set of symbols is a different instruction and is re-confirmed.
 */
export function redemptionNeedsReconfirm(
  previewSymbols: readonly string[] | null,
  plannedSymbols: readonly string[],
): boolean {
  if (previewSymbols === null) return false;
  const shown = new Set(previewSymbols);
  const planned = new Set(plannedSymbols);
  return shown.size !== planned.size || [...planned].some((symbol) => !shown.has(symbol));
}

/**
 * The deferral codes a pending instruction waits out by itself. Anything
 * else it is parked on (a reconfirmation, a missing connection) needs the
 * member, so the scheduler leaves it alone.
 */
export const SELF_CLEARING_PENDING_REASONS: ReadonlySet<string> = new Set([
  // Recorded, and the first run did not finish: try it again.
  "requested",
  "lots_unsettled",
  "market_closed",
  "open_execution",
  "fresh_position_snapshot_required",
  "missing_mark_price",
  "attributed_lots_unavailable",
  "model_stale",
  "daily_notional_limit",
  "enqueued",
  "deferred",
]);

/**
 * The change in attributed shares when a split restates a holding: what the
 * allocation held before the event, times the factor, less what it held. Written
 * as one signed entry so the ledger keeps the original fill and its restated
 * count separately, rather than rewriting history.
 */
export function splitQuantityDelta(
  attributedBefore: string,
  factor: { splitTo: number; splitFrom: number },
): string {
  const before = decimalToScaledInteger(attributedBefore);
  const after = before * BigInt(factor.splitTo) / BigInt(factor.splitFrom);
  const delta = after - before;
  return delta < 0n ? `-${scaledIntegerToDecimal(-delta)}` : scaledIntegerToDecimal(delta);
}

/** First wait after an instruction ends with a failed leg. */
export const RETRY_BACKOFF_BASE_MS = 15 * 60 * 1_000;
/** The wait stops growing here: a day between attempts. */
export const RETRY_BACKOFF_CAP_MS = 24 * 60 * 60 * 1_000;

/**
 * How long to leave an allocation alone after its instructions ended with failed
 * legs. A shortfall is replanned by the next dispatch tick,
 * which is right when the cause was transient and wrong when it is not: a leg
 * the provider keeps rejecting would otherwise be replanned every tick for
 * ever, spending the daily notional allowance on the same failure. The wait
 * doubles per consecutive failed run and stops at a day, so a transient
 * failure still recovers within the quarter hour.
 */
export function retryBackoffMs(consecutiveFailedRuns: number): number {
  if (consecutiveFailedRuns <= 0) return 0;
  const doublings = Math.min(consecutiveFailedRuns - 1, 10);
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** doublings, RETRY_BACKOFF_CAP_MS);
}

/**
 * When an allocation whose recent instructions failed may be planned again. Null
 * means now: nothing recent failed, or the wait has passed.
 */
export function retryHoldUntil(input: {
  /** Newest first: whether each recent instruction had a leg that failed. */
  recentRuns: readonly { failed: boolean; endedAt: string | null }[];
  now: number;
}): string | null {
  let consecutive = 0;
  let endedAt: string | null = null;
  for (const run of input.recentRuns) {
    if (!run.failed) break;
    consecutive += 1;
    endedAt ??= run.endedAt;
  }
  if (consecutive === 0 || endedAt === null) return null;
  const until = Date.parse(endedAt) + retryBackoffMs(consecutive);
  return Number.isNaN(until) || until <= input.now ? null : new Date(until).toISOString();
}
