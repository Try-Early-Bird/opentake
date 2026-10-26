import { describe, expect, it } from "vitest";

import {
  correctionImproves,
  driftPercent,
  driftValueUsd,
  measureDrift,
  targetPositionsAtCloses,
  positionsAtCloses,
  projectPositionsAfterOrders,
} from "../../../src/main/allocations/drift";

const target = {
  positions: [
    { symbol: "AAPL", valueUsd: "600" },
    { symbol: "MSFT", valueUsd: "300" },
  ],
  cashUsd: "100",
};

describe("measureDrift", () => {
  it("is zero for a allocation holding the target's weights at any size", () => {
    const measure = measureDrift({
      allocated: {
        positions: [
          { symbol: "AAPL", valueUsd: "60" },
          { symbol: "MSFT", valueUsd: "30" },
        ],
        cashUsd: "10",
      },
      target,
    });
    expect(measure.totalBps).toBe(0);
    expect(measure.maxBps).toBe(0);
  });

  it("reads as the share of the allocation that would have to move", () => {
    // Ten points of the allocation sit in MSFT that belong in AAPL: moving that
    // ten points fixes both sides at once, so the measure is ten, not twenty.
    const measure = measureDrift({
      allocated: {
        positions: [
          { symbol: "AAPL", valueUsd: "500" },
          { symbol: "MSFT", valueUsd: "400" },
        ],
        cashUsd: "100",
      },
      target,
    });
    expect(measure.totalBps).toBe(1_000);
    expect(driftPercent(measure.totalBps)).toBe(10);
    expect(measure.maxSymbol).toBe("AAPL");
    expect(measure.maxBps).toBe(1_000);
    expect(driftValueUsd(measure.totalBps, "1000")).toBe("100");
  });

  it("counts a holding the allocation never bought in full", () => {
    const measure = measureDrift({
      allocated: { positions: [{ symbol: "AAPL", valueUsd: "900" }], cashUsd: "100" },
      target,
    });
    // MSFT is 30 points missing; AAPL is 30 points too large; cash matches.
    expect(measure.totalBps).toBe(3_000);
    expect(measure.symbols[0]?.symbol).toBe("AAPL");
    expect(measure.symbols.map((entry) => entry.symbol).sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("treats uninvested cash as drift, because the strategy is not in cash", () => {
    const measure = measureDrift({
      allocated: { positions: [], cashUsd: "1000" },
      target,
    });
    // The whole allocation would have to move: 90 points into holdings.
    expect(measure.totalBps).toBe(9_000);
    expect(measure.maxSymbol).toBe("CASH");
    expect(measure.cash.differenceBps).toBe(9_000);
  });

  it("is zero-valued rather than misleading when a side is empty", () => {
    const measure = measureDrift({
      allocated: { positions: [], cashUsd: "0" },
      target,
    });
    expect(measure).toMatchObject({ totalBps: 0, maxSymbol: null, symbols: [] });
  });

  it("does not move when the same allocation is simply larger", () => {
    // Drift is a measure of shape, not of size: a allocation ten times the size
    // holding the same mix is the same distance from the strategy.
    const drifted = {
      positions: [
        { symbol: "AAPL", valueUsd: "500" },
        { symbol: "MSFT", valueUsd: "400" },
      ],
      cashUsd: "100",
    };
    const scale = (side: typeof drifted, factor: number) => ({
      positions: side.positions.map((position) => ({
        symbol: position.symbol,
        valueUsd: String(Number(position.valueUsd) * factor),
      })),
      cashUsd: String(Number(side.cashUsd) * factor),
    });
    const small = measureDrift({ allocated: drifted, target });
    const large = measureDrift({ allocated: scale(drifted, 10), target: scale(target, 3) });
    expect(large.totalBps).toBe(small.totalBps);
    expect(large.maxSymbol).toBe(small.maxSymbol);
  });
});

describe("positionsAtCloses", () => {
  it("values share counts at the target's closes, so both sides share marks", () => {
    const priced = positionsAtCloses(
      new Map([["AAPL", { quantity: "2", markPriceUsd: "999" }]]),
      { AAPL: "100" },
    );
    expect(priced.positions).toEqual([{ symbol: "AAPL", valueUsd: "200" }]);
    expect(priced.unpriced).toEqual([]);
  });

  it("falls back to the snapshot's own mark for a holding the target does not price", () => {
    const priced = positionsAtCloses(
      new Map([["SPY", { quantity: "3", markPriceUsd: "50" }]]),
      { AAPL: "100" },
    );
    expect(priced.positions).toEqual([{ symbol: "SPY", valueUsd: "150" }]);
  });

  it("reports a holding neither side can price rather than valuing it at zero", () => {
    const priced = positionsAtCloses(new Map([["XYZ", { quantity: "3" }]]), {});
    expect(priced.positions).toEqual([]);
    expect(priced.unpriced).toEqual(["XYZ"]);
  });

  it("values the target from its own units and closes", () => {
    const priced = targetPositionsAtCloses({ AAPL: "6", MSFT: "3" }, { AAPL: "100", MSFT: "100" });
    expect(priced.positions).toEqual([
      { symbol: "AAPL", valueUsd: "600" },
      { symbol: "MSFT", valueUsd: "300" },
    ]);
  });
});

// The correction gate's arithmetic: what the orders would leave, and whether that is closer.
describe("projectPositionsAfterOrders", () => {
  const closes = { AAPL: "10", NVDA: "5" };

  it("moves dollars from cash into shares at the mark, and back", () => {
    const projected = projectPositionsAfterOrders({
      positions: new Map([["AAPL", { quantity: "10", markPriceUsd: "10" }]]),
      cashUsd: "50",
      orders: [
        { symbol: "AAPL", side: "sell", quantity: "2" },
        { symbol: "NVDA", side: "buy", dollarAmount: "30" },
      ],
      marks: closes,
    });
    expect(projected.unpriced).toEqual([]);
    expect(projected.positions.get("AAPL")?.quantity).toBe("8");
    expect(projected.positions.get("NVDA")?.quantity).toBe("6");
    // 50 + 20 from the sell − 30 for the buy.
    expect(projected.cashUsd).toBe("40");
  });

  it("never sells more than is held, and drops a position sold out", () => {
    const projected = projectPositionsAfterOrders({
      positions: new Map([["AAPL", { quantity: "1", markPriceUsd: "10" }]]),
      cashUsd: "0",
      orders: [{ symbol: "AAPL", side: "sell", quantity: "3" }],
    });
    expect(projected.positions.has("AAPL")).toBe(false);
    expect(projected.cashUsd).toBe("10");
  });

  it("names a buy it cannot price rather than guessing", () => {
    const projected = projectPositionsAfterOrders({
      positions: new Map(),
      cashUsd: "100",
      orders: [{ symbol: "ZZNEW", side: "buy", dollarAmount: "10" }],
    });
    expect(projected.unpriced).toEqual(["ZZNEW"]);
    expect(projected.cashUsd).toBe("100");
  });
});

describe("correctionImproves", () => {
  // The target is 60/30 with 10% cash. The allocation is overweight AAPL and
  // holds no NVDA at all; the NVDA buy is what a small sleeve loses to the
  // provider minimum.
  const targetClose = { AAPL: "10", NVDA: "10" };
  const targetSide = { positions: [{ symbol: "AAPL", valueUsd: "60" }, { symbol: "NVDA", valueUsd: "30" }], cashUsd: "10" };
  const allocation = { positions: new Map([["AAPL", { quantity: "9", markPriceUsd: "10" }]]), cashUsd: "10" };
  const before = measureDrift({
    allocated: { positions: positionsAtCloses(allocation.positions, targetClose).positions, cashUsd: allocation.cashUsd },
    target: targetSide,
  });

  const after = (orders: Parameters<typeof projectPositionsAfterOrders>[0]["orders"]) => {
    const projected = projectPositionsAfterOrders({ ...allocation, orders, marks: targetClose });
    return measureDrift({
      allocated: { positions: positionsAtCloses(projected.positions, targetClose).positions, cashUsd: projected.cashUsd },
      target: targetSide,
    });
  };

  it("passes the whole set: sell the overweight, buy the missing sleeve", () => {
    const whole = after([
      { symbol: "AAPL", side: "sell", quantity: "3" },
      { symbol: "NVDA", side: "buy", dollarAmount: "30" },
    ]);
    expect(correctionImproves(before, whole)).toBe(true);
    expect(whole.totalBps).toBe(0);
  });

  it("refuses the executable half that only raises cash", () => {
    // With the NVDA buy skipped, the sell turns AAPL into cash the target does
    // not hold: the allocation ends no closer, and an order would be placed for
    // nothing.
    const half = after([{ symbol: "AAPL", side: "sell", quantity: "3" }]);
    expect(half.totalBps).toBe(before.totalBps);
    expect(correctionImproves(before, half)).toBe(false);
  });

  it("refuses an order that moves nothing measurable, or only by rounding", () => {
    expect(correctionImproves({ totalBps: 120 }, { totalBps: 120 })).toBe(false);
    expect(correctionImproves({ totalBps: 120 }, { totalBps: 119 })).toBe(false);
    expect(correctionImproves({ totalBps: 120 }, { totalBps: 116 })).toBe(false);
    expect(correctionImproves({ totalBps: 120 }, { totalBps: 115 })).toBe(true);
  });
});

// The correction gate, rebuilt from
// the e2e basket on 2026-09-24: a target of AMZN 50 / NVDA 40 / TSLA 10 and no
// cash, a allocation overweight TSLA and short NVDA, with too little cash for the
// NVDA buy. Selling TSLA alone turns shares into cash the target does not
// hold, so the executable set does not bring the allocation closer and is held;
// once the buy can go with it, the pair does and is placed.
describe("correction gate", () => {
  const target = { positions: [{ symbol: "AMZN", valueUsd: "50" }, { symbol: "NVDA", valueUsd: "40" }, { symbol: "TSLA", valueUsd: "10" }], cashUsd: "0" };
  const positions = new Map([
    ["AMZN", { quantity: "0.14", markPriceUsd: "220" }], // $30.80
    ["NVDA", { quantity: "0.12", markPriceUsd: "190" }], // $22.80
    ["TSLA", { quantity: "0.02", markPriceUsd: "400" }], // $8.00
  ]);
  const allocated = (after: ReturnType<typeof projectPositionsAfterOrders>) => ({
    positions: positionsAtCloses(after.positions, {}).positions,
    cashUsd: after.cashUsd,
  });
  const before = measureDrift({ allocated: { positions: positionsAtCloses(positions, {}).positions, cashUsd: "0" }, target });

  it("holds a sell-only set that only moves drift into cash", () => {
    const sellOnly = projectPositionsAfterOrders({
      positions,
      cashUsd: "0",
      orders: [{ symbol: "TSLA", side: "sell", quantity: "0.0038" }],
    });
    const after = measureDrift({ allocated: allocated(sellOnly), target });
    expect(correctionImproves(before, after)).toBe(false);
  });

  it("places the sell once the buy it funds can go with it", () => {
    const pair = projectPositionsAfterOrders({
      positions,
      cashUsd: "0",
      orders: [
        { symbol: "TSLA", side: "sell", quantity: "0.0038" },
        { symbol: "NVDA", side: "buy", dollarAmount: "1.52" },
      ],
    });
    const after = measureDrift({ allocated: allocated(pair), target });
    expect(correctionImproves(before, after)).toBe(true);
  });

  it("measures against published weights with no prices, as right after a publish", () => {
    // Weights as values: the measure is shares of each side's total, so a
    // target of plain percentages is the same target as one at any prices.
    const atPrices = measureDrift({ allocated: { positions: positionsAtCloses(positions, {}).positions, cashUsd: "0" }, target: {
      positions: [{ symbol: "AMZN", valueUsd: "30.8" }, { symbol: "NVDA", valueUsd: "24.64" }, { symbol: "TSLA", valueUsd: "6.16" }], cashUsd: "0" } });
    expect(atPrices.totalBps).toBe(before.totalBps);
  });
});
