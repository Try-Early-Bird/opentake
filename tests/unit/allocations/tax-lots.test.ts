import { describe, expect, it } from "vitest";

import {
  matchFillToLot,
  normalizeRobinhoodTaxLots,
  selectLotsForSale,
  selectLotsWithFallback,
  type RobinhoodTaxLot,
} from "../../../src/main/allocations/tax-lots";

const lots: RobinhoodTaxLot[] = [
  { openLotId: "lot-a", quantity: "10", costBasis: "2000", unitCost: "200", acquiredAt: "2026-08-20T14:30:00.000Z" },
  { openLotId: "lot-b", quantity: "10", costBasis: "2100", unitCost: "210", acquiredAt: "2026-08-25T14:30:00.000Z" },
  { openLotId: "lot-c", quantity: "2.5", costBasis: "510", unitCost: "204", acquiredAt: "2026-08-25T15:00:00.000Z" },
  { openLotId: "lot-self", quantity: "5", costBasis: "900", unitCost: "180", acquiredAt: "2026-07-01T14:30:00.000Z" },
];

describe("Robinhood tax lots", () => {
  it("reads a lots page tolerantly and derives unit cost", () => {
    const page = normalizeRobinhoodTaxLots({
      results: [
        { open_lot_id: "lot-1", quantity: "4", cost_basis: "820.00", acquisition_date: "2026-08-25" },
        { open_lot_id: "lot-2", quantity: 1.5, cost_per_share: "199.5", acquired_at: "2026-08-26T13:45:00Z" },
        { id: "ignored", note: "no quantity" },
      ],
      next: "https://api.robinhood.test/lots?cursor=abc123",
    });
    expect(page.nextCursor).toBe("abc123");
    expect(page.lots).toEqual([
      { openLotId: "lot-1", quantity: "4", costBasis: "820.00", unitCost: "205", acquiredAt: "2026-08-25T00:00:00.000Z" },
      { openLotId: "lot-2", quantity: "1.5", costBasis: null, unitCost: "199.5", acquiredAt: "2026-08-26T13:45:00.000Z" },
    ]);
  });

  it("dates Robinhood's lots by open_date, so a sell takes the oldest and not this morning's", () => {
    // The e2e basket's NVDA lots as get_equity_tax_lots returned them on
    // 2026-09-30 (newest first). Without open_date every lot was undated and
    // the sell took the lowest lot id, which was the one bought at the open.
    const page = normalizeRobinhoodTaxLots({
      data: {
        symbol: "NVDA",
        tax_lots: [
          { open_lot_id: "279126cc-136b-5735-8680-778cff265adf", quantity: "0.005228", quantity_available: "0.005228", is_selectable: false, tax_cost_basis: "1.200000", open_date: "2026-09-30", term: "st" },
          { open_lot_id: "4a9c0f2d-2e36-57cc-9e59-4335b1daa9d7", quantity: "0.017358", quantity_available: "0.017358", is_selectable: true, cost_per_share: "232.170000", tax_cost_basis: "4.030000", open_date: "2026-09-29", term: "st" },
          { open_lot_id: "9e8d446c-2148-5417-86ba-dcd1f96da98d", quantity: "0.107791", quantity_available: "0.107791", is_selectable: true, cost_per_share: "222.650000", tax_cost_basis: "24.000000", open_date: "2026-09-24", term: "st" },
        ],
      },
    });
    expect(page.lots[0]).toEqual({
      openLotId: "279126cc-136b-5735-8680-778cff265adf",
      quantity: "0.005228",
      costBasis: "1.200000",
      unitCost: "229.533282325937260903",
      acquiredAt: "2026-09-30T00:00:00.000Z",
      selectable: false,
    });
    const known = new Set(page.lots.map((lot) => lot.openLotId));
    expect(selectLotsForSale(page.lots, known, "0.0083").taxLots).toEqual([
      { openLotId: "9e8d446c-2148-5417-86ba-dcd1f96da98d", quantity: "0.0083" },
    ]);
  });

  it("matches a fill after the close to a lot dated by its Eastern day", () => {
    const dated = [
      { openLotId: "lot-prior", quantity: "1", costBasis: null, unitCost: "100", acquiredAt: "2026-09-29T00:00:00.000Z" },
      { openLotId: "lot-evening", quantity: "1", costBasis: null, unitCost: "110", acquiredAt: "2026-09-30T00:00:00.000Z" },
    ];
    // 21:00 ET on the 30th is already the 1st in UTC.
    const fill = { quantity: "1", price: "100", occurredAt: "2026-10-01T01:00:00.000Z" };
    expect(matchFillToLot(dated, fill, new Set())?.openLotId).toBe("lot-evening");
  });

  it("matches a buy fill to the unclaimed lot with the same quantity, nearest day and cost", () => {
    const fill = { quantity: "10", price: "209.8", occurredAt: "2026-08-25T14:30:05.000Z" };
    expect(matchFillToLot(lots, fill, new Set())?.openLotId).toBe("lot-b");
    expect(matchFillToLot(lots, fill, new Set(["lot-b"]))?.openLotId).toBe("lot-a");
    expect(matchFillToLot(lots, { ...fill, quantity: "3" }, new Set())).toBeNull();
  });

  it("names only the allocation's own lots on a sell, oldest first", () => {
    const known = new Set(["lot-a", "lot-b", "lot-c"]);
    expect(selectLotsForSale(lots, known, "12")).toEqual({
      taxLots: [
        { openLotId: "lot-a", quantity: "10" },
        { openLotId: "lot-b", quantity: "2" },
      ],
      covered: true,
      shortfall: "0",
    });
  });

  it("reports a shortfall instead of dipping into self-directed lots", () => {
    const selection = selectLotsForSale(lots, new Set(["lot-c"]), "4");
    expect(selection.covered).toBe(false);
    expect(selection.shortfall).toBe("1.5");
    expect(selection.taxLots).toEqual([{ openLotId: "lot-c", quantity: "2.5" }]);
  });

  it("stands in unclaimed lots once the allocation's own run out, and says how many", () => {
    // The strategy bought 10 (lot-a) before the member bought 8 of their
    // own (lot-self). The member sold 8 in Robinhood; first-in-first-out took
    // them from lot-a, leaving 2 of it, while lot-self survived whole. The
    // account holds 10 and the strategy still owns all 10.
    const after = [
      { ...lots[0]!, quantity: "2" },
      { ...lots[3]!, quantity: "8", acquiredAt: "2026-09-01T14:30:00.000Z" },
    ];
    const selection = selectLotsWithFallback(after, new Set(["lot-a"]), new Set(["lot-self"]), "6");
    expect(selection).toEqual({
      taxLots: [{ openLotId: "lot-a", quantity: "2" }, { openLotId: "lot-self", quantity: "4" }],
      covered: true,
      shortfall: "0",
      borrowed: "4",
    });
  });

  it("borrows nothing when the allocation's own lots cover the sell", () => {
    expect(selectLotsWithFallback(lots, new Set(["lot-a"]), new Set(["lot-self"]), "3")).toMatchObject({
      covered: true,
      borrowed: "0",
      taxLots: [{ openLotId: "lot-a", quantity: "3" }],
    });
  });

  it("never names a lot another strategy claims", () => {
    // lot-b belongs to another strategy, so it is neither known nor unclaimed here.
    const selection = selectLotsWithFallback(lots, new Set(["lot-c"]), new Set(), "5");
    expect(selection).toMatchObject({ covered: false, shortfall: "2.5", borrowed: "0" });
    expect(selection.taxLots.map((lot) => lot.openLotId)).toEqual(["lot-c"]);
  });
});

it('keeps specified lot quantities exact until the provider wire boundary', () => {
 const result=selectLotsForSale([{openLotId:'precise',quantity:'0.123456789012345678',unitCost:'1',costBasis:null,acquiredAt:null}],new Set(['precise']),'0.123456789012345678');
 expect(result.taxLots).toEqual([{openLotId:'precise',quantity:'0.123456789012345678'}]);
});
