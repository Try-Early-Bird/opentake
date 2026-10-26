export function money(value: string | number | null | undefined, currency = "USD"): string {
  const amount = Number(value ?? 0);
  // Intl takes ISO 4217 codes only; a unit like USDC reads as an amount of it.
  if (!/^[A-Z]{3}$/.test(currency)) return assetAmount(Number.isFinite(amount) ? amount : 0, currency);
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

/** Cash-like units read to the cent; everything else keeps its precision. */
const CASH_UNITS = new Set(["USD", "USDC", "USDT", "DAI", "PYUSD", "USDP", "GUSD", "FDUSD", "EUR", "EURC", "GBP", "CAD", "AUD", "CHF", "JPY"]);

/** An amount of an asset with its unit, in `formatShares` tiers:
 *  "1.2K SOL", "12.35 SOL", "0.1235 ETH",
 *  "0.00123457 BTC". Below 0.01 it keeps up to 8 decimals, as that helper
 *  documents, so a satoshi still shows. Cash-like units read like money:
 *  "1,234.56 USDC". Providers send up to 18 decimals; none of them reach here. */
export function assetAmount(value: string | number, unit: string): string {
  return `${assetQuantity(value, unit)} ${unit.toUpperCase()}`;
}

/** The number part of `assetAmount`, for rows that show the unit elsewhere. */
export function assetQuantity(value: string | number, unit?: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  const size = Math.abs(amount);
  const options: Intl.NumberFormatOptions = unit !== undefined && CASH_UNITS.has(unit.toUpperCase())
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : size >= 999
      ? { notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1 }
      : size >= 1
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : size >= 0.01
          ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
          : { maximumFractionDigits: 8 };
  return Intl.NumberFormat("en-US", options).format(amount);
}

export function quantity(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(amount)
    : value;
}

/** The direction mark every gain or loss leads with: "▲ ", "▼ ", or nothing when flat. */
export function changeArrow(value: number): string {
  return value > 0 ? "▲ " : value < 0 ? "▼ " : "";
}

/** "▲ $1.20" / "▼ $0.40", for a move in money. */
export function signedMoney(value: string | number, currency = "USD"): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `${changeArrow(amount)}${money(Math.abs(amount), currency)}`;
}

/** "▲ 1.50%" / "▼ 2.00%", for a move in percent. */
export function signedPercent(value: string | number, digits = 2): string {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "—";
  return `${changeArrow(percent)}${Math.abs(percent).toFixed(digits)}%`;
}
