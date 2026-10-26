import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Link } from '@tanstack/react-router';
import { Check, CircleAlert, CircleCheck, Clock, LoaderCircle, X } from 'lucide-react';
import { whenShort } from '../when-label';
import type { TradingQueueAction, TradingQueueItem } from '../../../shared/trading-queue';

// Queue row markup; local bridge actions are supplied by ActivityQueue.
function sinceLabel(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
function StateIcon({ state }: { state: TradingQueueItem['state'] }): React.JSX.Element {
  const Icon = state === 'needs_you' ? CircleAlert : state === 'in_progress' ? LoaderCircle : Clock;
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full',
        state === 'in_progress' ? 'bg-muted text-muted-foreground' : 'bg-brand/10 text-brand',
      )}
      aria-hidden
    >
      <Icon size={14} className={state === 'in_progress' ? 'animate-spin' : undefined} />
    </span>
  );
}

export function TradingQueueRow({item,pending,disabled,onAct,onNavigate}:{item:TradingQueueItem;pending?:string;disabled:boolean;onAct:(item:TradingQueueItem,action:TradingQueueAction)=>void;onNavigate:()=>void}){
 return item.approval !== undefined && item.actions.includes('confirm') ? (
                // Orders held for the member's approval: what they do, for
                // which investment and since when; Review opens the strategy.
                <li key={item.id} className="flex items-center gap-3 rounded-lg px-2.5 py-2.5 hover:bg-muted/50">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-attention/15 text-attention" aria-hidden>
                    <CircleCheck size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] row-title leading-5">{item.approval.summary} · needs your OK</p>
                    <p className="truncate text-xs leading-4 text-muted-foreground">
                      {item.approval.strategyName} · {sinceLabel(item.createdAt)}
                    </p>
                  </div>
                  {item.link !== null && (
                    <Link
                      to="/strategies/$strategyId"
                      params={{ strategyId: item.link.id }}
                      onClick={onNavigate}
                      className="shrink-0 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      Review
                    </Link>
                  )}
                  <Button
                    size="sm"
                    className="shrink-0 bg-foreground px-3.5 font-semibold text-background hover:bg-foreground/90"
                    disabled={disabled}
                    onClick={() => onAct(item, 'confirm')}
                  >
                    {pending === `${item.id}/confirm` ? 'Approving…' : 'Approve'}
                  </Button>
                </li>
              ) : (
                <li key={item.id} className="flex h-12 items-center gap-2.5 rounded-md px-2 hover:bg-muted/50">
                  <StateIcon state={item.state} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-4">
                      {item.link !== null ? (
                        <Link
                          to="/strategies/$strategyId"
                          params={{ strategyId: item.link.id }}
                          onClick={onNavigate}
                          className="hover:underline"
                        >
                          {item.title}
                        </Link>
                      ) : item.title}
                    </p>
                    <p className="truncate text-xs leading-4 text-muted-foreground">
                      {[item.detail, item.expectedAt === null ? null : whenShort(item.expectedAt)]
                        .filter((part) => part !== null && part !== '')
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {item.actions.includes('confirm') && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Confirm: ${item.title}`}
                        title="Confirm"
                        disabled={disabled}
                        onClick={() => onAct(item, 'confirm')}
                      >
                        <Check size={14} />
                      </Button>
                    )}
                    {item.actions.includes('cancel') && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Cancel: ${item.title}`}
                        title="Cancel"
                        disabled={disabled}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => onAct(item, 'cancel')}
                      >
                        <X size={14} />
                      </Button>
                    )}
                  </div>
                </li>
              );
}
