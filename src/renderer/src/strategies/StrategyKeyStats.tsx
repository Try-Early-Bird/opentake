// fundamentals come from the local connection.
import { money } from '../portfolio/format';
import { RollingNumber } from '../components/RollingNumber';
import { useEffect, useMemo, useState } from 'react';

import type { StrategyCardData } from './preview-data';

// Blended figures for a strategy, weighted by allocation from each holding's
// Robinhood fundamentals snapshot: yield, valuation, size, and the sector
// mix, beside structural facts (holdings, cash, largest position, follower
// floor). Coverage is shown when some holdings lack a figure, so a blended
// number is never quietly built from half the basket.

interface Snapshot {
  dividendYield: number | null;
  peRatio: number | null;
  marketCap: number | null;
  sector: string | null;
}

function numeric(record: Record<string, unknown> | undefined, key: string): number | null {
  const raw = record?.[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replaceAll(',', '')) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function compactMoney(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toFixed(0)}`;
}

/** Weight-averaged figure over the holdings that report it, with the share of weight covered. */
function blended(
  weights: readonly { symbol: string; weightBps: number }[],
  snapshots: ReadonlyMap<string, Snapshot>,
  pick: (snapshot: Snapshot) => number | null,
): { value: number; coverage: number } | null {
  let total = 0;
  let covered = 0;
  let sum = 0;
  for (const weight of weights) {
    total += weight.weightBps;
    const value = pick(snapshots.get(weight.symbol) ?? { dividendYield: null, peRatio: null, marketCap: null, sector: null });
    if (value === null) continue;
    covered += weight.weightBps;
    sum += value * weight.weightBps;
  }
  if (covered === 0 || total === 0) return null;
  return { value: sum / covered, coverage: covered / total };
}

/** `rollingNote` rolls the note's digits as it changes, as the chart header does while scrubbing. */
function Stat({ label, value, note, rollingNote = false }: { label: string; value: string; note?: string; rollingNote?: boolean }): React.JSX.Element {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-sm tabular-nums text-foreground/90">{value}</p>
      {note !== undefined && <p className="text-[11px] text-muted-foreground">{rollingNote ? <RollingNumber value={note} /> : note}</p>}
    </div>
  );
}

export function StrategyKeyStats({ strategy, minimumAllocation, investedAsOf }: {
  strategy: StrategyCardData;
  /** Set while a chart point is hovered: `investedValue` is your value then, not now. */
  investedAsOf?: string;
  /** Follower floor in USD, when known. */
  minimumAllocation?: number | null;
}): React.JSX.Element | null {
  // Stats describe the portfolio as it stands: the model's current weights
  // once valued (they drift with the market), else the published targets.
  const weights = useMemo(() => {
    const current = strategy.targets.currentAsOf != null;
    return strategy.targets.weights
      .map((weight) => ({ ...weight, weightBps: current ? (weight.currentWeightBps ?? weight.weightBps) : weight.weightBps }))
      .filter((weight) => weight.weightBps > 0);
  }, [strategy]);
  const symbols = useMemo(() => weights.map((weight) => weight.symbol).sort().join(','), [weights]);
  const [snapshots, setSnapshots] = useState<Map<string, Snapshot>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const list = symbols === '' ? [] : symbols.split(',');
    if (list.length === 0) return;
    void window.portfolio.fundamentals(list).catch(() => ({} as Record<string, Record<string, unknown>>)).then((records) => {
      if (cancelled) return;
      setSnapshots(new Map(list.map((symbol) => {
        const record = records[symbol];
        // Robinhood files funds under "Miscellaneous", which says nothing about what they hold.
        const rawSector = typeof record?.sector === 'string' ? record.sector.trim() : '';
        const sector = rawSector !== '' && rawSector.toLowerCase() !== 'miscellaneous' ? rawSector : null;
        return [symbol, {
          dividendYield: numeric(record, 'dividend_yield'),
          peRatio: numeric(record, 'pe_ratio'),
          marketCap: numeric(record, 'market_cap'),
          sector,
        }] as const;
      })));
    });
    return () => {
      cancelled = true;
    };
  }, [symbols]);

  if (weights.length === 0) return null;

  const cashPercent = (strategy.targets.currentAsOf != null ? (strategy.targets.currentCashBps ?? strategy.targets.cashReserveBps) : strategy.targets.cashReserveBps) / 100;
  const largest = weights.reduce((top, weight) => (weight.weightBps > top.weightBps ? weight : top), weights[0]!);
  const yieldStat = blended(weights, snapshots, (snapshot) => snapshot.dividendYield);
  const peStat = blended(weights, snapshots, (snapshot) => snapshot.peRatio);
  const capStat = blended(weights, snapshots, (snapshot) => snapshot.marketCap);
  const coverageNote = (stat: { coverage: number } | null): string | undefined =>
    stat === null || stat.coverage >= 0.999 ? undefined : `${Math.round(stat.coverage * 100)}% of holdings report this`;

  // Sector mix by weight, from holdings that name one.
  const sectors = new Map<string, number>();
  let sectorCovered = 0;
  for (const weight of weights) {
    const sector = snapshots.get(weight.symbol)?.sector;
    if (sector === null || sector === undefined) continue;
    sectorCovered += weight.weightBps;
    sectors.set(sector, (sectors.get(sector) ?? 0) + weight.weightBps);
  }
  const topSectors = [...sectors].sort((left, right) => right[1] - left[1]).slice(0, 3);

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Stat label="Holdings" value={String(weights.length)} note={cashPercent > 0 ? `plus ${cashPercent}% cash` : undefined} />
        <Stat label="Largest position" value={`${(largest.weightBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`} note={largest.symbol} />
        <Stat label="Dividend yield" value={yieldStat === null ? '—' : `${yieldStat.value.toFixed(2)}%`} note={coverageNote(yieldStat) ?? 'weighted, trailing'} />
        <Stat label="Price-earnings" value={peStat === null ? '—' : peStat.value.toFixed(1)} note={coverageNote(peStat) ?? 'weighted'} />
        <Stat label="Market cap" value={capStat === null ? '—' : compactMoney(capStat.value)} note={coverageNote(capStat) ?? 'weighted average'} />
        <Stat
          label="Minimum investment"
          value={minimumAllocation === null || minimumAllocation === undefined ? '—' : `$${minimumAllocation.toLocaleString()}`}
          note="so every position clears $1"
        />
        {strategy.investors !== undefined && (
          <Stat
            label="Investors"
            value={strategy.investors === 0 ? '—' : strategy.investors.toLocaleString()}
            note={strategy.investedValue === null || strategy.investedValue === undefined ? undefined : `${money(strategy.investedValue, 'USD')} ${investedAsOf === undefined ? 'invested' : `on ${investedAsOf}`}`}
            rollingNote
          />
        )}
        {topSectors.length > 0 && (
          <Stat
            label="Top sectors"
            value={topSectors.map(([sector, bps]) => `${sector} ${Math.round(bps / 100)}%`).join(' · ')}
            note={sectorCovered < weights.reduce((sum, weight) => sum + weight.weightBps, 0) * 0.999 ? 'where reported' : undefined}
          />
        )}
      </div>
    </div>
  );
}
