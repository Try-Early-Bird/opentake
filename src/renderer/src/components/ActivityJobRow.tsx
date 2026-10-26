import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { setWaitingOpen } from '../waiting-store';
import { JobDetailsDialog } from './JobDetailsDialog';
import { labels, errors, exactTime, relativeTime } from './activity-format';
import { RotateCw } from 'lucide-react';
import type { ActivityJob } from '../../../shared/activity';
import type { LinkedAccount } from '../../../shared/connections';

const statusColors: Record<ActivityJob['state'], string> = {
  pending: 'bg-muted-foreground', running: 'bg-sky-400', retrying: 'bg-amber-400',
  completed: 'bg-emerald-400', failed: 'bg-red-400', needs_attention: 'bg-amber-400', cancelled: 'bg-muted-foreground',
};

export function ActivityJobRow({ job, account, pending = false, onRetry }: {
  job: ActivityJob; account?: LinkedAccount; pending?: boolean; onRetry?: (id: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const execution = job.execution;
  const title = execution ? `${job.kind === 'rebalance' ? 'Rebalance · ' : ''}${execution.side === 'buy' ? 'Buy' : 'Sell'} ${execution.symbol}` : job.kind === 'account_sync' ? 'Sync Robinhood accounts' : job.kind === 'portfolio_sync' ? 'Sync portfolio and orders' : job.kind.replaceAll('_', ' ');
  const initial = execution ? (job.kind === 'rebalance' ? 'R' : execution.side === 'buy' ? 'B' : 'S') : job.kind === 'account_sync' ? 'R' : job.kind === 'portfolio_sync' ? 'P' : job.kind.charAt(0).toUpperCase();
  const status = execution ? (execution.status === 'filled' ? 'Filled' : labels[job.state]) : job.state === 'failed' && job.attempts > 0
    ? `Failed after ${job.attempts} ${job.attempts === 1 ? 'try' : 'tries'}`
    : `${labels[job.state]}${job.attempts > 1 ? ` · Attempt ${job.attempts}` : ''}`;
  const error = job.errorCode ? errors[job.errorCode] ?? 'Check your connection and retry.' : undefined;
  const canRetry = !execution && onRetry && (job.state === 'failed' || (job.state === 'needs_attention' && job.errorCode !== 'reauth_required'));
  return <li className="flex items-center gap-3 py-2">
    <div aria-hidden="true" className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
      {initial}
      <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-popover ${statusColors[job.state]}`} />
    </div>
    <div className="min-w-0 flex-1">
      {execution ? <Link to="/strategies/$strategyId" params={{strategyId: execution.strategyId}} onClick={() => setWaitingOpen(false)} className="block max-w-full truncate rounded-sm text-xs row-title leading-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{title}</Link> : <button type="button" onClick={() => setDetailsOpen(true)} title={error} className="block max-w-full truncate rounded-sm text-left text-xs row-title leading-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{title}</button>}
      <p className="truncate text-[11px] leading-4 text-muted-foreground" title={[account?.nickname, error, exactTime(job.updatedAt)].filter(Boolean).join(' · ')}>
        {execution && <>{execution.strategyTitle}{' · '}</>}
        {job.kind === 'account_sync' && account && <><span aria-label="Masked account number">{account.maskedNumber}</span>{' · '}</>}
        <span>{status}</span>{' · '}<time dateTime={new Date(job.updatedAt).toISOString()}>{relativeTime(job.updatedAt)}</time>
      </p>
      {job.state === 'needs_attention' && error && <p className="text-[11px] leading-4 text-muted-foreground">{error}</p>}
      {job.state === 'retrying' && <p className="text-[11px] leading-4 text-muted-foreground">Next attempt {new Date(job.nextRunAt).toLocaleTimeString()}</p>}
    </div>
    {canRetry && <button type="button" aria-label={pending ? `Queuing ${title}` : `Retry ${title}`} title={pending ? 'Queuing…' : 'Retry'} disabled={pending} onClick={() => onRetry?.(job.id)} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
      <RotateCw aria-hidden="true" size={13} className={pending ? 'motion-safe:animate-spin' : undefined} />
    </button>}
    {detailsOpen && <JobDetailsDialog id={job.id} onClose={() => setDetailsOpen(false)} />}
  </li>;
}
