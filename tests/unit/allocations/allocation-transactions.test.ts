import { describe, expect, it } from "vitest";

import {
  allocationTransactionStatus,
  RETRY_BACKOFF_CAP_MS,
  retryBackoffMs,
  retryHoldUntil,
  splitQuantityDelta,
  instructionCancellable,
  instructionStatus,
  redemptionNeedsReconfirm,
  SELF_CLEARING_PENDING_REASONS,
} from "../../../src/main/allocations/allocation-transactions";

describe("allocationTransactionStatus", () => {
  it("is open while any leg can still change, including one awaiting reconciliation", () => {
    expect(allocationTransactionStatus([{ status: "filled" }, { status: "queued" }])).toBe("open");
    expect(allocationTransactionStatus([{ status: "reconciliation_required" }])).toBe("open");
    expect(allocationTransactionStatus([{ status: "placement_unknown" }])).toBe("open");
  });

  it("settles once every leg is done and one filled", () => {
    expect(allocationTransactionStatus([{ status: "filled" }, { status: "failed" }])).toBe("settled");
    expect(allocationTransactionStatus([{ status: "filled" }, { status: "cancelled" }])).toBe("settled");
  });

  it("fails when every leg is done and none filled", () => {
    expect(allocationTransactionStatus([{ status: "failed" }, { status: "cancelled" }])).toBe("failed");
  });

  it("is cancelled when every leg was cancelled, and settled with no legs at all", () => {
    expect(allocationTransactionStatus([{ status: "cancelled" }])).toBe("cancelled");
    // A corporate action or an attribution release has nothing to wait for.
    expect(allocationTransactionStatus([])).toBe("settled");
  });
});

describe("splitQuantityDelta", () => {
  it("adds the new shares a forward split creates", () => {
    expect(splitQuantityDelta("0.45", { splitTo: 10, splitFrom: 1 })).toBe("4.05");
    expect(splitQuantityDelta("3", { splitTo: 3, splitFrom: 2 })).toBe("1.5");
  });

  it("removes the shares a reverse split takes away", () => {
    expect(splitQuantityDelta("10", { splitTo: 1, splitFrom: 10 })).toBe("-9");
    expect(splitQuantityDelta("5", { splitTo: 1, splitFrom: 5 })).toBe("-4");
  });

  it("is zero when the holding is already flat", () => {
    expect(splitQuantityDelta("0", { splitTo: 10, splitFrom: 1 })).toBe("0");
  });
});

describe("retry backoff after failed instructions", () => {
  const at = (iso: string) => Date.parse(iso);

  it("waits a quarter hour after the first failure and doubles from there", () => {
    expect(retryBackoffMs(0)).toBe(0);
    expect(retryBackoffMs(1)).toBe(15 * 60 * 1_000);
    expect(retryBackoffMs(2)).toBe(30 * 60 * 1_000);
    expect(retryBackoffMs(3)).toBe(60 * 60 * 1_000);
    expect(retryBackoffMs(50)).toBe(RETRY_BACKOFF_CAP_MS);
  });

  it("holds until the wait has passed, counting only the run of failures", () => {
    const recentRuns = [
      { failed: true, endedAt: "2026-09-17T14:00:00.000Z" },
      { failed: true, endedAt: "2026-09-17T13:00:00.000Z" },
      { failed: false, endedAt: "2026-09-17T12:00:00.000Z" },
      { failed: true, endedAt: "2026-09-17T11:00:00.000Z" },
    ];
    // Two in a row: half an hour from the newest.
    expect(retryHoldUntil({ recentRuns, now: at("2026-09-17T14:20:00.000Z") })).toBe("2026-09-17T14:30:00.000Z");
    expect(retryHoldUntil({ recentRuns, now: at("2026-09-17T14:31:00.000Z") })).toBeNull();
  });

  it("does not hold when the newest run succeeded", () => {
    expect(retryHoldUntil({
      recentRuns: [{ failed: false, endedAt: "2026-09-17T14:00:00.000Z" }, { failed: true, endedAt: "2026-09-17T13:00:00.000Z" }],
      now: at("2026-09-17T14:00:01.000Z"),
    })).toBeNull();
  });

  it("does not hold on a failure whose legs have no terminal time yet", () => {
    expect(retryHoldUntil({ recentRuns: [{ failed: true, endedAt: null }], now: at("2026-09-17T14:00:00.000Z") })).toBeNull();
  });
});

describe("instruction lifecycle", () => {
  it("reads a stored outcome first, then pending, then the legs", () => {
    expect(instructionStatus({ outcome: "cancelled", pendingReason: null, legs: [{ status: "queued" }] })).toBe("cancelled");
    expect(instructionStatus({ outcome: null, pendingReason: "lots_unsettled", legs: [] })).toBe("pending");
    expect(instructionStatus({ outcome: null, pendingReason: null, legs: [{ status: "submitted" }] })).toBe("open");
    expect(instructionStatus({ outcome: null, pendingReason: null, legs: [{ status: "filled" }] })).toBe("settled");
    expect(instructionStatus({ outcome: "superseded", pendingReason: null, legs: [] })).toBe("superseded");
  });

  it("cancels while pending, and while planned only if nothing has been sent", () => {
    expect(instructionCancellable("pending", [])).toBe(true);
    expect(instructionCancellable("open", [{ status: "queued" }, { status: "queued" }])).toBe(true);
    expect(instructionCancellable("open", [{ status: "queued" }, { status: "reviewed" }])).toBe(false);
    expect(instructionCancellable("open", [{ status: "submitted" }])).toBe(false);
    expect(instructionCancellable("settled", [{ status: "filled" }])).toBe(false);
    expect(instructionCancellable("cancelled", [])).toBe(false);
  });

  it("re-confirms only when the set of holdings sold changes", () => {
    expect(redemptionNeedsReconfirm(["AMZN", "NVDA"], ["NVDA", "AMZN"])).toBe(false);
    expect(redemptionNeedsReconfirm(["AMZN", "NVDA"], ["AMZN", "NVDA", "TSLA"])).toBe(true);
    expect(redemptionNeedsReconfirm(["AMZN", "NVDA"], ["AMZN"])).toBe(true);
    expect(redemptionNeedsReconfirm(null, ["AMZN", "TSLA"])).toBe(false);
  });

  it("leaves a reconfirmation to the member and retries what clears by itself", () => {
    expect(SELF_CLEARING_PENDING_REASONS.has("lots_unsettled")).toBe(true);
    expect(SELF_CLEARING_PENDING_REASONS.has("requested")).toBe(true);
    expect(SELF_CLEARING_PENDING_REASONS.has("reconfirm_required")).toBe(false);
  });
});
