import { decimalToScaledInteger } from "./decimal";

// Shares that appeared without an order. The provider tags a
// reinvestment `drip` on the order, and that tag is what attribution keys
// on. This is the safety net for the day the tag is missing or the order
// never reaches the feed: a share count that rose with no buy from anyone,
// on a symbol that pays dividends, with the account's cash falling by about
// what the shares were worth, is probably a reinvested dividend. Probably
// is the most this says. It marks the increase for an operator rather than
// attributing it, because attributing a member's own purchase to a strategy
// is the wrong direction to be wrong in.

export type UnexplainedIncreaseVerdict = "probable_reinvestment" | "unexplained";

export interface UnexplainedIncrease {
  symbol: string;
  /** Shares the position rose by, between two complete snapshots. */
  increase: string;
  /** The symbol's trailing dividend yield in percent, or null when the catalog has none. */
  dividendYieldPercent: number | null;
  /** Mark of the symbol at the later snapshot, or null. */
  markPriceUsd: string | null;
  /** Account cash at the later snapshot less cash at the earlier one. */
  cashChangeUsd: string | null;
}

const SCALE = 10n ** 18n;
/** How far the cash fall may differ from the shares' worth: a cent, or five percent, whichever is larger. */
const CENT = 10n ** 16n;

function signed(value: string): bigint {
  const trimmed = value.trim();
  return trimmed.startsWith("-") ? -decimalToScaledInteger(trimmed.slice(1)) : decimalToScaledInteger(trimmed);
}

/**
 * Whether an increase looks like a reinvested dividend. All three signs are
 * required: a dividend payer, a mark to value the shares at, and cash that
 * fell by about that value. Any missing, and it is merely unexplained.
 */
export function classifyUnexplainedIncrease(increase: UnexplainedIncrease): {
  verdict: UnexplainedIncreaseVerdict;
  /** What the shares were worth at the mark, when it is known. */
  worthUsd: string | null;
} {
  const shares = decimalToScaledInteger(increase.increase);
  if (shares <= 0n) return { verdict: "unexplained", worthUsd: null };
  const paysDividends = increase.dividendYieldPercent !== null && increase.dividendYieldPercent > 0;
  if (increase.markPriceUsd === null) return { verdict: "unexplained", worthUsd: null };
  const worth = shares * decimalToScaledInteger(increase.markPriceUsd) / SCALE;
  const worthUsd = (Number((worth + CENT / 2n) / CENT) / 100).toFixed(2);
  if (!paysDividends || increase.cashChangeUsd === null) return { verdict: "unexplained", worthUsd };
  const cashFell = -signed(increase.cashChangeUsd);
  const tolerance = worth / 20n > CENT ? worth / 20n : CENT;
  const difference = cashFell > worth ? cashFell - worth : worth - cashFell;
  return { verdict: difference <= tolerance ? "probable_reinvestment" : "unexplained", worthUsd };
}
