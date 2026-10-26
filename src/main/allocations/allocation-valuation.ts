import {
  decimalToScaledInteger,
  divideDecimals,
  multiplyDecimals,
  scaledIntegerToDecimal,
} from "./decimal";

export interface AttributedPosition {
  /** Exact provider/venue identity when available; never fall back to ticker. */
  instrumentRef?: string;
  symbol: string;
  quantity: string;
}

export interface SnapshotPositionValue {
  instrumentRef: string;
  symbol: string | null;
  quantity: string;
  markPrice: string | null;
  marketValue: string | null;
}

export interface ValuedPosition {
  quantity: string;
  valueUsd: string;
  markPriceUsd: string;
}

export type AllocationValuation =
  | {
      ready: true;
      cashUsd: string;
      allocationValueUsd: string;
      /** Attributed positions with a nonzero quantity, keyed by explicit instrument reference, or legacy symbol. */
      positions: Map<string, ValuedPosition>;
    }
  | {
      ready: false;
      reason: "negative_subledger_balance" | "missing_position_valuation";
    };

/** Cents of slippage a allocation's ledger may sit under zero before it is treated as wrong. */
export const NEGATIVE_CASH_TOLERANCE = 5n * 10n ** 16n; // $0.05

function signedCash(value: string): bigint {
  const trimmed = value.trim();
  return trimmed.startsWith("-")
    ? -decimalToScaledInteger(trimmed.slice(1))
    : decimalToScaledInteger(trimmed);
}

function nonNegative(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value);
}

function markPrice(item: SnapshotPositionValue): string | null {
  if (item.markPrice !== null && nonNegative(item.markPrice) && decimalToScaledInteger(item.markPrice) > 0n) {
    return item.markPrice;
  }
  if (
    item.marketValue !== null && nonNegative(item.marketValue) &&
    nonNegative(item.quantity) && decimalToScaledInteger(item.quantity) > 0n
  ) {
    return divideDecimals(item.marketValue, item.quantity);
  }
  return null;
}

/** Values a virtual allocation against one account-consistent position snapshot. */
export function deriveAllocationValuation(input: {
  cashUsd: string;
  positions: AttributedPosition[];
  snapshot: SnapshotPositionValue[];
}): AllocationValuation {
  // A ledger a few cents under zero is slippage, not a hole: a buy funded by
  // a sell in the same pass is sized to what the sell was expected to raise,
  // and the fill can land a cent or two short (1.2 cents on the e2e basket,
  // 2026-09-28, which froze the allocation). Within the tolerance the cash is
  // read as zero and the next sell restores it; beyond it the ledger is
  // wrong and the allocation waits for a look.
  const cashSigned = signedCash(input.cashUsd);
  if (cashSigned < -NEGATIVE_CASH_TOLERANCE) {
    return { ready: false, reason: "negative_subledger_balance" };
  }
  const cashUsd = cashSigned < 0n ? "0" : input.cashUsd;
  let total = decimalToScaledInteger(cashUsd);
  const positions = new Map<string, ValuedPosition>();
  for (const position of input.positions) {
    if (!nonNegative(position.quantity)) {
      return { ready: false, reason: "negative_subledger_balance" };
    }
    if (decimalToScaledInteger(position.quantity) === 0n) continue;
    const matches = input.snapshot.filter((item) => position.instrumentRef !== undefined
      ? item.instrumentRef === position.instrumentRef
      : item.symbol !== null && item.symbol === position.symbol);
    // Ambiguous tickers and duplicate identities must not silently pick a price.
    const price = matches.length === 1 ? markPrice(matches[0]!) : null;
    if (price === null) {
      return { ready: false, reason: "missing_position_valuation" };
    }
    const value = multiplyDecimals(position.quantity, price);
    total += decimalToScaledInteger(value);
    positions.set(position.instrumentRef ?? position.symbol, {
      quantity: position.quantity,
      valueUsd: value,
      markPriceUsd: price,
    });
  }
  return {
    ready: true,
    cashUsd,
    allocationValueUsd: scaledIntegerToDecimal(total),
    positions,
  };
}
