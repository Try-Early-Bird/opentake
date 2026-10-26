// pure provider normalization.
export interface NormalizedRobinhoodExecution {
  providerExecutionRef: string | null;
  quantity: string | null;
  price: string | null;
  notionalAmount: string | null;
  feeAmount: string | null;
  occurredAt: string | null;
  providerPayload: Record<string, unknown>;
}

export interface NormalizedRobinhoodOrder {
  providerOrderRef: string;
  clientRef: string | null;
  instrumentRef: string;
  symbol: string | null;
  origin: string;
  side: string | null;
  orderType: string | null;
  timeInForce: string | null;
  state: string;
  quantity: string | null;
  notionalAmount: string | null;
  cumulativeQuantity: string | null;
  averagePrice: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  executions: NormalizedRobinhoodExecution[];
  providerPayload: Record<string, unknown>;
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

function timestampString(record: Record<string, unknown>, ...keys: string[]): string | null {
  const value = optionalString(record, ...keys);
  if (value === null) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function normalizedIdentifier(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 64);
  return /^[a-z][a-z0-9_]{1,63}$/u.test(normalized) ? normalized : fallback;
}

function recordObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 12 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => recordObjects(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const orderRef = optionalString(record, "id", "order_id");
  const state = optionalString(record, "state", "status");
  const own = orderRef !== null && state !== null ? [record] : [];
  return own.concat(
    Object.entries(record)
      .filter(([key]) => key !== "executions")
      .flatMap(([, item]) => recordObjects(item, depth + 1)),
  );
}

function executionObjects(record: Record<string, unknown>): Record<string, unknown>[] {
  const value = record.executions;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object",
  );
}

/** A Robinhood MCP page's next cursor: `next_cursor`, or the `cursor` of a `next` URL. */
export function nextCursor(value: unknown, depth = 0): string | null {
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
      // A non-URL next value is not a supported pagination token.
    }
  }
  for (const item of Object.values(record)) {
    const cursor = nextCursor(item, depth + 1);
    if (cursor !== null) return cursor;
  }
  return null;
}

export function normalizeRobinhoodOrderPage(value: unknown): {
  orders: NormalizedRobinhoodOrder[];
  nextCursor: string | null;
} {
  const unique = new Map<string, Record<string, unknown>>();
  for (const record of recordObjects(value)) {
    const orderRef = boundedString(optionalString(record, "id", "order_id"));
    if (orderRef !== null) unique.set(orderRef, record);
  }
  const orders = [...unique.entries()].map(([providerOrderRef, record]) => {
    const symbol = boundedString(optionalString(record, "symbol"), 32);
    const instrumentRef = boundedString(
      optionalString(record, "instrument_id", "option_id", "chain_id") ?? symbol,
    ) ?? `robinhood_order:${providerOrderRef}`;
    return {
      providerOrderRef,
      clientRef: boundedString(optionalString(record, "ref_id", "client_order_id")),
      instrumentRef,
      symbol,
      origin: normalizedIdentifier(optionalString(record, "placed_agent", "origin"), "unknown"),
      side: boundedString(optionalString(record, "side", "direction"), 64),
      orderType: boundedString(optionalString(record, "type", "order_type"), 64),
      timeInForce: boundedString(optionalString(record, "time_in_force"), 64),
      state: normalizedIdentifier(optionalString(record, "state", "status"), "unknown"),
      quantity: decimalString(record, "quantity"),
      notionalAmount: decimalString(record, "dollar_based_amount", "dollar_amount", "notional_amount"),
      cumulativeQuantity: decimalString(record, "cumulative_quantity"),
      averagePrice: decimalString(record, "average_price"),
      limitPrice: decimalString(record, "limit_price", "price"),
      stopPrice: decimalString(record, "stop_price"),
      sourceCreatedAt: timestampString(record, "created_at", "submitted_at"),
      sourceUpdatedAt: timestampString(record, "last_transaction_at", "updated_at"),
      executions: executionObjects(record).map((execution) => ({
        providerExecutionRef: boundedString(
          optionalString(execution, "id", "execution_id", "trade_id"),
        ),
        quantity: decimalString(execution, "quantity"),
        price: decimalString(execution, "price"),
        notionalAmount: decimalString(execution, "notional_amount", "amount"),
        feeAmount: decimalString(execution, "fee", "fee_amount"),
        occurredAt: timestampString(execution, "timestamp", "created_at", "executed_at"),
        providerPayload: execution,
      })),
      providerPayload: record,
    } satisfies NormalizedRobinhoodOrder;
  });
  return { orders, nextCursor: nextCursor(value) };
}
