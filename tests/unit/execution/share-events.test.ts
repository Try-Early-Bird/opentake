import { describe, expect, it } from "vitest";

import { computeModelValuations, type DailyClose } from "../../../src/main/strategies/model-valuation";
import {
  readShareEvents,
  rescaleValuationRow,
  snapToSimpleFraction,
} from "../../../src/main/execution/share-events";

// Closes captured from Robinhood's historicals tool on 2026-09-16 with
// adjustment_type `none` and `split`. Days are the bars' UTC dates.

function closes(days: readonly string[], values: readonly string[]): DailyClose[] {
  return days.map((day, index) => ({ day, close: values[index]! }));
}

const fixtures = {
  NFLX: {
    days: ["2025-11-10", "2025-11-11", "2025-11-12", "2025-11-13", "2025-11-14", "2025-11-17", "2025-11-18", "2025-11-19", "2025-11-20", "2025-11-21"],
    raw: ["1120.07", "1136.44", "1157.5", "1154.23", "1112.17", "110.29", "114.09", "110", "105.67", "104.31"],
    split: ["112.007", "113.644", "115.75", "115.423", "111.217", "110.29", "114.09", "110", "105.67", "104.31"],
  },
  NVDA_2024: {
    days: ["2024-06-05", "2024-06-06", "2024-06-07", "2024-06-10", "2024-06-11", "2024-06-12"],
    raw: ["1224.4", "1210.45", "1208.88", "121.79", "120.91", "125.2"],
    split: ["122.44", "121.045", "120.888", "121.79", "120.91", "125.2"],
  },
  NVDA_2021: {
    days: ["2021-07-15", "2021-07-16", "2021-07-19", "2021-07-20", "2021-07-21", "2021-07-22"],
    raw: ["758.65", "726.44", "751.19", "186.12", "194.1", "195.94"],
    split: ["18.96625", "18.161", "18.77975", "18.612", "19.41", "19.594"],
  },
  LCID: {
    days: ["2025-08-26", "2025-08-27", "2025-08-28", "2025-08-29", "2025-09-02", "2025-09-03", "2025-09-04", "2025-09-05"],
    raw: ["2.11", "2.08", "2.07", "1.98", "17.66", "16.785", "16.16", "18.41"],
    split: ["21.1", "20.8", "20.7", "19.8", "17.66", "16.785", "16.16", "18.41"],
  },
  TQQQ: {
    days: ["2022-01-10", "2022-01-11", "2022-01-12", "2022-01-13", "2022-01-14", "2022-01-18"],
    raw: ["144.6", "150.96", "152.68", "70.8", "71.87", "66.69"],
    split: ["36.15", "37.74", "38.17", "35.4", "35.935", "33.345"],
  },
  SQQQ: {
    days: ["2022-01-10", "2022-01-11", "2022-01-12", "2022-01-13", "2022-01-14", "2022-01-18"],
    raw: ["6.71", "6.43", "6.34", "34.06", "33.5", "35.9"],
    split: ["838.75", "803.75", "792.5", "851.5", "837.5", "897.5"],
  },
  AAON: {
    days: ["2023-08-11", "2023-08-14", "2023-08-15", "2023-08-16", "2023-08-17", "2023-08-18", "2023-08-21", "2023-08-22"],
    raw: ["94.62", "96.24", "94.5", "94.57", "60.82", "61.75", "61.97", "59.79"],
    split: ["63.08", "64.16", "63", "63.046667", "60.82", "61.75", "61.97", "59.79"],
  },
  GE_2021: {
    days: ["2021-07-28", "2021-07-29", "2021-07-30", "2021-08-02", "2021-08-03", "2021-08-04", "2021-08-05"],
    raw: ["13.13", "13.29", "12.95", "100.6", "103.06", "102.91", "103.02"],
    split: ["65.789159", "66.590855", "64.887251", "63.008277", "64.549036", "64.455087", "64.523983"],
  },
  GE_2024: {
    days: ["2024-03-27", "2024-03-28", "2024-04-01", "2024-04-02", "2024-04-03", "2024-04-04", "2024-04-05"],
    raw: ["180.12", "175.53", "175.36", "136.47", "145.62", "147.39", "156.3"],
    split: ["145.216887", "141.516323", "141.379265", "136.47", "145.62", "147.39", "156.3"],
  },
  COST: {
    days: ["2023-12-21", "2023-12-22", "2023-12-26", "2023-12-27", "2023-12-28", "2023-12-29", "2024-01-02", "2024-01-03"],
    raw: ["665.16", "671.6", "674.62", "666.8", "663.1", "660.08", "650.65", "644.69"],
    split: ["665.16", "671.6", "674.62", "666.8", "663.1", "660.08", "650.65", "644.69"],
  },
  TR: {
    days: ["2025-02-27", "2025-02-28", "2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07", "2025-03-10", "2025-03-11", "2025-03-12", "2025-03-13"],
    raw: ["30.93", "30.99", "31.78", "32.03", "31.25", "31.18", "32.57", "32.85", "32.31", "31.43", "31.34"],
    split: ["30.93", "30.99", "31.78", "32.03", "31.25", "31.18", "32.57", "32.85", "32.31", "31.43", "31.34"],
  },
} as const;

