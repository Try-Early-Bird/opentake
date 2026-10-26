// , adapted to local takes.
import { Link } from '@tanstack/react-router';
import { TakeIcon } from '../components/TakeIcon';
import { useLogos } from '../components/HoldingLogo';
import { instrumentKey,type BasketSpec,type BasketSummary } from '../../../shared/strategies';
import { cn } from '../lib/utils';
import { money, signedMoney } from '../portfolio/format';
import { formatWeightBps } from './StrategyCard';

export interface OwnedTakeRowData extends BasketSummary {
  iconId?: string | null;
  description: string | null;
  spec: BasketSpec | null;
  startedAt: string | null;
  funded?: boolean;
  investedValue: string | null;
  returnPercent: number | null;
  totalPnl: number | null;
  currency: string;
}

function formatAge(iso: string | null): string {
  const started = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(started)) return '—';
  const days = Math.max(0, Math.floor((Date.now() - started) / 86_400_000));
  if (days < 60) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

// Holdings show their logo; a symbol without one gets a dot by position. Cash is always grey.
const DOT_COLORS = ['#8b5cf6', '#14b8a6', '#f97316', '#ec4899'] as const;

/** Column widths shared by the list header and each row. */
export const TAKE_COLUMNS = 'grid grid-cols-[minmax(0,1fr)_6.5rem_5.5rem_3rem] items-center gap-x-4';

/** Invested: the take holds money now. */
export function isInvested(take: OwnedTakeRowData): boolean {
  return take.status !== 'draft' && (take.funded ?? (take.investedValue !== null && Number(take.investedValue) > 0));
}

export function OwnedTakeRow({ take }: { take: OwnedTakeRowData }): React.JSX.Element {
  const weights = [...(take.spec?.target.weights ?? [])].sort((a, b) => b.bps - a.bps);
  const chips = weights.slice(0, 4);
  const cashBps = take.spec?.target.cashBps ?? 0;
  const logos = useLogos(chips.filter(w=>!w.instrument.market).map((weight) => weight.instrument.symbol));
  const isDraft = take.status === 'draft';
  const invested = isInvested(take);
  const pnl = invested ? take.totalPnl : null;
  const tone = pnl === null ? 'text-muted-foreground' : pnl >= 0 ? 'text-success' : 'text-error';
  return (
    <li>
      <Link to="/strategies/$strategyId" params={{ strategyId: take.strategyId }}
        className={cn(TAKE_COLUMNS, 'rounded-md px-3 py-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <TakeIcon iconId={take.iconId} className="size-5 shrink-0 rounded object-cover" />
            <h2 className="min-w-0 truncate text-sm row-title">{take.title}</h2>
            {take.archivedAt !== null && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Archived</span>}
            {take.dirty && !isDraft && <span className="shrink-0 rounded-full bg-attention/15 px-2 py-0.5 text-[10px] font-medium text-attention">Changes to review</span>}
          </div>
          {take.description && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{take.description}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {chips.map(({ instrument, bps }, index) => (
              <span key={instrumentKey(instrument)} className="inline-flex items-center gap-1 tabular-nums">
                {!instrument.market&&logos.get(instrument.symbol)
                  ? <img src={logos.get(instrument.symbol)!} alt="" className="size-3.5 rounded-full object-cover" />
                  : <span className="size-1.5 rounded-full" style={{ backgroundColor: DOT_COLORS[index] }} aria-hidden="true" />}
                <span className="font-medium text-foreground">{instrument.symbol}{instrument.market?' · Crypto':''}</span> {formatWeightBps(bps)}
              </span>
            ))}
            {weights.length > chips.length && <span>+{weights.length - chips.length} more</span>}
            {cashBps > 0 && <span className="inline-flex items-center gap-1 tabular-nums"><span className="size-1.5 rounded-full bg-muted-foreground" aria-hidden="true" /><span className="font-medium text-foreground">Cash</span> {formatWeightBps(cashBps)}</span>}
            {take.spec === null && <span>Allocation details unavailable</span>}
          </div>
        </div>
        <div className="text-right">
          {invested ? <span className="text-sm tabular-nums">{take.investedValue === null ? '—' : money(take.investedValue, take.currency)}</span>
            : <span className="text-xs text-muted-foreground">Not invested</span>}
        </div>
        <div className={cn('flex flex-col items-end tabular-nums', tone)}>
          {pnl === null ? <span>—</span> : <>
            <span className="text-sm font-medium">{signedMoney(pnl, take.currency)}</span>
            {take.returnPercent !== null && <span className="text-[11px] font-medium">{Math.abs(take.returnPercent).toFixed(2)}%</span>}
          </>}
        </div>
        <div className="text-right text-xs tabular-nums text-muted-foreground">{formatAge(take.startedAt)}</div>
      </Link>
    </li>
  );
}
