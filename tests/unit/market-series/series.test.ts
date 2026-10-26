import { describe, expect, it } from "vitest";

import type { EquityBar } from "../../../src/main/market-series/normalization";
import { buildSymbolSeries, planFetchStart, seriesPlan } from "../../../src/main/market-series/series";

const MINUTE = 60 * 1_000;
const DAY = 24 * 60 * MINUTE;

function bar(beginsAt: string, close: number, session: EquityBar["session"]): EquityBar {
  const price = close.toFixed(2);
  return { beginsAt, open: price, high: price, low: price, close: price, volume: "100", session };
}

describe("seriesPlan", () => {
  it("charts the Eastern calendar day at 24/5 5-minute bars for 1d", () => {
    // Thursday 2026-08-27 11:00 EDT
    const plan = seriesPlan("1d", Date.parse("2026-08-27T15:00:00Z"));
    expect(plan.interval).toBe("5minute");
    expect(plan.bounds).toBe("24_5");
    expect(plan.windowStartMs).toBe(Date.parse("2026-08-27T04:00:00Z")); // Thu 00:00 EDT
    expect(plan.windowEndMs).toBe(Date.parse("2026-08-27T15:00:00Z"));
    expect(plan.tradingDay?.date).toBe("2026-08-27");
    expect(plan.fetchStartMs).toBe(Date.parse("2026-08-26T04:00:00Z")); // Wed 00:00 EDT
    // Thursday 21:30 EDT still charts Thursday's session.
    expect(seriesPlan("1d", Date.parse("2026-08-28T01:30:00Z")).tradingDay?.date).toBe("2026-08-27");
  });

  it("uses regular-hours bars and matches the account chart windows otherwise", () => {
    const now = Date.parse("2026-08-27T15:00:00Z");
    expect(seriesPlan("1w", now)).toMatchObject({
      interval: "10minute",
      bounds: "regular",
      windowStartMs: now - 7 * DAY,
    });
    expect(seriesPlan("1m", now)).toMatchObject({ interval: "hour", windowStartMs: Date.parse("2026-07-27T15:00:00Z") });
    expect(seriesPlan("3m", now)).toMatchObject({ interval: "day", windowStartMs: Date.parse("2026-05-27T15:00:00Z") });
    expect(seriesPlan("1y", now)).toMatchObject({ interval: "day", windowStartMs: Date.parse("2025-08-27T15:00:00Z") });
    expect(seriesPlan("all", now)).toMatchObject({ interval: "week", windowStartMs: undefined });
  });
});

