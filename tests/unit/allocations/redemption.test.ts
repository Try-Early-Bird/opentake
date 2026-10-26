import { describe, expect, it } from "vitest";

import { planRedemption as plan, redemptionBand as band, redemptionSales as sales } from "../../../src/main/allocations/redemption";

// Original hosted fixtures used Robinhood's $1 minimum and 5% sell headroom.
const planRedemption = (value: string, holdings: Parameters<typeof plan>[1], options: Partial<Parameters<typeof plan>[2]> = {}) => plan(value, holdings, {minimumOrderNotionalUsd:'1', ...options});
const redemptionBand = (holdings: Parameters<typeof band>[0], options: Partial<Parameters<typeof band>[1]> = {}) => band(holdings, {minimumOrderNotionalUsd:'1', ...options});
const redemptionSales = (legs: Parameters<typeof sales>[0], holdings: Parameters<typeof sales>[1], options: Partial<Parameters<typeof sales>[2]> = {}) => sales(legs, holdings, {minimumOrderNotionalUsd:'1',sellHeadroomBps:500, ...options});

const even = [
  { symbol: "AAPL", valueUsd: "600" },
  { symbol: "MSFT", valueUsd: "390" },
  { symbol: "NVDA", valueUsd: "10" },
];

const sum = (legs: { notionalUsd: string }[]): number =>
  Number(legs.reduce((total, leg) => total + Number(leg.notionalUsd), 0).toFixed(2));

describe("redemptionBand", () => {
  it("floors and ceilings on the smallest holding, at both ends", () => {
    // NVDA is 1% of a $1,000 allocation, so anything under $100 cannot sell a
    // dollar of it, and the same $100 has to stay behind for what is left to
    // still hold NVDA: at most $900 comes out.
    expect(redemptionBand(even)).toMatchObject({ minimumUsd: "100", maximumUsd: "900", possible: true });
  });

  it("says no partial redemption is possible when the allocation cannot halve", () => {
    // A $150 allocation with a 1% sleeve: $100 has to come out at the least, and
    // $100 has to stay, so no amount works and closing is the honest answer.
    const small = [
      { symbol: "AAPL", valueUsd: "148.5" },
      { symbol: "NVDA", valueUsd: "1.5" },
    ];
    expect(redemptionBand(small)).toMatchObject({ possible: false });
  });

  it("lets a small investment reduce when its holdings are big enough shares", () => {
    // The flat floor used to refuse this outright; what matters is whether
    // what remains can still hold the strategy.
    const small = [
      { symbol: "QDTE", valueUsd: "59" },
    ];
    expect(redemptionBand(small)).toMatchObject({ minimumUsd: "1", maximumUsd: "58", possible: true });
  });

  it("is wider when every holding is a large share of the allocation", () => {
    const chunky = [
      { symbol: "AAPL", valueUsd: "500" },
      { symbol: "MSFT", valueUsd: "500" },
    ];
    expect(redemptionBand(chunky)).toMatchObject({ minimumUsd: "2", maximumUsd: "998", possible: true });
  });

  it("has nothing to say about an empty allocation", () => {
    expect(redemptionBand([])).toMatchObject({ possible: false, holdingsValueUsd: "0" });
  });
});

