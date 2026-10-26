import { describe, expect, it } from "vitest";

import {
  hashRobinhoodSnapshot,
  normalizeRobinhoodPortfolio,
  normalizeRobinhoodPositionPage,
} from "../../src/main/account-sync/snapshot-normalization";

describe("Robinhood portfolio and position snapshot normalization", () => {
  it("normalizes the provider-observed portfolio and asset components", () => {
    const portfolio = normalizeRobinhoodPortfolio({
      portfolio: {
        total_value: "12500.25",
        equity_value: "10000.25",
        options_value: "500.00",
        cash: "2000.00",
        pending_deposits: "25.00",
        buying_power: "4000.00",
        account_number: "should-never-be-persisted",
      },
    });
    expect(portfolio.providerPayload).not.toHaveProperty("account_number");

    expect(portfolio).toMatchObject({
      totalValue: "12500.25",
      cash: "2000.00",
      buyingPower: "4000.00",
      pendingDeposits: "25.00",
      currency: "USD",
      components: [
        { key: "equity_value", amount: "10000.25" },
        { key: "options_value", amount: "500.00" },
      ],
    });
  });

  it("reads buying power from the object Robinhood actually returns", () => {
    // The live get_portfolio shape: buying_power is an object, not a decimal.
    const live = {
      total_value: "101.218342085",
      equity_value: "26.188342085",
      cash: "75.03",
      pending_deposits: "0",
      currency: "USD",
      buying_power: { buying_power: "75.0300", unleveraged_buying_power: "75.0300", display_currency: "USD" },
      crypto_buying_power: { buying_power: "75.0300" },
    };
    const portfolio = normalizeRobinhoodPortfolio({ data: live });
    expect(portfolio.buyingPower).toBe("75.0300");
    // Kept as a scalar in the payload, so the change hash sees it.
    expect(portfolio.providerPayload.buying_power).toBe("75.0300");
  });

  it("stores a different snapshot when only the buying power differs", async () => {
    const base = { total_value: "100", cash: "50", currency: "USD" };
    const one = normalizeRobinhoodPortfolio({ ...base, buying_power: { buying_power: "50" } });
    const two = normalizeRobinhoodPortfolio({ ...base, buying_power: { buying_power: "150" } });
    expect(await hashRobinhoodSnapshot(one.providerPayload)).not.toBe(await hashRobinhoodSnapshot(two.providerPayload));
  });

  it("normalizes an equity page without inventing unavailable market values", () => {
    const page = normalizeRobinhoodPositionPage({
      results: [{
        id: "position-1",
        instrument_id: "instrument-1",
        symbol: "AAPL",
        quantity: "2.500000",
        average_buy_price: "195.25",
        shares_held_for_sells: "0.500000",
        account_number: "should-never-be-persisted",
      }],
      next: "https://agent.robinhood.com/positions?cursor=next-equities",
    }, "equity");

    expect(page.nextCursor).toBe("next-equities");
    expect(page.positions).toEqual([expect.objectContaining({
      positionKey: "robinhood:equity:AAPL",
      instrumentRef: "AAPL",
      symbol: "AAPL",
      side: "long",
      quantity: "2.500000",
      averageCost: "195.25",
      heldQuantity: "0.500000",
      marketValue: null,
    })]);
    expect(page.positions[0]?.providerPayload).not.toHaveProperty("account_number");
  });

  it("normalizes option identifiers, direction, and provider multipliers", () => {
    const page = normalizeRobinhoodPositionPage({
      data: [{
        id: "position-2",
        option_id: "option-1",
        chain_symbol: "SPY",
        quantity: "-1",
        average_price: "2.50",
        contract_multiplier: "100",
        market_value: "-250.00",
        unrealized_pnl: "20.00",
      }],
      next_cursor: "next-options",
    }, "option");

    expect(page).toMatchObject({
      nextCursor: "next-options",
      positions: [
        {
          positionKey: "robinhood:option:option-1",
          instrumentRef: "option-1",
          symbol: "SPY",
          side: "short",
          quantity: "-1",
          contractMultiplier: "100",
          marketValue: "-250.00",
          providerUnrealizedPnl: "20.00",
        },
      ],
    });
  });

  it("fails closed on unusable snapshots and unsafe floating-point quantities", () => {
    expect(() => normalizeRobinhoodPortfolio({ total_value: 12.25 })).toThrow(
      "total_value",
    );
    expect(() => normalizeRobinhoodPositionPage({
      results: [{ instrument_id: "instrument-1", symbol: "AAPL", quantity: 1.25 }],
    }, "equity")).toThrow("quantity is invalid");
    expect(() => normalizeRobinhoodPositionPage({ unexpected: true }, "equity")).toThrow(
      "malformed",
    );
  });

  it("hashes equivalent key order deterministically", async () => {
    await expect(hashRobinhoodSnapshot({ a: 1, b: { c: 2 } })).resolves.toBe(
      await hashRobinhoodSnapshot({ b: { c: 2 }, a: 1 }),
    );
  });
});
