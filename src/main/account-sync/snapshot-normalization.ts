// pure provider normalization.
export interface NormalizedRobinhoodPortfolio {
  totalValue: string;
  cash: string | null;
  buyingPower: string | null;
  pendingDeposits: string | null;
  currency: string;
  components: Array<{ key: string; amount: string }>;
  providerPayload: Record<string, unknown>;
}

export interface NormalizedRobinhoodPosition {
  positionKey: string;
  instrumentRef: string;
  symbol: string | null;
  side: "long" | "short" | "flat";
  quantity: string;
  displayQuantity: string | null;
  quantityMultiplier: string;
  contractMultiplier: string;
  averageCost: string | null;
  costBasis: string | null;
  heldQuantity: string | null;
  markPrice: string | null;
  marketValue: string | null;
  providerUnrealizedPnl: string | null;
  providerRealizedPnl: string | null;
  currency: string;
  priceObservedAt: string | null;
  providerPayload: Record<string, unknown>;
}

const PORTFOLIO_COMPONENT_KEYS = [
  "equity_value",
  "options_value",
  "futures_value",
  "crypto_value",
  "event_contracts_value",
  "mutual_funds_value",
  "fixed_income_value",
] as const;

const SAFE_PORTFOLIO_PAYLOAD_KEYS = [
  "total_value",
  "cash",
  "buying_power",
  "pending_deposits",
  "crypto_buying_power",
  "currency",
  "currency_code",
  ...PORTFOLIO_COMPONENT_KEYS,
] as const;

const SAFE_POSITION_PAYLOAD_KEYS = [
  "id",
  "instrument_id",
  "instrument",
  "option_id",
  "chain_id",
  "symbol",
  "chain_symbol",
  "underlying_symbol",
  "quantity",
  "display_quantity",
  "average_buy_price",
  "average_price",
  "average_cost",
  "cost_basis",
  "shares_available_for_sells",
  "shares_held_for_buys",
  "shares_held_for_sells",
  "shares_held_for_stock_grants",
  "shares_held_for_options_collateral",
  "shares_held_for_options_events",
  "held_quantity",
  "quantity_multiplier",
  "contract_multiplier",
  "trade_value_multiplier",
  "multiplier",
  "mark_price",
  "adjusted_mark_price",
  "market_value",
  "unrealized_pnl",
  "unrealized_gain_loss",
  "realized_pnl",
  "realized_gain_loss",
  "option_type",
  "type",
  "expiration_date",
  "strike_price",
  "pending_buy_quantity",
  "pending_sell_quantity",
  "intraday_quantity",
  "intraday_average_buy_price",
  "currency",
  "currency_code",
  "price_observed_at",
  "updated_at",
] as const;

function safeProviderPayload(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(allowedKeys.flatMap((key) => {
    const value = record[key];
    return value === null || ["string", "number", "boolean"].includes(typeof value)
      ? [[key, value] as const]
      : [];
  }));
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function boundedString(value: string | null, maximum = 256): string | null {
  return value !== null && value.length <= maximum ? value : null;
}

function decimalString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    const candidate = typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : null;
    if (candidate === null) continue;
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(candidate);
    const unsigned = candidate.startsWith("-") ? candidate.slice(1) : candidate;
    const [integer = "", fraction = ""] = unsigned.split(".");
    if (match !== null && integer.length <= 20 && fraction.length <= 18) return candidate;
  }
  return null;
}

function positiveDecimalOrOne(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  const value = decimalString(record, ...keys);
  if (value === null || value.startsWith("-") || /^0(?:\.0+)?$/u.test(value)) return "1";
  return value;
}

