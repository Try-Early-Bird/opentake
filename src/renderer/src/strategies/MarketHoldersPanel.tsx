import { ActivityRows, type ActivityItem } from '../components/ActivityRows';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { cn } from '../lib/utils';
import { money, quantity, signedMoney } from '../portfolio/format';
import type { Position } from '../portfolio/types';
import type { PortfolioStrategy, PositionAttribution } from '../../../shared/portfolio';
import type { BasketSummary } from '../../../shared/strategies';

// The market page's side
// panel: the member's position in this symbol, split between shares they
// bought and shares their strategies hold for them, then every strategy that
// includes it. Self-hosted has no public catalog, so the list is the local
// strategies.

/** How one of the member's own strategies is labelled here, as the Strategies screen labels it; committed needs no label. */
function ownLabel(strategy: BasketSummary): string | null {
  if (strategy.archivedAt !== null) return 'Archived';
  if (strategy.status === 'draft') return 'Draft';
  return strategy.dirty ? 'Uncommitted changes' : null;
}

export function MarketHoldersPanel({ symbol, holding, strategies, currency, series, venue = "robinhood", accountControl, positionMessage, showAttribution = true, attributedPositions, activity }: {
  activity?: ActivityItem[];
  symbol: string;
  venue?: "robinhood" | "coinbase";
  accountControl?: ReactNode;
  positionMessage?: string;
  showAttribution?: boolean;
  attributedPositions?:PositionAttribution[];
  holding: Position | undefined;
  strategies: readonly PortfolioStrategy[];
  currency: string;
  /** Today's move, as the chart header derives it. */
  series: { change: { amount: string; percent: string } | null; extendedChange: { amount: string; percent: string } | null } | undefined;
}): React.JSX.Element {
  const [holders, setHolders] = useState<{ id: string; takeId: string; name: string; weightPercent: number; by: string | null }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.strategies.list(false), window.strategies.list(true)]).then(async ([active, archived]) => {
      const rows = await Promise.all([...active, ...archived].map(async (strategy) => {
        const view = await window.strategies.read(strategy.targetTakeId).catch(() => null);
        // The committed version when there is one, else the draft.
        const spec = view?.versions.find((version) => version.id === view.currentVersion)?.payload.spec ?? view?.draft.spec;
        const weight = spec?.target.weights.find((item) => item.instrument.venue === venue && item.instrument.symbol.toUpperCase() === symbol);
        return weight === undefined ? [] : [{ id: strategy.strategyId, takeId: strategy.targetTakeId, name: strategy.title, weightPercent: weight.bps / 100, by: ownLabel(strategy) }];
      }));
      if (!cancelled) setHolders(rows.flat().sort((left, right) => right.weightPercent - left.weightPercent));
    }).catch(() => {
      if (!cancelled) setHolders([]);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol, venue]);

  const price = holding?.positionValue !== null && holding !== undefined && Number(holding.size) > 0
    ? Number(holding.positionValue) / Number(holding.size)
    : null;

  // Shares held by strategies come from each allocation's attributed positions.
  const byStrategy = useMemo(() => attributedPositions?attributedPositions.map(item=>({item,position:{quantity:item.quantity}})):[...strategies]
    .sort((left, right) => Number(right.value ?? 0) - Number(left.value ?? 0))
    .map((item) => ({ item, position: item.positions.find((position) => position.symbol?.toUpperCase() === symbol) }))
    .filter((entry): entry is { item: PortfolioStrategy; position: PortfolioStrategy['positions'][number] } => entry.position !== undefined && Number(entry.position.quantity) > 0),
  [strategies, symbol, attributedPositions]);
  const totalShares = holding === undefined ? 0 : Number(holding.size);
  const ownShares = Math.max(0, totalShares - byStrategy.reduce((sum, entry) => sum + Number(entry.position.quantity), 0));

  // What each take holds for you, shown under its name in Takes holding; one take may follow through several allocations.
  const heldByTake = useMemo(() => {
    const held = new Map<string, { title: string; quantity: number }>();
    if (!showAttribution) return held;
    for (const { item, position } of byStrategy) {
      const current = held.get(item.strategyId);
      held.set(item.strategyId, { title: item.title, quantity: (current?.quantity ?? 0) + Number(position.quantity) });
    }
    return held;
  }, [byStrategy, showAttribution]);
  // A take still holding it after dropping it from its weights keeps a row, without a weight.
  const rows = useMemo(() => [
    ...holders,
    ...[...heldByTake].filter(([id]) => !holders.some((row) => row.id === id)).map(([id, held]) => ({ id, name: held.title, weightPercent: null, by: null })),
  ], [holders, heldByTake]);

  const move = series?.extendedChange ?? series?.change ?? null;
  const todayAmount = move === null || holding === undefined ? null : Number(move.amount) * totalShares;
  const pnl = holding?.unrealizedPnl === null || holding === undefined ? null : Number(holding.unrealizedPnl);

  return (
    <div className="space-y-8">
      <section aria-label="Your position">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Your position</p>
        {accountControl}
        {positionMessage !== undefined ? <p className="mt-2 text-[13px] text-muted-foreground">{positionMessage}</p> : holding === undefined ? (
          <p className="mt-2 text-[13px] text-muted-foreground">You don’t hold {symbol}.</p>
        ) : (
          <>
            <p className="font-display mt-2 text-2xl tabular-nums">{holding.positionValue === null ? '—' : money(holding.positionValue, currency)}</p>
            <p className="mt-1 text-[13px] tabular-nums text-muted-foreground">{quantity(holding.size)} {venue === "coinbase" ? symbol : "shares"}{` · Avg ${holding.averageEntryPrice !== null ? money(holding.averageEntryPrice, currency) : '—'}`}</p>
            <dl className="mt-3 text-[13px]">
              <div className="flex items-center justify-between py-2">
                <dt className="text-muted-foreground">{venue === "coinbase" ? "Past 24h" : "Today"}</dt>
                <dd className={cn('tabular-nums', todayAmount === null ? 'text-muted-foreground' : todayAmount < 0 ? 'text-error' : 'text-success')}>{todayAmount === null ? '—' : signedMoney(todayAmount, currency)}</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-muted-foreground">Total return</dt>
                <dd className={cn('tabular-nums', pnl === null ? 'text-muted-foreground' : pnl < 0 ? 'text-error' : 'text-success')}>{pnl === null ? '—' : signedMoney(pnl, currency)}</dd>
              </div>
              {showAttribution && byStrategy.length > 0 && ownShares > 0 && <div className="flex items-center justify-between py-2">
                <dt className="text-muted-foreground">Held by you</dt>
                <dd className="tabular-nums">{quantity(String(ownShares))}{price !== null ? ` · ${money(String(ownShares * price), currency)}` : ''}</dd>
              </div>}
            </dl>
          </>
        )}
      </section>

      <section aria-label={`Takes holding ${symbol}`}>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Takes holding {symbol}</p>
        {rows.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border text-[13px]">
            {rows.map((row) => {
              const held = heldByTake.get(row.id);
              const detail = [
                held === undefined ? null : `${quantity(String(held.quantity))}${price !== null ? ` · ${money(String(held.quantity * price), currency)}` : ''}`,
                row.by,
              ].filter((part) => part !== null).join(' · ');
              return (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <Link to="/strategies/$strategyId" params={{ strategyId: row.id }} className="block truncate font-normal hover:underline">{row.name}</Link>
                    {detail !== '' && <span className="block truncate text-[11px] tabular-nums text-muted-foreground">{detail}</span>}
                  </span>
                  {row.weightPercent !== null && <span className="shrink-0 tabular-nums">{row.weightPercent}%</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {activity && <section aria-label="Asset activity">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Activity</p>
        {activity.length ? <div className="mt-2 max-h-80 overflow-y-auto"><ActivityRows items={activity} currency={currency}/></div> : <p className="mt-2 text-[13px] text-muted-foreground">Nothing yet.</p>}
      </section>}
    </div>
  );
}