describe("planRedemption", () => {
  it("sells every holding in proportion, so the mix does not change", () => {
    const plan = planRedemption("200", even);
    expect(plan.ok).toBe(true);
    expect(plan.legs).toEqual([
      { symbol: "AAPL", notionalUsd: "120" },
      { symbol: "MSFT", notionalUsd: "78" },
      { symbol: "NVDA", notionalUsd: "2" },
    ]);
    expect(sum(plan.legs)).toBe(200);
    expect(plan.remainingValueUsd).toBe("800");
  });

  it("asks for exactly the gross amount when the split does not land on cents", () => {
    const plan = planRedemption("333.33", even);
    expect(sum(plan.legs)).toBe(333.33);
  });

  it("never sells more of a holding than the allocation owns", () => {
    const plan = planRedemption("800", even);
    for (const leg of plan.legs) {
      const holding = even.find((entry) => entry.symbol === leg.symbol)!;
      expect(Number(leg.notionalUsd)).toBeLessThanOrEqual(Number(holding.valueUsd));
    }
    expect(sum(plan.legs)).toBe(800);
  });

  it("refuses an amount below the band and names what would work", () => {
    const plan = planRedemption("50", even);
    expect(plan.ok).toBe(false);
    expect(plan.reasons).toEqual([{ code: "below_band", needed: "100" }]);
  });

  it("refuses an amount that would leave too little behind to hold the strategy", () => {
    const plan = planRedemption("950", even);
    expect(plan.ok).toBe(false);
    expect(plan.reasons).toEqual([{ code: "above_band", needed: "900" }]);
  });

  it("refuses outright when no amount could work", () => {
    // $100 would have to come out and $100 would have to stay, from $150.
    const plan = planRedemption("40", [
      { symbol: "AAPL", valueUsd: "148.5" },
      { symbol: "NVDA", valueUsd: "1.5" },
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.reasons).toEqual([{ code: "no_partial_redemption" }]);
    expect(plan.legs).toEqual([]);
  });
});

describe("redemptionSales", () => {
  const marks = new Map([
    ["AAPL", { markPriceUsd: "200", attributedQuantity: "3" }],
    ["MSFT", { markPriceUsd: "390", attributedQuantity: "1" }],
    ["NVDA", { markPriceUsd: "100", attributedQuantity: "0.1" }],
  ]);

  it("sells shares rather than dollars, so a price move cannot overshoot", () => {
    const { sales } = redemptionSales(
      [{ symbol: "AAPL", notionalUsd: "120" }, { symbol: "MSFT", notionalUsd: "78" }],
      marks,
    );
    expect(sales).toEqual([
      { symbol: "AAPL", quantity: "0.6", notionalUsd: "120" },
      { symbol: "MSFT", quantity: "0.2", notionalUsd: "78" },
    ]);
  });

  it("sizes a leg at the provider minimum up with headroom, so rounding and a dip cannot refuse it", () => {
    // $1.00 of AMZN at $222.48 floored to 0.004494 shares is $0.9998: the
    // order Robinhood refused on 2026-09-30. It goes out clearing $1.05.
    const amzn = new Map([["AMZN", { markPriceUsd: "222.48", attributedQuantity: "0.133485" }]]);
    const { sales } = redemptionSales([{ symbol: "AMZN", notionalUsd: "1" }], amzn);
    expect(sales).toHaveLength(1);
    expect(Number(sales[0]!.quantity) * 222.48).toBeGreaterThanOrEqual(1.05);
    expect(Number(sales[0]!.quantity)).toBeLessThan(0.0048);
    // Never past what the allocation owns.
    const tiny = new Map([["AMZN", { markPriceUsd: "222.48", attributedQuantity: "0.0046" }]]);
    expect(redemptionSales([{ symbol: "AMZN", notionalUsd: "1" }], tiny).sales[0]!.quantity).toBe("0.0046");
  });

  it("never sells more shares than the allocation is attributed", () => {
    const { sales } = redemptionSales([{ symbol: "NVDA", notionalUsd: "100" }], marks);
    // $100 at $100 a share is one share; the allocation only has a tenth.
    expect(sales).toEqual([{ symbol: "NVDA", quantity: "0.1", notionalUsd: "10" }]);
  });

  it("names holdings it cannot price rather than guessing", () => {
    const { sales, unpriced } = redemptionSales(
      [{ symbol: "TSLA", notionalUsd: "50" }, { symbol: "AAPL", notionalUsd: "20" }],
      marks,
    );
    expect(unpriced).toEqual(["TSLA"]);
    expect(sales.map((sale) => sale.symbol)).toEqual(["AAPL"]);
  });

  it("drops a leg too small to be a whole unit of quantity", () => {
    const { sales } = redemptionSales(
      [{ symbol: "MSFT", notionalUsd: "0.0001" }],
      marks,
    );
    expect(sales).toEqual([]);
  });
});

// Selling unevenly when the proportional set is not executable (partial
// redemption, priority 4). The strategy's own
// weights are what make one uneven set better than another, so they have to
// be passed in for any of this to happen.
describe("planRedemption toward the target", () => {
  const targets = [
    { symbol: "AAPL", weightPercent: 60 },
    { symbol: "MSFT", weightPercent: 39 },
    { symbol: "NVDA", weightPercent: 1 },
  ];

  it("offers a reduction the proportional set could not", () => {
    // $150 with a 1% sleeve: proportionally, $100 must come out and $100 must
    // stay, so nothing works. NVDA simply is not sold.
    const holdings = [
      { symbol: "AAPL", valueUsd: "148.5" },
      { symbol: "NVDA", valueUsd: "1.5" },
    ];
    const both = [{ symbol: "AAPL", weightPercent: 99 }, { symbol: "NVDA", weightPercent: 1 }];
    expect(redemptionBand(holdings)).toMatchObject({ possible: false });
    expect(redemptionBand(holdings, { targets: both })).toMatchObject({ possible: true, minimumUsd: "1" });

    const plan = planRedemption("50", holdings, { targets: both });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(50);
    expect(plan.legs.map((leg) => leg.symbol)).toEqual(["AAPL"]);
  });

  // A sleeve too small to sell is what makes the proportional set
  // unexecutable, which is when any of this runs at all. The allocation has also
  // drifted to 70/30 against an even target.
  const drifted = [
    { symbol: "AAPL", valueUsd: "700" },
    { symbol: "MSFT", valueUsd: "300" },
    { symbol: "ZDUS", valueUsd: "1.5" },
  ];
  const even50 = [
    { symbol: "AAPL", weightPercent: 50 },
    { symbol: "MSFT", weightPercent: 50 },
    { symbol: "ZDUS", weightPercent: 0 },
  ];

  it("takes the sells from whatever the allocation is overweight in", () => {
    expect(redemptionBand(drifted)).toMatchObject({ possible: false });
    // $200 of the $299.25 AAPL is overweight by, so MSFT is not touched and
    // the allocation ends closer to even than it started.
    const plan = planRedemption("200", drifted, { targets: even50 });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(200);
    expect(plan.legs).toEqual([{ symbol: "AAPL", notionalUsd: "200" }]);
  });

  it("sells into the rest once the overweight is spent", () => {
    // $600 out of $1,001.50 leaves $401.50, so $200.75 should remain in each
    // of the two: AAPL gives up $500 and MSFT $100, and the dust is left.
    const plan = planRedemption("600", drifted, { targets: even50 });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(600);
    expect(plan.legs).toEqual([
      { symbol: "AAPL", notionalUsd: "500" },
      { symbol: "MSFT", notionalUsd: "100" },
    ]);
  });

  it("still sells in proportion when the proportional set works", () => {
    // The first priority is the requested gross through a set that keeps the
    // mix, so passing targets must not change the ordinary case.
    expect(planRedemption("200", even, { targets }).legs)
      .toEqual(planRedemption("200", even).legs);
  });

  it("never leaves a holding as dust it could not trade again", () => {
    const holdings = [
      { symbol: "AAPL", valueUsd: "100" },
      { symbol: "MSFT", valueUsd: "1.4" },
    ];
    const both = [{ symbol: "AAPL", weightPercent: 99 }, { symbol: "MSFT", weightPercent: 1 }];
    const plan = planRedemption("90", holdings, { targets: both });
    expect(plan.ok).toBe(true);
    // MSFT cannot sell a minimum and keep one, so it is left alone entirely.
    expect(plan.legs).toEqual([{ symbol: "AAPL", notionalUsd: "90" }]);
    // And AAPL keeps at least one minimum order behind.
    expect(Number(plan.legs[0]!.notionalUsd)).toBeLessThanOrEqual(99);
  });

  it("conserves the requested gross to the cent across uneven legs", () => {
    const holdings = [
      { symbol: "AAPL", valueUsd: "333.33" },
      { symbol: "MSFT", valueUsd: "333.33" },
      { symbol: "NVDA", valueUsd: "333.34" },
    ];
    const thirds = [
      { symbol: "AAPL", weightPercent: 33 },
      { symbol: "MSFT", weightPercent: 33 },
      { symbol: "NVDA", weightPercent: 34 },
    ];
    const plan = planRedemption("100.01", holdings, { targets: thirds });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(100.01);
    for (const leg of plan.legs) expect(Number(leg.notionalUsd)).toBeGreaterThanOrEqual(1);
  });

  it("says only closing remains when nothing can be sold", () => {
    const dust = [
      { symbol: "AAPL", valueUsd: "1.2" },
      { symbol: "MSFT", valueUsd: "1.2" },
    ];
    const both = [{ symbol: "AAPL", weightPercent: 50 }, { symbol: "MSFT", weightPercent: 50 }];
    const plan = planRedemption("1", dust, { targets: both });
    expect(plan.ok).toBe(false);
    expect(plan.reasons).toEqual([{ code: "no_partial_redemption" }]);
  });
});

// The weights are shares of the whole strategy; what a redemption
// redistributes is only the equity the allocation holds. Reading one as the other
// makes every holding look overweight by the strategy's cash.
describe("planRedemption against a strategy holding cash", () => {
  it("sells the overweight holding, not a little of each", () => {
    const holdings = [
      { symbol: "AAPL", valueUsd: "500" },
      { symbol: "MSFT", valueUsd: "500" },
      { symbol: "ZDUS", valueUsd: "1.5" },
    ];
    // Twice as much AAPL as MSFT is wanted, and a quarter of the strategy is
    // cash. The allocation holds them evenly, so MSFT is the overweight one and
    // AAPL is short: every dollar should come out of MSFT.
    const targets = [
      { symbol: "AAPL", weightPercent: 50 },
      { symbol: "MSFT", weightPercent: 25 },
      { symbol: "ZDUS", weightPercent: 0 },
    ];
    expect(redemptionBand(holdings)).toMatchObject({ possible: false });
    const plan = planRedemption("100", holdings, { targets });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(100);
    expect(plan.legs).toEqual([{ symbol: "MSFT", notionalUsd: "100" }]);
  });
});

describe("planRedemption chooses who takes part exactly", () => {
  it("finds the set a leg-by-leg retreat would have given up on", () => {
    // Two small sleeves whose surplus share is under a minimum each. Dropping
    // one of them leaves too little room for the amount, so a search that
    // retreats a leg at a time refuses; seating both at a minimum and taking
    // the rest from the large holding is the answer.
    const holdings = [
      { symbol: "AAPL", valueUsd: "11" },
      { symbol: "MSFT", valueUsd: "2" },
      { symbol: "NVDA", valueUsd: "2" },
      { symbol: "ZDUS", valueUsd: "1.5" },
    ];
    const thirds = [
      { symbol: "AAPL", weightPercent: 34 },
      { symbol: "MSFT", weightPercent: 33 },
      { symbol: "NVDA", weightPercent: 33 },
      { symbol: "ZDUS", weightPercent: 0 },
    ];
    expect(redemptionBand(holdings)).toMatchObject({ possible: false });
    const plan = planRedemption("11.5", holdings, { targets: thirds });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(11.5);
    expect(plan.legs).toEqual([
      { symbol: "AAPL", notionalUsd: "9.5" },
      { symbol: "MSFT", notionalUsd: "1" },
      { symbol: "NVDA", notionalUsd: "1" },
    ]);
  });

  it("seats no more holdings than the amount has minimum orders in it", () => {
    const holdings = [
      { symbol: "AAPL", valueUsd: "10" },
      { symbol: "MSFT", valueUsd: "10" },
      { symbol: "NVDA", valueUsd: "10" },
      { symbol: "ZDUS", valueUsd: "1.5" },
    ];
    const even = [
      { symbol: "AAPL", weightPercent: 33 },
      { symbol: "MSFT", weightPercent: 33 },
      { symbol: "NVDA", weightPercent: 34 },
      { symbol: "ZDUS", weightPercent: 0 },
    ];
    // $2.50 holds two minimum orders, not three, so one holding sits out and
    // neither leg is under a dollar.
    const plan = planRedemption("2.5", holdings, { targets: even });
    expect(plan.ok).toBe(true);
    expect(sum(plan.legs)).toBe(2.5);
    expect(plan.legs).toHaveLength(2);
    for (const leg of plan.legs) expect(Number(leg.notionalUsd)).toBeGreaterThanOrEqual(1);
  });
});

it('uses per-instrument crypto steps while conserving owned units',()=>{
 const result=redemptionSales([{symbol:'pair',notionalUsd:'5'}],new Map([['pair',{markPriceUsd:'90000',attributedQuantity:'0.0001',quantityIncrement:'0.00000001',minimumOrderNotionalUsd:'1'}]]));
 expect(result.sales[0].quantity).toBe('0.00005555');
 expect(Number(result.sales[0].quantity)).toBeLessThanOrEqual(0.0001);
});
