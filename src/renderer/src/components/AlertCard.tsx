import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CircleAlert } from 'lucide-react';

// Something went wrong that needs the member to choose: a sale they made in
// Robinhood reached an investment, or cash an investment held left the
// account. A header with what happened, where it came from, and the signed
// amount it cost; the facts as label/value rows; then what the main action
// does and the actions themselves. Error colors come from the theme.

export interface AlertRow {
  label: string;
  value: string;
  /** Drawn in the error color: the part that belongs to this investment. */
  accent?: boolean;
}

export interface AlertAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function AlertCard({ title, source, value, rows, footnote, primary, secondary }: {
  title: string;
  source: string;
  /** Signed and formatted, e.g. "−0.004" or "−$4.20". */
  value?: string | null;
  rows: readonly AlertRow[];
  footnote: string;
  primary?: AlertAction;
  secondary?: AlertAction;
}): React.JSX.Element {
  return (
    <section data-investment-card role="status" className="mt-3 overflow-hidden rounded-xl border border-error/30 bg-card text-card-foreground">
      <header className="flex items-start gap-2.5 border-b border-border px-4 py-3">
        <CircleAlert size={16} className="mt-0.5 shrink-0 text-error" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm row-title leading-5 text-pretty">{title}</h3>
          <p className="text-xs text-muted-foreground">{source}</p>
        </div>
        {value != null && <span className="text-sm font-semibold tabular-nums text-error">{value}</span>}
      </header>
      {rows.length > 0 && <dl className="space-y-1.5 px-4 py-3 text-[13px]">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className={cn('tabular-nums', row.accent === true ? 'font-medium text-error' : 'font-medium')}>{row.value}</dd>
          </div>
        ))}
      </dl>}
      <footer className={cn('bg-muted/40 px-4 py-3', rows.length > 0 && 'border-t border-border')}>
        <p className="text-xs text-muted-foreground text-pretty">{footnote}</p>
        {(primary !== undefined || secondary !== undefined) && (
          <div className="mt-2.5 flex gap-2">
            {primary !== undefined && (
              <Button size="sm" className="flex-1" onClick={primary.onClick} disabled={primary.disabled}>
                {primary.label}
              </Button>
            )}
            {secondary !== undefined && (
              <Button size="sm" variant="outline" onClick={secondary.onClick} disabled={secondary.disabled}>
                {secondary.label}
              </Button>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}
