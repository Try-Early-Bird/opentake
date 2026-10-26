import { describe, expect, it } from "vitest";

import { classifyUnexplainedIncrease } from "../../../src/main/allocations/reinvestment-inference";

// The no-tag safety net for reinvested dividends: probable
// when the symbol pays, the shares can be valued, and cash fell by about
// their worth; otherwise merely unexplained.
describe("classifyUnexplainedIncrease", () => {
  const qdte = { symbol: "QDTE", increase: "0.007562", dividendYieldPercent: 38.1, markPriceUsd: "29.09" };

  it("calls the QDTE reinvestment probable from the cash fall alone", () => {
    expect(classifyUnexplainedIncrease({ ...qdte, cashChangeUsd: "-0.22" }))
      .toEqual({ verdict: "probable_reinvestment", worthUsd: "0.22" });
  });

  it("is unexplained when cash did not move with the shares", () => {
    expect(classifyUnexplainedIncrease({ ...qdte, cashChangeUsd: "0" }).verdict).toBe("unexplained");
    expect(classifyUnexplainedIncrease({ ...qdte, cashChangeUsd: "-5.00" }).verdict).toBe("unexplained");
  });

  it("is unexplained on a symbol that pays no dividend, or one it cannot value", () => {
    expect(classifyUnexplainedIncrease({ ...qdte, dividendYieldPercent: 0, cashChangeUsd: "-0.22" }).verdict).toBe("unexplained");
    expect(classifyUnexplainedIncrease({ ...qdte, dividendYieldPercent: null, cashChangeUsd: "-0.22" }).verdict).toBe("unexplained");
    expect(classifyUnexplainedIncrease({ ...qdte, markPriceUsd: null, cashChangeUsd: "-0.22" })).toEqual({ verdict: "unexplained", worthUsd: null });
  });

  it("allows a cent of rounding on a tiny reinvestment", () => {
    expect(classifyUnexplainedIncrease({ ...qdte, cashChangeUsd: "-0.21" }).verdict).toBe("probable_reinvestment");
  });
});