describe("buildSymbolSeries — 1d", () => {
  const nowMs = Date.parse("2026-08-27T21:30:00Z"); // Thu 17:30 EDT, after-hours
  const plan = seriesPlan("1d", nowMs);
  const bars: EquityBar[] = [
    bar("2026-08-26T19:55:00Z", 99, "regular"), // Wed last regular bar (prior day)
    bar("2026-08-26T23:00:00Z", 99.5, "post"),
    bar("2026-08-27T02:00:00Z", 100.2, "overnight"), // Wed 22:00 EDT: before Thursday's open
    bar("2026-08-27T12:00:00Z", 100.6, "pre"),
    bar("2026-08-27T13:30:00Z", 101, "regular"),
    bar("2026-08-27T19:55:00Z", 103, "regular"),
    bar("2026-08-27T20:30:00Z", 103.5, "post"),
  ];

  it("keeps bars from midnight ET onward and tags sessions", () => {
    const series = buildSymbolSeries({ symbol: "NVDA", bars, quote: undefined, plan, nowMs });
    expect(series.sessionDate).toBe("2026-08-27");
    // Wed 22:00 EDT overnight bar belongs to Wednesday's chart; Thu 08:00 pre-market stays.
    expect(series.points.map((point) => point.s)).toEqual(["pre", "regular", "regular", "post"]);
    expect(series.points[0]?.t).toBe("2026-08-27T12:00:00Z");
  });

  it("before the open shows only the day's extended move against the previous close", () => {
    const fridayPreMarket = Date.parse("2026-08-28T12:30:00Z"); // Fri 08:30 EDT
    const extended = [
      ...bars,
      bar("2026-08-28T02:00:00Z", 104, "overnight"), // Thu 22:00 EDT: Thursday's chart
      bar("2026-08-28T05:00:00Z", 104.2, "overnight"), // Fri 01:00 EDT
      bar("2026-08-28T12:00:00Z", 104.5, "pre"),
    ];
    const series = buildSymbolSeries({
      symbol: "NVDA",
      bars: extended,
      quote: undefined,
      plan: seriesPlan("1d", fridayPreMarket),
      nowMs: fridayPreMarket,
    });
    expect(series.sessionDate).toBe("2026-08-28");
    expect(series.baseline).toEqual({ price: "103.00", kind: "previous_close" }); // Thursday's close
    expect(series.price).toBeNull();
    expect(series.change).toBeNull();
    expect(series.extendedSession).toBe("pre");
    expect(series.extendedPrice).toBe("104.50");
    expect(series.extendedChange?.amount).toBe("1.5");
    expect(series.points.map((point) => point.s)).toEqual(["overnight", "pre"]);
  });

  it("measures the extended move from the quote's rolled close once Robinhood rolls it", () => {
    const series = buildSymbolSeries({
      symbol: "NVDA",
      bars,
      quote: {
        symbol: "NVDA",
        lastTradePrice: "103.02",
        lastExtendedTradePrice: "103.60",
        lastExtendedTradeAt: "2026-08-27T21:20:00Z",
        previousClose: "103.02",
        previousCloseDate: "2026-08-27",
      },
      plan,
      nowMs,
    });
    // The rolled close is today's; the baseline falls back to Wednesday's bar.
    expect(series.baseline).toEqual({ price: "99.00", kind: "previous_close" });
    expect(series.extendedChange?.amount).toBe("0.58");
  });

  it("uses the prior regular close as baseline and splits today vs after-hours", () => {
    const series = buildSymbolSeries({ symbol: "NVDA", bars, quote: undefined, plan, nowMs });
    expect(series.baseline).toEqual({ price: "99.00", kind: "previous_close" });
    expect(series.price).toBe("103.00");
    expect(series.change).toEqual({ amount: "4", percent: "4.040404" });
    expect(series.extendedSession).toBe("post");
    expect(series.extendedPrice).toBe("103.50");
    expect(series.extendedChange).toEqual({ amount: "0.5", percent: "0.485437" });
  });

  it("prefers the quote's official previous close and live trades", () => {
    const series = buildSymbolSeries({
      symbol: "NVDA",
      bars,
      quote: {
        symbol: "NVDA",
        lastTradePrice: "103.10",
        lastTradeAt: "2026-08-27T19:59:58Z",
        lastExtendedTradePrice: "103.75",
        lastExtendedTradeAt: "2026-08-27T21:29:00Z",
        previousClose: "98.90",
        previousCloseDate: "2026-08-26",
      },
      plan,
      nowMs,
    });
    expect(series.baseline).toEqual({ price: "98.90", kind: "previous_close" });
    expect(series.price).toBe("103.10");
    expect(series.extendedPrice).toBe("103.75");
    expect(series.extendedChange?.amount).toBe("0.65");
  });

  it("labels 21:14 ET as an overnight move on top of today's regular change", () => {
    // Tuesday 2026-09-01 21:14 EDT
    const overnightNow = Date.parse("2026-09-02T01:14:00Z");
    const tuesdayBars = [
      bar("2026-08-31T19:55:00Z", 200, "regular"), // Monday close
      bar("2026-09-01T13:30:00Z", 201, "regular"),
      bar("2026-09-01T19:55:00Z", 198, "regular"), // Tuesday close
      bar("2026-09-01T21:00:00Z", 198.2, "post"),
      bar("2026-09-02T01:10:00Z", 198.9, "overnight"),
    ];
    const series = buildSymbolSeries({
      symbol: "NU",
      bars: tuesdayBars,
      quote: undefined,
      plan: seriesPlan("1d", overnightNow),
      nowMs: overnightNow,
    });
    expect(series.sessionDate).toBe("2026-09-01");
    expect(series.change?.amount).toBe("-2"); // Today: 198 vs 200
    expect(series.extendedSession).toBe("overnight");
    expect(series.extendedChange?.amount).toBe("0.9"); // Overnight: 198.9 vs 198
    expect(series.points.map((point) => point.s)).toEqual(["regular", "regular", "post", "overnight"]);
  });

  it("reports no extended move while the regular session is running", () => {
    const midday = Date.parse("2026-08-27T16:00:00Z");
    const series = buildSymbolSeries({
      symbol: "NVDA",
      bars: bars.filter((candidate) => Date.parse(candidate.beginsAt) <= midday),
      quote: undefined,
      plan: seriesPlan("1d", midday),
      nowMs: midday,
    });
    expect(series.extendedPrice).toBeNull();
    expect(series.extendedChange).toBeNull();
    expect(series.price).toBe("101.00");
  });

  it("falls back to the latest session with regular bars on a holiday", () => {
    // Monday 2026-09-07 (Labor Day) 12:00 EDT: no bars for Monday's trading day.
    const holidayNow = Date.parse("2026-09-07T16:00:00Z");
    const fridayBars = [
      bar("2026-09-04T13:30:00Z", 50, "regular"),
      bar("2026-09-04T19:55:00Z", 51, "regular"),
    ];
    const series = buildSymbolSeries({
      symbol: "HOOD",
      bars: fridayBars,
      quote: undefined,
      plan: seriesPlan("1d", holidayNow),
      nowMs: holidayNow,
    });
    expect(series.sessionDate).toBe("2026-09-04");
    expect(series.points).toHaveLength(2);
  });

  it("draws through a quiet pre-market on gap-fill bars but never charts a day of only gap fill", () => {
    // Thin name: Robinhood fills the whole pre-market flat at the prior close.
    const quiet: EquityBar[] = [
      bar("2026-08-26T19:55:00Z", 2.97, "regular"),
      { ...bar("2026-08-27T08:00:00Z", 2.97, "pre"), interpolated: true },
      { ...bar("2026-08-27T13:25:00Z", 2.97, "pre"), interpolated: true },
      bar("2026-08-27T13:30:00Z", 2.956, "regular"),
      bar("2026-08-27T19:55:00Z", 3.03, "regular"),
    ];
    const series = buildSymbolSeries({ symbol: "BMBL", bars: quiet, quote: undefined, plan, nowMs });
    expect(series.sessionDate).toBe("2026-08-27");
    expect(series.points.map((point) => point.s)).toEqual(["pre", "pre", "regular", "regular"]);
    expect(series.points[0]?.t).toBe("2026-08-27T08:00:00Z");

    // A holiday that Robinhood fills with gap bars still charts the prior session.
    const holidayNow = Date.parse("2026-09-07T16:00:00Z");
    const filled = buildSymbolSeries({
      symbol: "BMBL",
      bars: [
        bar("2026-09-04T13:30:00Z", 50, "regular"),
        bar("2026-09-04T19:55:00Z", 51, "regular"),
        { ...bar("2026-09-07T08:00:00Z", 51, "pre"), interpolated: true },
        { ...bar("2026-09-07T13:30:00Z", 51, "regular"), interpolated: true },
      ],
      quote: undefined,
      plan: seriesPlan("1d", holidayNow),
      nowMs: holidayNow,
    });
    expect(filled.sessionDate).toBe("2026-09-04");
    expect(filled.points).toHaveLength(2);
  });
});

