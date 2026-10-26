import type {ReactNode} from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Clock, RefreshCw } from 'lucide-react';

// Something scheduled to happen on the member's behalf -- a withdrawal
// waiting for settlement, a deposit waiting for the open, a close that will
// sell once it can -- as a card: what it is and how much, a short timeline of
// what happens next, and what the member can still do. Presentational only:
// callers map their own records onto steps, so any source can use it. Colors
// come from the theme: the brand accent marks the step still to come.

export interface ScheduledStep {
  heading: string;
  text: string;
  /** The step still to come, drawn as an open ring in the brand accent. */
  upcoming: boolean;
}

export function ScheduledCard({ children, subtitle, title, amount, steps, footer, busy = false, onConfirm, onCancel, onRefresh, cancelLabel = 'Cancel', confirmLabel = 'Confirm' }: {
  children?: ReactNode;
  title: string;
  subtitle?: string;
  /** Shown on the right of the header, already formatted. */
  amount?: string | null;
  steps: readonly ScheduledStep[];
  footer: string;
  busy?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  onRefresh?: () => void;
  cancelLabel?: string;
  confirmLabel?: string;
}): React.JSX.Element {
  return (
    <section data-investment-card role="status" className="mt-3 overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Clock size={16} className="mt-0.5 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1"><h3 className="break-words text-sm leading-5 row-title">{title}</h3>{subtitle&&<p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}</div>
        {amount != null && <span className="shrink-0 whitespace-nowrap text-sm font-semibold leading-5 tabular-nums">{amount}</span>}
        {onRefresh && <Button size="icon-sm" variant="outline" className="shrink-0" onClick={onRefresh} disabled={busy} aria-label="Refresh status" title="Refresh status"><RefreshCw size={14} aria-hidden /></Button>}
      </header>
      <ol className="px-4 py-3">
        {steps.map((step, index) => (
          <li key={`${index}-${step.heading}`} className="relative flex gap-3 pb-3 last:pb-0">
            {index < steps.length - 1 && (
              <span className="absolute top-4 bottom-0 left-[4px] w-px bg-border" aria-hidden />
            )}
            <span
              className={cn(
                'relative mt-1.5 size-[9px] shrink-0 rounded-full',
                step.upcoming ? 'border-2 border-brand bg-transparent' : 'bg-muted-foreground',
              )}
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-sm font-medium leading-5">{step.heading}</p>
              <p className="text-xs text-muted-foreground text-pretty">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {children}
      {(footer||onConfirm||onCancel)&&<footer className="flex items-center gap-3 border-t border-border bg-muted/40 px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground text-pretty">{footer}</p>
        {onConfirm !== undefined && (
          <Button size="sm" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        )}
        {onCancel !== undefined && (
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
            {busy ? 'Working…' : cancelLabel}
          </Button>
        )}
      </footer>}
    </section>
  );
}