function read(name: keyof typeof fixtures) {
  const fixture = fixtures[name];
  return readShareEvents(closes(fixture.days, fixture.raw), closes(fixture.days, fixture.split));
}

describe("readShareEvents on verified Robinhood closes", () => {
  it.each([
    ["NFLX", "2025-11-17", 10, 1],
    ["NVDA_2024", "2024-06-10", 10, 1],
    ["NVDA_2021", "2021-07-20", 4, 1],
    ["LCID", "2025-09-02", 1, 10],
    ["TQQQ", "2022-01-13", 2, 1],
    ["SQQQ", "2022-01-13", 1, 5],
    ["AAON", "2023-08-17", 3, 2],
    ["GE_2021", "2021-08-02", 1, 8],
  ] as const)("%s: one split effective %s, %i for %i", (name, day, splitTo, splitFrom) => {
    const reading = read(name);
    expect(reading.events).toHaveLength(1);
    expect(reading.events[0]).toMatchObject({ day, kind: "split", splitTo, splitFrom });
  });

  it("settles when the history runs to a day with no later events, and defers when it does not", () => {
    // In the job the window always ends at the newest bar, where the ratio is 1.
    for (const name of ["NFLX", "NVDA_2024", "LCID", "AAON", "COST", "TR"] as const) {
      expect(read(name).unconfirmedOn).toBeNull();
    }
    // These windows stop before a later split (NVDA 2024, TQQQ and SQQQ again, GE's spin-off),
    // so their newest bar still disagrees and would wait.
    expect(read("NVDA_2021").unconfirmedOn).toBe("2021-07-22");
    expect(read("TQQQ").unconfirmedOn).toBe("2022-01-18");
    expect(read("GE_2021").unconfirmedOn).toBe("2021-08-05");
  });

  it("reads the step, not the cumulative ratio, when later events are already in the history", () => {
    // NVDA's 2021 bars carry the 2024 split too: ratio 40 before, 10 after.
    const [event] = read("NVDA_2021").events;
    expect(Number(event!.observedStep)).toBeCloseTo(4, 3);
  });

  it("flags GE's spin-off for review: the step is not a simple fraction", () => {
    const reading = read("GE_2024");
    expect(reading.events).toHaveLength(1);
    expect(reading.events[0]).toMatchObject({ day: "2024-04-02", kind: "unclassified", splitTo: null, splitFrom: null });
    expect(Number(reading.events[0]!.observedStep)).toBeCloseTo(1.2404, 3);
  });

  it("finds nothing for a special cash dividend or a small stock dividend", () => {
    expect(read("COST").events).toEqual([]);
    // Robinhood does not adjust for TR's 3% stock dividend; detection cannot see it (an operator enters it).
    expect(read("TR").events).toEqual([]);
    expect(read("COST").unconfirmedOn).toBeNull();
  });

  it("defers when the newest bar moves like a split that has not been adjusted yet", () => {
    const { days, raw } = fixtures.NFLX;
    // Split morning before Robinhood rewrites history: adjusted still equals raw everywhere.
    const reading = readShareEvents(closes(days.slice(0, 6), raw.slice(0, 6)), closes(days.slice(0, 6), raw.slice(0, 6)));
    expect(reading.events).toEqual([]);
    expect(reading.unconfirmedOn).toBe("2025-11-17");
  });

  it("does not defer once a large move is no longer the newest bar", () => {
    const { days, raw } = fixtures.NFLX;
    const reading = readShareEvents(closes(days, raw), closes(days, raw));
    expect(reading.unconfirmedOn).toBeNull();
  });

  it("defers when adjusted history already disagrees with raw on the newest bar", () => {
    const { days, raw, split } = fixtures.NFLX;
    // History adjusted for an event whose first bar has not arrived: every ratio is 10.
    const reading = readShareEvents(closes(days.slice(0, 5), raw.slice(0, 5)), closes(days.slice(0, 5), split.slice(0, 5)));
    expect(reading.events).toEqual([]);
    expect(reading.unconfirmedOn).toBe("2025-11-14");
  });

  it("ignores days missing from either side", () => {
    const { days, raw, split } = fixtures.NFLX;
    const reading = readShareEvents(closes(days, raw), closes(days, split).filter((close) => close.day !== "2025-11-17"));
    expect(reading.events).toHaveLength(1);
    expect(reading.events[0]).toMatchObject({ day: "2025-11-18", previousDay: "2025-11-14", splitTo: 10, splitFrom: 1 });
  });
});

describe("snapToSimpleFraction", () => {
  it("snaps rounded steps and rejects ones that are not simple", () => {
    expect(snapToSimpleFraction(1.4999998)).toEqual({ splitTo: 3, splitFrom: 2 });
    expect(snapToSimpleFraction(0.005)).toEqual({ splitTo: 1, splitFrom: 200 });
    expect(snapToSimpleFraction(1.2404)).toBeNull();
    expect(snapToSimpleFraction(1.0001)).toBeNull();
  });
});

