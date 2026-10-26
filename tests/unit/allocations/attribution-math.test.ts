import { describe, expect, it } from "vitest";

import {
  deriveRobinhoodAttributionAmounts,
  splitReinvestedShares,
} from "../../../src/main/allocations/attribution-math";
describe("Robinhood strategy attribution", () => {
  it("attributes an equity buy as positive quantity and negative cash", () => {
    expect(deriveRobinhoodAttributionAmounts({
      assetClass: "equity",
      side: "buy",
      quantity: "1.25",
      price: "201.12",
      notionalAmount: null,
      feeAmount: "0.01",
    })).toEqual({
      quantityDelta: "1.25",
      cashDelta: "-251.4",
      feeCashDelta: "-0.01",
    });
  });

  it("trusts provider notional for an equity sell without floating point math", () => {
    expect(deriveRobinhoodAttributionAmounts({
      assetClass: "equity",
      side: "sell",
      quantity: "0.333333333333333333",
      price: "300.000000000000000000",
      notionalAmount: "99.999999999999999900",
      feeAmount: null,
    })).toEqual({
      quantityDelta: "-0.333333333333333333",
      cashDelta: "99.9999999999999999",
      feeCashDelta: null,
    });
  });

  it("fails closed for option or directionally ambiguous executions", () => {
    expect(deriveRobinhoodAttributionAmounts({
      assetClass: "option",
      side: "buy",
      quantity: "1",
      price: "2.5",
      notionalAmount: "250",
      feeAmount: null,
    })).toBeNull();
    expect(deriveRobinhoodAttributionAmounts({
      assetClass: "equity",
      side: null,
      quantity: "1",
      price: "2.5",
      notionalAmount: null,
      feeAmount: null,
    })).toBeNull();
  });

});

describe("splitReinvestedShares", () => {
  it("gives a allocation that held the whole position the whole reinvestment", () => {
    expect(splitReinvestedShares({
      quantity: "0.007562",
      claims: [{ allocationId: "b1", attributedQuantity: "1.997974" }],
      heldQuantity: "1.997974",
    })).toEqual([{ allocationId: "b1", quantity: "0.007562" }]);
  });

  it("splits between allocations by their claims and leaves the member's share out", () => {
    // Two allocations hold 1 and 3 of 8 shares; the member holds the other 4.
    const shares = splitReinvestedShares({
      quantity: "0.008",
      claims: [{ allocationId: "small", attributedQuantity: "1" }, { allocationId: "big", attributedQuantity: "3" }],
      heldQuantity: "8",
    });
    expect(shares).toEqual([
      { allocationId: "big", quantity: "0.003" },
      { allocationId: "small", quantity: "0.001" },
    ]);
  });

  it("places the odd millionths by largest remainder so the parts sum to the whole", () => {
    // 5 millionths over claims of 2 and 1: 3.33 and 1.67, so the odd one goes
    // to the claim that was rounded down the most.
    const shares = splitReinvestedShares({
      quantity: "0.000005",
      claims: [{ allocationId: "a", attributedQuantity: "2" }, { allocationId: "b", attributedQuantity: "1" }],
      heldQuantity: "3",
    });
    expect(shares).toEqual([{ allocationId: "a", quantity: "0.000003" }, { allocationId: "b", quantity: "0.000002" }]);
  });
});


it('refuses entitlement holdings below claims instead of allocating personal dividends', () => {
 expect(() => splitReinvestedShares({quantity:'1',claims:[{allocationId:'a',attributedQuantity:'10'}],heldQuantity:'5'})).toThrow('Entitlement holdings');
});