function timestampString(record: Record<string, unknown>, ...keys: string[]): string | null {
  const value = optionalString(record, ...keys);
  if (value === null) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function currency(record: Record<string, unknown>): string {
  const value = optionalString(record, "currency", "currency_code")?.toUpperCase();
  return value !== undefined && value !== null && /^[A-Z][A-Z0-9]{2,11}$/u.test(value)
    ? value
    : "USD";
}

function findPortfolioRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 12 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPortfolioRecord(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (decimalString(record, "total_value") !== null) return record;
  for (const item of Object.values(record)) {
    const found = findPortfolioRecord(item, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Robinhood's `get_portfolio` returns buying power as an object --
 * `{ buying_power, unleveraged_buying_power, display_currency }` -- where the
 * first field is the authoritative spendable figure. A bare decimal is still
 * accepted in case a payload ever carries one.
 */
function buyingPowerOf(record: Record<string, unknown>): string | null {
  const direct = decimalString(record, "buying_power");
  if (direct !== null) return direct;
  const nested = record.buying_power;
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? decimalString(nested as Record<string, unknown>, "buying_power")
    : null;
}

export function normalizeRobinhoodPortfolio(value: unknown): NormalizedRobinhoodPortfolio {
  const record = findPortfolioRecord(value);
  if (record === null) throw new TypeError("Robinhood portfolio did not contain total_value");
  const totalValue = decimalString(record, "total_value");
  if (totalValue === null) throw new TypeError("Robinhood portfolio total_value is invalid");
  const buyingPower = buyingPowerOf(record);
  return {
    totalValue,
    cash: decimalString(record, "cash"),
    buyingPower,
    pendingDeposits: decimalString(record, "pending_deposits"),
    currency: currency(record),
    components: PORTFOLIO_COMPONENT_KEYS.flatMap((key) => {
      const amount = decimalString(record, key);
      return amount === null ? [] : [{ key, amount }];
    }),
    // The kept payload holds scalars only, so the nested figure is kept as
    // one. It is also what the snapshot's change hash reads: without it, a
    // capture whose other fields had not moved would be skipped as unchanged
    // and the buying power never stored.
    providerPayload: {
      ...safeProviderPayload(record, SAFE_PORTFOLIO_PAYLOAD_KEYS),
      ...(buyingPower === null ? {} : { buying_power: buyingPower }),
    },
  };
}

function nextCursor(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const cursor = nextCursor(item, depth + 1);
      if (cursor !== null) return cursor;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = optionalString(record, "next_cursor");
  if (direct !== null && direct.length <= 4_096) return direct;
  const next = optionalString(record, "next");
  if (next !== null) {
    try {
      const cursor = new URL(next).searchParams.get("cursor");
      if (cursor !== null && cursor.length > 0 && cursor.length <= 4_096) return cursor;
    } catch {
      // Non-URL pagination values are not safe cursor inputs.
    }
  }
  for (const item of Object.values(record)) {
    const cursor = nextCursor(item, depth + 1);
    if (cursor !== null) return cursor;
  }
  return null;
}

function positionRecords(
  value: unknown,
  assetClass: "equity" | "option",
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 12 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => positionRecords(item, assetClass, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const quantity = decimalString(record, "quantity");
  const instrumentRef = assetClass === "equity"
    ? optionalString(record, "instrument_id", "instrument", "id", "symbol")
    : optionalString(record, "option_id", "instrument_id", "instrument", "id");
  if (
    instrumentRef !== null &&
    Object.hasOwn(record, "quantity") &&
    quantity === null
  ) {
    throw new TypeError(`Robinhood ${assetClass} position quantity is invalid`);
  }
  const own = quantity !== null && instrumentRef !== null ? [record] : [];
  return own.concat(
    Object.values(record).flatMap((item) => positionRecords(item, assetClass, depth + 1)),
  );
}

function hasPositionCollection(
  value: unknown,
  assetClass: "equity" | "option",
  depth = 0,
): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return depth === 0;
  const record = value as Record<string, unknown>;
  const collectionKeys = assetClass === "equity"
    ? ["results", "positions", "equity_positions", "data"]
    : ["results", "positions", "option_positions", "data"];
  if (collectionKeys.some((key) => Array.isArray(record[key]))) return true;
  return Object.values(record).some((item) =>
    hasPositionCollection(item, assetClass, depth + 1)
  );
}

function sideFor(quantity: string): "long" | "short" | "flat" {
  if (/^-0(?:\.0+)?$/u.test(quantity) || /^0(?:\.0+)?$/u.test(quantity)) return "flat";
  return quantity.startsWith("-") ? "short" : "long";
}

export function normalizeRobinhoodPositionPage(
  value: unknown,
  assetClass: "equity" | "option",
): { positions: NormalizedRobinhoodPosition[]; nextCursor: string | null } {
  const positions = new Map<string, NormalizedRobinhoodPosition>();
  for (const record of positionRecords(value, assetClass)) {
    const quantity = decimalString(record, "quantity");
    // Equities are keyed by ticker, the one identifier Robinhood's positions always
    // carry; fills meet them through equityRef (allocations/evidence.ts).
    const rawInstrumentRef = assetClass === "equity"
      ? (optionalString(record, "symbol")?.toUpperCase() ?? optionalString(record, "instrument_id", "instrument", "id"))
      : optionalString(record, "option_id", "instrument_id", "instrument", "id");
    const instrumentRef = boundedString(rawInstrumentRef, 2_048);
    if (quantity === null || instrumentRef === null) continue;
    const positionKey = `robinhood:${assetClass}:${instrumentRef}`;
    const marketValue = decimalString(record, "market_value");
    const unrealizedPnl = decimalString(record, "unrealized_pnl", "unrealized_gain_loss");
    const realizedPnl = decimalString(record, "realized_pnl", "realized_gain_loss");
    positions.set(positionKey, {
      positionKey,
      instrumentRef,
      symbol: boundedString(
        optionalString(record, "symbol", "chain_symbol", "underlying_symbol"),
        32,
      ),
      side: sideFor(quantity),
      quantity,
      displayQuantity: decimalString(record, "display_quantity", "quantity"),
      quantityMultiplier: positiveDecimalOrOne(record, "quantity_multiplier"),
      contractMultiplier: positiveDecimalOrOne(
        record,
        "contract_multiplier",
        "trade_value_multiplier",
        "multiplier",
      ),
      averageCost: decimalString(
        record,
        "average_buy_price",
        "average_price",
        "average_cost",
      ),
      costBasis: decimalString(record, "cost_basis"),
      heldQuantity: decimalString(record, "shares_held_for_sells", "held_quantity"),
      markPrice: decimalString(record, "mark_price", "adjusted_mark_price"),
      marketValue,
      providerUnrealizedPnl: unrealizedPnl,
      providerRealizedPnl: realizedPnl,
      currency: currency(record),
      priceObservedAt: timestampString(record, "price_observed_at", "updated_at"),
      providerPayload: safeProviderPayload(record, SAFE_POSITION_PAYLOAD_KEYS),
    });
  }
  if (positions.size === 0 && !hasPositionCollection(value, assetClass)) {
    throw new TypeError(`Robinhood ${assetClass} positions response is malformed`);
  }
  return {
    positions: [...positions.values()].sort((left, right) =>
      left.positionKey.localeCompare(right.positionKey)
    ),
    nextCursor: nextCursor(value),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

/**
 * Trim insignificant trailing zeros so a decimal hashes identically before and
 * after a numeric(38,18) database round-trip ("5" vs "5.000000000000000000").
 */
export function canonicalDecimalString(value: string | null): string | null {
  if (value === null || !value.includes(".")) return value;
  const trimmed = value.replace(/0+$/u, "").replace(/\.$/u, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

export interface PositionContentEntry {
  positionKey: string;
  instrumentRef: string;
  quantity: string | null;
  providerPayload: Record<string, unknown>;
}

/**
 * The canonical content-hash input for a position capture: key-sorted entries
 * with round-trip-stable decimals, so an in-memory capture and its persisted
 * rows produce the same hash.
 */
export function positionContentEntries(
  items: readonly PositionContentEntry[],
): PositionContentEntry[] {
  return [...items]
    .sort((left, right) => left.positionKey.localeCompare(right.positionKey))
    .map((item) => ({
      positionKey: item.positionKey,
      instrumentRef: item.instrumentRef,
      quantity: canonicalDecimalString(item.quantity),
      providerPayload: item.providerPayload,
    }));
}

export async function hashRobinhoodSnapshot(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