describe("rescaleValuationRow", () => {
  const row = { units: { NFLX: "0.44", AAPL: "1.5" }, closes: { NFLX: "1112.17", AAPL: "230" } };

  it("scales units up and the close down, leaving the holding's value unchanged", () => {
    const moved = rescaleValuationRow(row, "NFLX", { splitTo: 10, splitFrom: 1 }, "apply")!;
    expect(moved.units).toEqual({ NFLX: "4.4", AAPL: "1.5" });
    expect(moved.closes).toEqual({ NFLX: "111.217", AAPL: "230" });
  });

  it("undoes exactly for a whole-number factor and to 18 decimals otherwise", () => {
    const whole = { splitTo: 10, splitFrom: 1 };
    expect(rescaleValuationRow(rescaleValuationRow(row, "NFLX", whole, "apply")!, "NFLX", whole, "undo")).toEqual(row);
    const fraction = { splitTo: 3, splitFrom: 2 };
    const back = rescaleValuationRow(rescaleValuationRow(row, "NFLX", fraction, "apply")!, "NFLX", fraction, "undo")!;
    expect(back.units).toEqual(row.units);
    expect(Math.abs(Number(back.closes.NFLX) - Number(row.closes.NFLX))).toBeLessThan(1e-12);
  });

  it("leaves a row that does not hold the symbol alone", () => {
    expect(rescaleValuationRow(row, "TSLA", { splitTo: 2, splitFrom: 1 }, "apply")).toBeNull();
  });
});

describe("replay: NFLX 10-for-1", () => {
  // A 50/50 NFLX and cash-like KO model built on the cache as it stood before
  // the split (raw closes), then continued after Robinhood adjusted history.
  const allocations = [{
    id: "alloc-1",
    sequence: 1,
    weights: [{ symbol: "NFLX", weightPercent: 50 }, { symbol: "KO", weightPercent: 50 }],
    cashPercent: 0,
    effectiveOn: "2025-11-10",
  }];
  const { days, raw, split } = fixtures.NFLX;
  const ko = days.map((day) => ({ day, close: "70" }));
  const before = days.slice(0, 5);
  const after = days.slice(5);

  it("keeps the track record and continues without a false 90% loss", () => {
    const oldBasis = computeModelValuations({
      allocations,
      closesBySymbol: new Map([["NFLX", closes(before, raw.slice(0, 5))], ["KO", ko]]),
      days: before,
    });

    // Unhandled: resume from old-basis units against adjusted closes.
    const broken = computeModelValuations({
      allocations,
      closesBySymbol: new Map([["NFLX", closes(days, split)], ["KO", ko]]),
      days: after,
      previous: oldBasis.at(-1)!,
      previousDay: before.at(-1)!,
    });
    expect(Number(broken[0]!.unitValue)).toBeLessThan(Number(oldBasis.at(-1)!.unitValue) * 0.6);

    // Handled: detect, rescale the stored rows, resume.
    const [event] = readShareEvents(closes(days, raw), closes(days, split)).events;
    expect(event).toMatchObject({ day: "2025-11-17", splitTo: 10, splitFrom: 1 });
    const factor = { splitTo: event!.splitTo!, splitFrom: event!.splitFrom! };
    const rescaled = oldBasis.map((row) => ({ ...row, ...rescaleValuationRow(row, "NFLX", factor, "apply")! }));
    for (const [index, row] of rescaled.entries()) {
      expect(row.unitValue).toBe(oldBasis[index]!.unitValue);
      expect(row.cash).toBe(oldBasis[index]!.cash);
    }
    const resumed = computeModelValuations({
      allocations,
      closesBySymbol: new Map([["NFLX", closes(days, split)], ["KO", ko]]),
      days: after,
      previous: rescaled.at(-1)!,
      previousDay: before.at(-1)!,
    });

    // The same model computed on adjusted closes from the start is the truth.
    const truth = computeModelValuations({
      allocations,
      closesBySymbol: new Map([["NFLX", closes(days, split)], ["KO", ko]]),
      days,
    });
    // Units are stored to 18 decimals, so the two bases agree to about 1e-15.
    expect(truth.slice(0, 5).map((row) => Number(row.unitValue))).toEqual(
      oldBasis.map((row) => expect.closeTo(Number(row.unitValue), 9)),
    );
    expect(resumed.map((row) => Number(row.unitValue))).toEqual(
      truth.slice(5).map((row) => expect.closeTo(Number(row.unitValue), 9)),
    );
    // NFLX fell about 0.8% on the effective day; the model holds half in NFLX.
    const dayMove = Number(resumed[0]!.unitValue) / Number(rescaled.at(-1)!.unitValue) - 1;
    expect(dayMove).toBeGreaterThan(-0.01);
    expect(dayMove).toBeLessThan(0);
  });
});
