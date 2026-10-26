import { describe, expect, it } from "vitest";

import {
  normalizeEquityHistoricals,
  normalizeEquityQuoteDetails,
} from "../../../src/main/market-series/normalization";

describe("normalizeEquityHistoricals", () => {
  const payload = {
    data: {
      results: [
        {
          symbol: "GOOG",
          interval: "5minute",
          bounds: "24_5",
          bars: [
            {
              begins_at: "2026-08-27T13:30:00Z",
              open_price: "339.895000",
              close_price: "341.280000",
              high_price: "342.390000",
              low_price: "337.520000",
              volume: 14254267,
              session: "reg",
            },
            {
              begins_at: "2026-08-27T13:35:00Z",
              open_price: "341.280000",
              close_price: "341.000000",
              high_price: "341.500000",
              low_price: "340.900000",
              volume: 100,
              session: "reg",
              interpolated: true,
            },
            {
              begins_at: "2026-08-27T20:05:00Z",
              open_price: "341.000000",
              close_price: "341.100000",
              // High below open: clamped so the storage check holds.
              high_price: "340.000000",
              low_price: "340.500000",
              volume: 10,
              session: "post",
            },
            {
              begins_at: "2026-08-27T13:30:00Z", // duplicate timestamp: last wins
              open_price: "339.9",
              close_price: "341.3",
              high_price: "342.4",
              low_price: "337.5",
              volume: 14254268,
              session: "reg",
            },
          ],
        },
      ],
    },
    guide: "…",
  };

  it("drops interpolated bars, dedupes, sorts, and tags sessions", () => {
    const bars = normalizeEquityHistoricals(payload).get("GOOG");
    expect(bars).toHaveLength(2);
    expect(bars?.[0]).toMatchObject({
      beginsAt: "2026-08-27T13:30:00.000Z",
      close: "341.3",
      volume: "14254268",
      session: "regular",
    });
    expect(bars?.[1]).toMatchObject({
      beginsAt: "2026-08-27T20:05:00.000Z",
      session: "post",
      high: "341.1",
      low: "340.500000",
    });
  });

  it("keeps interpolated bars, flagged, when asked", () => {
    const bars = normalizeEquityHistoricals(payload, { keepInterpolated: true }).get("GOOG");
    expect(bars).toHaveLength(3);
    expect(bars?.[1]).toMatchObject({
      beginsAt: "2026-08-27T13:35:00.000Z",
      close: "341.000000",
      session: "regular",
      interpolated: true,
    });
    expect(bars?.[0]).not.toHaveProperty("interpolated");
  });

  it("classifies the session from the clock when the tag is missing", () => {
    const bars = normalizeEquityHistoricals({
      results: [{
        symbol: "nu",
        bars: [{ begins_at: "2026-08-28T02:00:00Z", open_price: "1", close_price: "1", high_price: "1", low_price: "1", volume: 0 }],
      }],
    });
    expect(bars.get("NU")?.[0]?.session).toBe("overnight");
  });

  it("ignores malformed payloads", () => {
    expect(normalizeEquityHistoricals(null).size).toBe(0);
    expect(normalizeEquityHistoricals({ data: { results: [{ symbol: "X", bars: "nope" }] } }).size).toBe(0);
  });
});

describe("normalizeEquityQuoteDetails", () => {
  it("reads the quote/close pair without letting the close overwrite the price", () => {
    const details = normalizeEquityQuoteDetails({
      data: {
        results: [
          {
            quote: {
              symbol: "AAPL",
              last_trade_price: "227.160000",
              venue_last_trade_time: "2026-08-27T19:59:59Z",
              last_non_reg_trade_price: "227.900000",
              venue_last_non_reg_trade_time: "2026-08-27T21:15:00Z",
              previous_close: "225.000000",
              adjusted_previous_close: "225.000000",
              previous_close_date: "2026-08-26",
            },
            close: { symbol: "AAPL", date: "2026-08-26", price: "225.010000", interpolated: false, source: "sip-list-exchange-close" },
          },
        ],
      },
    });
    expect(details.get("AAPL")).toEqual({
      symbol: "AAPL",
      lastTradePrice: "227.160000",
      lastTradeAt: "2026-08-27T19:59:59.000Z",
      lastExtendedTradePrice: "227.900000",
      lastExtendedTradeAt: "2026-08-27T21:15:00.000Z",
      previousClose: "225.010000",
      previousCloseDate: "2026-08-26",
      // How the provider settled it, kept so a mark can say where it came from.
      previousCloseSource: "sip-list-exchange-close",
      previousCloseInterpolated: false,
    });
  });

  it("accepts flat quote records when closes are dropped", () => {
    const details = normalizeEquityQuoteDetails({
      quotes: [{ symbol: "NVDA", last_trade_price: "181.60", previous_close: "184.00" }],
    });
    expect(details.get("NVDA")).toMatchObject({ lastTradePrice: "181.60", previousClose: "184.00" });
  });
});
