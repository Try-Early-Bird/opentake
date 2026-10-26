export interface SymbolTradability {
  symbol: string;
  tradable: boolean | null;
  fractional: boolean | null;
  /** The provider's own wording when it gave one, for the editor to show. */
  detail: string | null;
  /** Issuer name when the payload carries one (simple_name, else name). */
  name: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function affirmative(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const word = text(value)?.toLowerCase();
  if (word === null || word === undefined) return null;
  if (["tradable", "true", "yes", "enabled", "allowed", "active"].includes(word)) return true;
  if (["untradable", "not_tradable", "false", "no", "disabled", "restricted", "position_closing_only", "inactive"].includes(word)) return false;
  return null;
}

/** Resolve only the selected account type; conflicting unscoped facts stay unknown. */
function accountTypeVerdict(value: unknown, accountType?:string|null): boolean | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries=value.filter((entry):entry is Record<string,unknown>=>entry!==null&&typeof entry==='object');
  // Robinhood keys these by brokerage account type ("individual"), while the account may
  // carry its margin type ("limited_margin"): with no entry for the given type, entries
  // that all agree still answer; conflicting ones stay unknown.
  const matching=accountType?entries.filter(entry=>text(entry.account_type)?.toLowerCase()===accountType.toLowerCase()):entries;
  const scoped=matching.length?matching:entries;
  const verdicts=scoped.map(entry=>affirmative(entry.account_type_tradability??entry.tradability));
  if(!verdicts.length||verdicts.some(v=>v===null)||new Set(verdicts).size!==1)return null;
  return verdicts[0];
}

function records(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => records(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (text(record.symbol) !== null) return [record];
  return Object.values(record).flatMap((item) => records(item, depth + 1));
}

/** Missing provider facts remain unknown; policy decides what they mean. */
export function normalizeTradability(value: unknown, requested: readonly string[], accountType?:string|null): SymbolTradability[] {
  const bySymbol = new Map<string, SymbolTradability>();
  for (const record of records(value)) {
    const symbol = text(record.symbol)!.toUpperCase();
    // The live tool spells it `tradeable` and reports `state: active`; any
    // explicit "untradable" or inactive state overrides the rest.
    const headline = affirmative(record.tradeable) ?? affirmative(record.tradability) ??
      affirmative(record.is_tradable) ?? affirmative(record.tradable);
    const state = affirmative(record.state);
    const byAccountType = accountTypeVerdict(record.account_type_tradabilities,accountType);
    const hasAccountTypes=Array.isArray(record.account_type_tradabilities)&&record.account_type_tradabilities.length>0;
    const tradable = state === false || headline === false || byAccountType === false
      ? false
      : (hasAccountTypes?byAccountType:(headline ?? state ?? null));
    let fractional: boolean | null = affirmative(record.fractional_tradability) ??
      affirmative(record.is_fractional_tradable) ?? affirmative(record.fractional);
    if (fractional === null) {
      const anyFractional = Object.entries(record)
        .filter(([key]) => key.includes("fractional"))
        .map(([, item]) => affirmative(item))
        .filter((item): item is boolean => item !== null);
      fractional = anyFractional.length === 0 ? null : anyFractional.some(Boolean);
    }
    bySymbol.set(symbol, {
      symbol,
      tradable,
      fractional: tradable === false ? false : fractional,
      detail: text(record.reason) ?? text(record.message) ?? text(record.detail) ?? null,
      name: text(record.simple_name) ?? text(record.name) ?? null,
    });
  }
  return requested.map((symbol) => {
    const key = symbol.toUpperCase();
    return bySymbol.get(key) ?? { symbol: key, tradable: null, fractional: null, detail: "Not reported by Robinhood", name: null };
  });
}
