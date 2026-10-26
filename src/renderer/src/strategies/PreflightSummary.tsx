import { useEffect, useState } from 'react';

import { money } from '../portfolio/format';
import { allocationActions } from './allocation-actions';

// What an amount would buy, shown before the member commits it. The server
// uses the planner's sizing engine against current account evidence. Market
// prices and provider review can change before orders are placed.

export interface Preflight {
  ok: boolean;
  kind: 'subscription' | 'contribution';
  amount: string;
  legs: { symbol: string; instrumentRef?:string; venue?:string; assetClass?:string; weightPercent: number; notional: string }[];
  retainedCash: string;
  allocationReason?: string;
  existingCashUsed?: string;
  orderReserveUsd?:string;
  minimumAmount: string;
  reasons: { code: string; symbols: string[]; needed?: string; message?:string }[];
  modelValuedOn: string | null;
  expectedValuedOn: string | null;
}

/** Reads the preflight for an amount, settling after the member stops typing. */
export function usePreflight(
  target: { strategyId: string } | { bucketId: string },
  amount: string,
  enabled: boolean,
): Preflight | null {
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  // The execution layer answers preflights; until it exists nothing is asked.
  const strategies = allocationActions;
  const key = 'bucketId' in target ? target.bucketId : target.strategyId;
  const value = Number(amount);
  useEffect(() => {
    if (strategies === null || !enabled || !Number.isFinite(value) || value <= 0) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void strategies
        .getStrategyPreflight(target, value.toFixed(2))
        .then((result: { status: number; preflight: unknown | null }) => {
          if (!cancelled) setPreflight(result.status === 200 ? (result.preflight as Preflight) : null);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [strategies, key, value, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return preflight;
}

/** The member's own words for why an amount cannot be put to work. */
function reasonText(
  reason: { code: string; symbols: string[]; needed?: string; message?:string },
  kind: Preflight['kind'],
): string {
  if(reason.message)return reason.message;
  const symbols = reason.symbols.join(', ');
  switch (reason.code) {
    case 'fresh_position_snapshot_required':
    case 'crypto_sizing_evidence_required':
      return 'Refresh account data before sizing this purchase.';
    case 'sizing_unavailable':
    case 'incomplete_basket':
      return 'This amount cannot buy the required holdings within current trading limits.';
    case 'leg_below_minimum':
      return `Minimum ${money(reason.needed ?? '0', 'USD')} required; below that ${symbols} cannot be bought.`;
    case 'symbol_not_tradable':
      return `${symbols} cannot be traded right now, so this take cannot be bought until its author replaces it.`;
    case 'symbol_not_fractional':
      return `${symbols} can only be bought in whole shares, so a share of it cannot be bought for you.`;
    case 'symbol_blocked':
      return `This take holds ${symbols}, which you blocked in Settings.`;
    case 'insufficient_cash':
      return 'Not enough uninvested cash in this account for that amount.';
    case 'exceeds_account_value':
      return `At most ${money(reason.needed ?? '0', 'USD')} can be invested: that is what this account is worth after what your other takes already hold.`;
    case 'model_stale':
      return 'This take has not been valued since the last close, so the buys wait for tonight’s valuation.';
    case 'no_targets':
      return 'This take has no holdings to buy yet.';
    default:
      return reason.code;
  }
}

/**
 * Anything a plain minimum cannot say comes first: a holding the provider will
 * not trade, cash that is not there, buys that wait for tonight's valuation.
 * What the money buys follows as detail, because the member has usually
 * already decided by then.
 *
 * `minimumShown` drops the size reason: the surface is displaying the floor as
 * a standing line, so repeating it here would say the same thing twice.
 */
export function PreflightSummary({
  preflight,
  currency,
  minimumShown = false,
}: {
  preflight: Preflight | null;
  currency: string;
  minimumShown?: boolean;
}): React.JSX.Element {
  if (preflight === null) return <></>;
  const reasons = preflight.reasons.filter((reason) =>
    !(minimumShown && reason.code === 'leg_below_minimum'));
  const showLegs = preflight.legs.length > 0 && preflight.ok;
  if (reasons.length === 0 && !showLegs) return <></>;
  const hidden = Math.max(0, preflight.legs.length - 6);
  return (
    <div className="mt-2 rounded-lg bg-muted/40 p-2.5">
      {reasons.map((reason) => (
        <p
          key={reason.code}
          className={`text-[11px] ${reason.code === 'model_stale' ? 'text-muted-foreground' : 'text-error'}`}
        >
          {reasonText(reason, preflight.kind)}
        </p>
      ))}
      {showLegs && (
        <>
          <p className={`text-[11px] text-muted-foreground ${reasons.length > 0 ? 'mt-1.5' : ''}`}>
            This buys
          </p>
          {preflight.kind==='contribution'&&<p className="mt-1 text-[11px] text-muted-foreground">{preflight.allocationReason??'Buys bring this Take closer to its target weights.'}</p>}
          <ul className="mt-1 space-y-0.5">
            {preflight.legs.slice(0, 6).map((leg) => (
              <li key={leg.instrumentRef??leg.symbol} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-medium">{leg.symbol}{leg.venue&&leg.assetClass&&<span className="ml-1.5 text-muted-foreground font-normal">{leg.assetClass==='crypto'?'Crypto':'Equity'} · {leg.venue==='robinhood'?'Robinhood':leg.venue}</span>}</span>
                <span className="tabular-nums text-muted-foreground">{money(leg.notional, currency)}</span>
              </li>
            ))}
          </ul>
          {Number(preflight.existingCashUsed??'0')>0&&<p className="mt-1 text-[11px] text-muted-foreground">Includes {money(preflight.existingCashUsed!,currency)} of cash already in this Take.</p>}
          {hidden > 0 && <p className="mt-1 text-[11px] text-muted-foreground">+{hidden} more</p>}
          {Number(preflight.orderReserveUsd??'0')>0&&<p className="mt-1 text-[11px] text-muted-foreground">Up to {money(preflight.orderReserveUsd!,currency)} is reserved for price movement and fees.</p>}
          {Number(preflight.retainedCash) > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {money(preflight.retainedCash, currency)} remains as cash after order reserves.
            </p>
          )}
        </>
      )}
    </div>
  );
}
