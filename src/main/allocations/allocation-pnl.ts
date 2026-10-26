import {
  decimalToScaledInteger,
  scaledIntegerToDecimal,
} from "./decimal";

// First-party allocation P&L from the attribution ledger. Every strategy fill is
// recorded with its exact quantity and cash, so a allocation's cost basis per
// symbol is known without asking the provider; sells realize against the
// allocation's moving-average cost. Robinhood's own position P&L then splits into
// strategy and self-directed parts by subtraction (see the holdings read).

export interface LedgerEntry {
  sequence: number;
  entryType: string;
  symbol: string | null;
  quantityDelta: string | null;
  cashDelta: string | null;
}

export interface SymbolCostState {
  /** Shares the allocation currently attributes. */
  quantity: string;
  /** Total cost of those shares, moving average. */
  costBasis: string;
  /** Proceeds minus average cost on every allocation sell so far. */
  realized: string;
}

export interface AllocationPnl {
  bySymbol: Map<string, SymbolCostState>;
  /** Fees the allocation paid, as a non-negative amount. */
  fees: string;
  /** Net virtual capital the member allocated to the allocation. */
  capitalAllocated: string;
  /** Realized across every symbol, net of fees. */
  realizedNet: string;
}

function signed(value: string | null): bigint {
  if (value === null) return 0n;
  return value.startsWith("-")
    ? -decimalToScaledInteger(value.slice(1))
    : decimalToScaledInteger(value);
}

function format(value: bigint): string {
  return value < 0n ? `-${scaledIntegerToDecimal(-value)}` : scaledIntegerToDecimal(value);
}

const SCALE = 10n ** 18n;

export function deriveAllocationPnl(entries: readonly LedgerEntry[]): AllocationPnl {
  const state = new Map<string, { quantity: bigint; cost: bigint; realized: bigint }>();
  let fees = 0n;
  let capital = 0n;
  for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
    const cash = signed(entry.cashDelta);
    switch (entry.entryType) {
      case "capital_allocated":
      case "capital_released":
        capital += cash;
        continue;
      case "fee":
        fees += -cash;
        continue;
      default:
        break;
    }
    if (entry.symbol === null || entry.quantityDelta === null) continue;
    const quantity = signed(entry.quantityDelta);
    const current = state.get(entry.symbol) ?? { quantity: 0n, cost: 0n, realized: 0n };
    // A share count that changed without a sale. A split leaves the same money
    // in the same holding, so only the quantity moves and the average cost per
    // share follows; a release moves shares out of the allocation, taking their
    // share of the cost with them. Neither realizes anything: treating either
    // as a sale at zero proceeds would book the whole cost as a loss.
    if (entry.entryType === "corporate_action") {
      current.quantity += quantity;
      if (current.quantity <= 0n) {
        current.quantity = 0n;
        current.cost = 0n;
      }
      state.set(entry.symbol, current);
      continue;
    }
    if (entry.entryType === "detachment" || entry.entryType === "external_adjustment") {
      const released = quantity < 0n ? -quantity : quantity;
      const averageCost = current.quantity > 0n ? current.cost * SCALE / current.quantity : 0n;
      const relieved = quantity < 0n ? averageCost * released / SCALE : 0n;
      current.quantity += quantity;
      current.cost -= relieved;
      if (current.quantity <= 0n) {
        current.quantity = 0n;
        current.cost = 0n;
      }
      state.set(entry.symbol, current);
      continue;
    }
    if (quantity > 0n) {
      // Buy: cash out is the cost of the new shares.
      current.quantity += quantity;
      current.cost += -cash;
    } else if (quantity < 0n) {
      const sold = -quantity;
      const averageCost = current.quantity > 0n ? current.cost * SCALE / current.quantity : 0n;
      const relieved = averageCost * sold / SCALE;
      current.realized += cash - relieved;
      current.quantity -= sold;
      current.cost -= relieved;
      if (current.quantity <= 0n) {
        current.quantity = 0n;
        current.cost = 0n;
      }
    }
    state.set(entry.symbol, current);
  }
  let realizedTotal = 0n;
  const bySymbol = new Map<string, SymbolCostState>();
  for (const [symbol, current] of state) {
    realizedTotal += current.realized;
    bySymbol.set(symbol, {
      quantity: format(current.quantity),
      costBasis: format(current.cost),
      realized: format(current.realized),
    });
  }
  return {
    bySymbol,
    fees: format(fees),
    capitalAllocated: format(capital),
    realizedNet: format(realizedTotal - fees),
  };
}

/** Unrealized gain on a symbol given its current attributed market value. */
export function unrealizedFor(state: SymbolCostState, valueUsd: string): string {
  return format(signed(valueUsd) - signed(state.costBasis));
}

/** Difference of two signed decimal strings, for provider-minus-strategy residuals. */
export function subtractDecimalStrings(left: string, right: string): string {
  return format(signed(left) - signed(right));
}