describe("buildSymbolSeries — longer ranges", () => {
  it("baselines on the last close before the window", () => {
    const nowMs = Date.parse("2026-08-27T15:00:00Z");
    const plan = seriesPlan("1w", nowMs);
    const windowStart = plan.windowStartMs!;
    const bars = [
      bar(new Date(windowStart - 2 * DAY).toISOString(), 10, "regular"),
      bar(new Date(windowStart - MINUTE).toISOString(), 12, "regular"),
      bar(new Date(windowStart + MINUTE).toISOString(), 12.5, "regular"),
      bar(new Date(nowMs - 10 * MINUTE).toISOString(), 15, "regular"),
    ];
    const series = buildSymbolSeries({ symbol: "NU", bars, quote: undefined, plan, nowMs });
    expect(series.baseline).toEqual({ price: "12.00", kind: "window_open" });
    expect(series.points).toHaveLength(2);
    expect(series.change).toEqual({ amount: "3", percent: "25" });
  });

  it("opens on the first bar when nothing precedes the window", () => {
    const nowMs = Date.parse("2026-08-27T15:00:00Z");
    const plan = seriesPlan("all", nowMs);
    const bars = [
      { ...bar("2020-01-06T00:00:00Z", 5, "regular"), open: "4.00" },
      bar("2026-08-24T00:00:00Z", 20, "regular"),
    ];
    const series = buildSymbolSeries({ symbol: "NU", bars, quote: undefined, plan, nowMs });
    expect(series.baseline).toEqual({ price: "4.00", kind: "first_bar" });
    expect(series.change).toEqual({ amount: "16", percent: "400" });
  });
});

