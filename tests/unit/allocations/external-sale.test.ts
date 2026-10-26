import { describe, expect, it } from "vitest";

import { deductionFor, judgeExternalSale, lotLosses, lotsSettleIt } from "../../../src/main/allocations/external-sale";

describe("judgeExternalSale", () => {
  it("leaves the strategies alone when the member's own shares cover the sale", () => {
    // 15 shares before, strategies claim 10, the member sells 5 of their own.
    expect(judgeExternalSale({
      snapshotQuantity: "15",
      fillsSince: [{ side: "sell", quantity: "5" }],
      claimedQuantities: ["6", "4"],
    })).toEqual({ touchesStrategies: false, heldAfter: "10", claimed: "10" });
  });

  it("reports only the part of the sale the member's own shares could not cover", () => {
    // 12 before, strategies claim 10, the member sells 5: 2 were theirs, 3 were not.
    expect(judgeExternalSale({
      snapshotQuantity: "12",
      fillsSince: [{ side: "sell", quantity: "5" }],
      claimedQuantities: ["6", "4"],
    })).toEqual({ touchesStrategies: true, heldAfter: "7", claimed: "10", shortfall: "3", difference: "-3" });
  });

  it("counts every fill since the snapshot, strategy buys included", () => {
    // A strategy bought 2 after the snapshot and its claim already includes them.
    expect(judgeExternalSale({
      snapshotQuantity: "10",
      fillsSince: [{ side: "buy", quantity: "2" }, { side: "sell", quantity: "1.5" }],
      claimedQuantities: ["10"],
    })).toMatchObject({ touchesStrategies: false, heldAfter: "10.5" });
  });

  it("treats a symbol a complete snapshot does not list as zero held", () => {
    expect(judgeExternalSale({
      snapshotQuantity: "0",
      fillsSince: [{ side: "buy", quantity: "4" }, { side: "sell", quantity: "4" }],
      claimedQuantities: ["4"],
    })).toMatchObject({ touchesStrategies: true, shortfall: "4" });
  });

  it("fails closed without a complete snapshot to measure from", () => {
    expect(judgeExternalSale({
      snapshotQuantity: null,
      fillsSince: [{ side: "sell", quantity: "1" }],
      claimedQuantities: ["3"],
    })).toEqual({ touchesStrategies: true, heldAfter: null, claimed: "3", shortfall: null, difference: null });
  });

  it("fails closed on a fill whose direction is unknown rather than guessing it", () => {
    expect(judgeExternalSale({
      snapshotQuantity: "5",
      fillsSince: [{ side: null, quantity: "5" }],
      claimedQuantities: ["5"],
    })).toMatchObject({ touchesStrategies: true, shortfall: null });
  });
});

describe("which strategy a shortfall belongs to", () => {
  const allocations = [
    { allocationId: "a", claimed: "6", lotIds: ["l1", "l2"], unmatchedBuys: false },
    { allocationId: "b", claimed: "4", lotIds: ["l3"], unmatchedBuys: false },
  ];

  it("reads each strategy's loss from its own lots", () => {
    // The sale took l1 entirely (3 shares) and left b's lot alone.
    const losses = lotLosses(allocations, new Map([["l2", "3"], ["l3", "4"]]));
    expect(losses.get("a")).toBe("3");
    expect(losses.get("b")).toBe("0");
  });

  it("does not speak for a strategy with a buy it never matched to a lot", () => {
    const losses = lotLosses([{ ...allocations[0]!, unmatchedBuys: true }], new Map());
    expect(losses.get("a")).toBeNull();
  });

  it("takes the lots' answer when they speak for every strategy", () => {
    expect(lotsSettleIt(new Map([["a", "3"], ["b", "0"]]))).toEqual({ a: "3", b: "0" });
  });

  it("refuses to settle when any strategy lacks lot evidence", () => {
    expect(lotsSettleIt(new Map([["a", "3"], ["b", null]]))).toBeNull();
  });

  it("refuses to settle when the lots show no loss at all", () => {
    expect(lotsSettleIt(new Map([["a", "0"]]))).toBeNull();
  });

  it("gives each strategy its own loss when the lots could tell", () => {
    expect(deductionFor({
      shortfallNow: "3", allocationId: "a", claimedNow: "6", losses: { a: "3", b: "0" },
    })).toBe("3");
    expect(deductionFor({
      shortfallNow: "3", allocationId: "b", claimedNow: "4", losses: { a: "3", b: "0" },
    })).toBe("0");
  });

  it("shows the whole gap to every strategy when nobody can say whose shares went", () => {
    // Both are asked about all 3; whoever the member answers first takes them.
    expect(deductionFor({ shortfallNow: "3", allocationId: "a", claimedNow: "6" })).toBe("3");
    expect(deductionFor({ shortfallNow: "3", allocationId: "b", claimedNow: "4" })).toBe("3");
  });

  it("covers the others once the first strategy has taken the gap", () => {
    // a took 3, so the account is whole again and b is asked for nothing.
    expect(deductionFor({ shortfallNow: "0", allocationId: "b", claimedNow: "4" })).toBe("0");
  });

  it("never takes more than the strategy holds", () => {
    expect(deductionFor({ shortfallNow: "9", allocationId: "b", claimedNow: "4" })).toBe("4");
  });
});
