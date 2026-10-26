import { describe, expect, it } from "vitest";

import { deriveAllocationValuation } from "../../../src/main/allocations/allocation-valuation";

describe("strategy allocation valuation", () => {
  it("values only attributed shares using an account-consistent snapshot", () => {
    const valuation = deriveAllocationValuation({
      cashUsd: "100",
      positions: [
        { symbol: "AAPL", quantity: "2" },
        { symbol: "MSFT", quantity: "0" },
      ],
      snapshot: [
        { instrumentRef: "aapl-ref", symbol: "AAPL", quantity: "10", markPrice: "200", marketValue: "2000" },
        { instrumentRef: "msft-ref", symbol: "MSFT", quantity: "5", markPrice: "400", marketValue: "2000" },
      ],
    });
    expect(valuation).toMatchObject({
      ready: true,
      cashUsd: "100",
      allocationValueUsd: "500",
    });
    if (!valuation.ready) throw new Error("expected a ready valuation");
    expect([...valuation.positions.keys()]).toEqual(["AAPL"]);
    expect(valuation.positions.get("AAPL")).toEqual({
      quantity: "2",
      valueUsd: "400",
      markPriceUsd: "200",
    });
  });

  it("derives a mark from provider quantity and market value", () => {
    const valuation = deriveAllocationValuation({
      cashUsd: "0",
      positions: [{ symbol: "AAPL", quantity: "1" }],
      snapshot: [
        { instrumentRef: "aapl-ref", symbol: "AAPL", quantity: "4", markPrice: null, marketValue: "800" },
      ],
    });
    if (!valuation.ready) throw new Error("expected a ready valuation");
    expect(valuation.positions.get("AAPL")?.markPriceUsd).toBe("200");
    expect(valuation.allocationValueUsd).toBe("200");
  });

  it("defers when any attributed position cannot be valued", () => {
    expect(deriveAllocationValuation({
      cashUsd: "50",
      positions: [{ symbol: "AAPL", quantity: "1" }],
      snapshot: [],
    })).toEqual({ ready: false, reason: "missing_position_valuation" });
    expect(deriveAllocationValuation({
      cashUsd: "-1",
      positions: [],
      snapshot: [],
    })).toEqual({ ready: false, reason: "negative_subledger_balance" });
  });
});

// A ledger a few cents under zero is slippage from a sell-funded buy, not a
// hole (the e2e basket, 2026-09-28): read as zero within the tolerance,
// refused beyond it.
describe("deriveAllocationValuation with a slightly negative ledger", () => {
  it("reads a cent or two under zero as zero cash", () => {
    const valuation = deriveAllocationValuation({ cashUsd: "-0.012", positions: [], snapshot: [] });
    expect(valuation.ready).toBe(true);
    if (valuation.ready) expect(valuation.cashUsd).toBe("0");
  });

  it("still refuses a ledger that is really short", () => {
    const valuation = deriveAllocationValuation({ cashUsd: "-1.54", positions: [], snapshot: [] });
    expect(valuation).toMatchObject({ ready: false, reason: "negative_subledger_balance" });
  });
});

describe('explicit instrument valuation', () => {
  const equity = {instrumentRef:'equity-btc',symbol:'BTC',quantity:'2',markPrice:'30',marketValue:'60'};
  const crypto = {instrumentRef:'crypto-btc',symbol:'BTC',quantity:'0.001',markPrice:'90000',marketValue:'90'};
  it('keeps same-ticker holdings separate by exact reference', () => {
    const result = deriveAllocationValuation({cashUsd:'10',positions:[
      {instrumentRef:equity.instrumentRef,symbol:'BTC',quantity:'2'},
      {instrumentRef:crypto.instrumentRef,symbol:'BTC',quantity:'0.001'},
    ],snapshot:[crypto,equity]});
    expect(result).toMatchObject({ready:true,allocationValueUsd:'160'});
    if(!result.ready) throw new Error('Expected valuation');
    expect(result.positions.get('equity-btc')?.valueUsd).toBe('60');
    expect(result.positions.get('crypto-btc')?.valueUsd).toBe('90');
  });
  it('refuses missing references, duplicate observations and ambiguous legacy tickers', () => {
    for(const input of [
      {positions:[{instrumentRef:'other',symbol:'BTC',quantity:'1'}],snapshot:[equity]},
      {positions:[{symbol:'BTC',quantity:'1'}],snapshot:[equity,crypto]},
      {positions:[{instrumentRef:crypto.instrumentRef,symbol:'BTC',quantity:'1'}],snapshot:[crypto,crypto]},
    ]) expect(deriveAllocationValuation({cashUsd:'0',...input})).toEqual({ready:false,reason:'missing_position_valuation'});
  });
  it('does not value holdings at a formatted zero mark', () => {
    expect(deriveAllocationValuation({cashUsd:'0',positions:[{symbol:'BTC',quantity:'1'}],
      snapshot:[{...crypto,markPrice:'0.000',marketValue:null}]})).toEqual({ready:false,reason:'missing_position_valuation'});
  });
});
