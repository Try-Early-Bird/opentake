import { describe, expect, it } from "vitest";

import {
  deriveAllocationPnl,
  subtractDecimalStrings,
  unrealizedFor,
} from "../../../src/main/allocations/allocation-pnl";

describe("allocation P&L from the attribution ledger", () => {
  const entries = [
    { sequence: 1, entryType: "capital_allocated", symbol: null, quantityDelta: null, cashDelta: "5000" },
    { sequence: 2, entryType: "fill", symbol: "AAPL", quantityDelta: "10", cashDelta: "-2000" },
    { sequence: 3, entryType: "fee", symbol: null, quantityDelta: null, cashDelta: "-0.5" },
    { sequence: 4, entryType: "fill", symbol: "AAPL", quantityDelta: "10", cashDelta: "-2200" },
    { sequence: 5, entryType: "fill", symbol: "AAPL", quantityDelta: "-5", cashDelta: "1150" },
    { sequence: 6, entryType: "fill", symbol: "NVDA", quantityDelta: "8", cashDelta: "-1600" },
  ];

  it("tracks moving-average cost basis and realizes sells against it", () => {
    const pnl = deriveAllocationPnl(entries);
    expect(pnl.capitalAllocated).toBe("5000");
    expect(pnl.fees).toBe("0.5");
    // 20 AAPL cost 4200 (avg 210); selling 5 at 230 realizes 5 × 20 = 100.
    expect(pnl.bySymbol.get("AAPL")).toEqual({
      quantity: "15",
      costBasis: "3150",
      realized: "100",
    });
    expect(pnl.bySymbol.get("NVDA")).toEqual({
      quantity: "8",
      costBasis: "1600",
      realized: "0",
    });
    expect(pnl.realizedNet).toBe("99.5");
  });

  it("derives unrealized from current value and leaves the provider residual exact", () => {
    const pnl = deriveAllocationPnl(entries);
    const aapl = pnl.bySymbol.get("AAPL")!;
    // 15 shares marked at 240 = 3600 against a 3150 basis.
    expect(unrealizedFor(aapl, "3600")).toBe("450");
    // Robinhood reports the whole 20-share position (15 strategy + 5 self
    // directed) at +520; the member's own shares account for the rest.
    expect(subtractDecimalStrings("520", "450")).toBe("70");
  });

  it("ignores order of arrival and zeroes basis on a full exit", () => {
    const pnl = deriveAllocationPnl([
      { sequence: 2, entryType: "fill", symbol: "MSFT", quantityDelta: "-4", cashDelta: "1700" },
      { sequence: 1, entryType: "fill", symbol: "MSFT", quantityDelta: "4", cashDelta: "-1640" },
    ]);
    expect(pnl.bySymbol.get("MSFT")).toEqual({ quantity: "0", costBasis: "0", realized: "60" });
  });
});

describe("share counts that change without a sale", () => {
  const bought = [
    { sequence: 1, entryType: "capital_allocated", symbol: null, quantityDelta: null, cashDelta: "1000" },
    { sequence: 2, entryType: "fill", symbol: "NFLX", quantityDelta: "10", cashDelta: "-1000" },
  ];

  it("a split moves the quantity and leaves the cost, so nothing is realized", () => {
    // 10-for-1: 10 shares at 100 become 100 shares at 10.
    const pnl = deriveAllocationPnl([
      ...bought,
      { sequence: 3, entryType: "corporate_action", symbol: "NFLX", quantityDelta: "90", cashDelta: null },
    ]);
    expect(pnl.bySymbol.get("NFLX")).toEqual({ quantity: "100", costBasis: "1000", realized: "0" });
    expect(pnl.realizedNet).toBe("0");
  });

  it("a reverse split does not book the holding as a loss", () => {
    // 1-for-5: 10 shares become 2, with the same money in them. Booking the
    // lost shares as a sale at no proceeds would have realized -800.
    const pnl = deriveAllocationPnl([
      ...bought,
      { sequence: 3, entryType: "corporate_action", symbol: "NFLX", quantityDelta: "-8", cashDelta: null },
    ]);
    expect(pnl.bySymbol.get("NFLX")).toEqual({ quantity: "2", costBasis: "1000", realized: "0" });
    expect(pnl.realizedNet).toBe("0");
  });

  it("a release takes the shares' cost with them and realizes nothing", () => {
    const pnl = deriveAllocationPnl([
      ...bought,
      { sequence: 3, entryType: "detachment", symbol: "NFLX", quantityDelta: "-4", cashDelta: null },
    ]);
    expect(pnl.bySymbol.get("NFLX")).toEqual({ quantity: "6", costBasis: "600", realized: "0" });
    expect(pnl.realizedNet).toBe("0");
  });

  it("still realizes on a sale, so the sale path is untouched", () => {
    const pnl = deriveAllocationPnl([
      ...bought,
      { sequence: 3, entryType: "fill", symbol: "NFLX", quantityDelta: "-5", cashDelta: "600" },
    ]);
    expect(pnl.bySymbol.get("NFLX")).toEqual({ quantity: "5", costBasis: "500", realized: "100" });
  });
});