describe("planFetchStart", () => {
  const fetchStartMs = Date.parse("2026-08-23T00:00:00Z");
  const intervalMs = 5 * MINUTE;
  const refreshMs = MINUTE;

  it("fetches the whole window when nothing is cached", () => {
    expect(planFetchStart({ coverage: undefined, fetchStartMs, intervalMs, refreshMs, nowMs: 0 }))
      .toBe(fetchStartMs);
  });

  it("refills when the cache starts too late for the window", () => {
    const nowMs = Date.parse("2026-08-27T15:00:00Z");
    expect(planFetchStart({
      coverage: { earliestMs: fetchStartMs + 5 * DAY, latestMs: nowMs - MINUTE, latestUpdatedAtMs: nowMs - 10 * MINUTE },
      fetchStartMs,
      intervalMs,
      refreshMs,
      nowMs,
    })).toBe(fetchStartMs);
  });

  it("serves a freshly written cache without an upstream call", () => {
    const nowMs = Date.parse("2026-08-27T15:00:00Z");
    expect(planFetchStart({
      coverage: { earliestMs: fetchStartMs, latestMs: nowMs - 3 * MINUTE, latestUpdatedAtMs: nowMs - 30_000 },
      fetchStartMs,
      intervalMs,
      refreshMs,
      nowMs,
    })).toBeUndefined();
  });

  it("re-fetches from one bar before the latest to finalize it", () => {
    const nowMs = Date.parse("2026-08-27T15:00:00Z");
    const latestMs = nowMs - 3 * MINUTE;
    expect(planFetchStart({
      coverage: { earliestMs: fetchStartMs, latestMs, latestUpdatedAtMs: nowMs - 5 * MINUTE },
      fetchStartMs,
      intervalMs,
      refreshMs,
      nowMs,
    })).toBe(latestMs - intervalMs);
  });

  it("stays quiet over the weekend once Friday's last bar is final", () => {
    const saturday = Date.parse("2026-08-29T15:00:00Z");
    const fridayClose = Date.parse("2026-08-28T23:55:00Z");
    expect(planFetchStart({
      coverage: { earliestMs: fetchStartMs, latestMs: fridayClose, latestUpdatedAtMs: fridayClose + 10 * MINUTE },
      fetchStartMs,
      intervalMs,
      refreshMs,
      nowMs: saturday,
    })).toBeUndefined();
    // Not yet finalized: one more fetch is allowed.
    expect(planFetchStart({
      coverage: { earliestMs: fetchStartMs, latestMs: fridayClose, latestUpdatedAtMs: fridayClose + MINUTE },
      fetchStartMs,
      intervalMs,
      refreshMs,
      nowMs: saturday,
    })).toBe(fridayClose - intervalMs);
  });
});
