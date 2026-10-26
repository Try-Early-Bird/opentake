import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CircleAlert, Clock, RotateCw } from 'lucide-react';

// A one-line state of an investment that asks little or nothing of the
// member: orders waiting for the open, a retry coming, an order that failed.
// An icon, a short title, one sentence, and at most one action on the right,
// or below the sentence as the card's call to action (actionBelow).
// Theme colors: brand for what is scheduled, error for a failure.

export type NoticeTone = 'scheduled' | 'retry' | 'error';

const ICON = {
  scheduled: { Icon: Clock, className: 'text-brand' },
  retry: { Icon: RotateCw, className: 'text-muted-foreground' },
  error: { Icon: CircleAlert, className: 'text-error' },
} as const;

export function Notice({ tone, title, text, action, actionBelow = false }: {
  tone: NoticeTone;
  title: string;
  text?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  actionBelow?: boolean;
}): React.JSX.Element {
  const { Icon, className } = ICON[tone];
  return (
    <div
      data-investment-card
      role="status"
      className={cn(
        'mt-3 flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-card-foreground',
        tone === 'error' ? 'border-error/30' : 'border-border',
      )}
    >
      <Icon size={16} className={cn('shrink-0 self-start mt-0.5', className)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm row-title leading-5 text-pretty">{title}</p>
        {text && <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{text}</p>}
        {action !== undefined && actionBelow && (
          <Button size="sm" className="mt-3 w-full" onClick={action.onClick} disabled={action.disabled}>
            {action.label}
          </Button>
        )}
      </div>
      {action !== undefined && !actionBelow && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
