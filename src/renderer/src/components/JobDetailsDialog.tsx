import { useEffect, useState } from 'react';
import type { JobDetails } from '../../../shared/activity';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { errors, exactTime, labels } from './activity-format';

export function JobDetailsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [details, setDetails] = useState<JobDetails | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await window.activity.details(id);
        if (active) { setDetails(result); setError(''); }
      } catch { if (active) setError('Could not load job details. Retrying…'); }
      if (active) timer = setTimeout(() => void refresh(), 2000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [id]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-2xl">
      <DialogTitle>Job details</DialogTitle>
      <DialogDescription>Execution states, attempts, and errors for this job.</DialogDescription>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {details === undefined && !error && <p role="status">Loading job details…</p>}
      {details === null && <p>This job is no longer available. It may have been deleted by your history retention setting.</p>}
      {details && <>
        <p className="font-medium">{details.job.kind === 'account_sync' ? 'Sync Robinhood accounts' : details.job.kind.replaceAll('_', ' ')}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Status</dt><dd>{labels[details.job.state]}</dd>
          <dt className="text-muted-foreground">Attempts</dt><dd>{details.job.attempts}</dd>
          <dt className="text-muted-foreground">Created</dt><dd>{exactTime(details.job.createdAt)}</dd>
          <dt className="text-muted-foreground">Updated</dt><dd>{exactTime(details.job.updatedAt)}</dd>
          <dt className="text-muted-foreground">Job ID</dt><dd className="break-all font-mono">{details.job.id}</dd>
        </dl>
        <section aria-labelledby="job-execution-log">
          <h3 id="job-execution-log" className="font-medium">Execution log</h3>
          <p className="mt-1 text-xs text-muted-foreground">Shows status changes and error codes. Account credentials and full provider responses are excluded. Events from before logging was enabled are unavailable.</p>
          {details.truncated && <p className="mt-2 text-xs text-muted-foreground">Showing the latest 200 events.</p>}
          {details.events.length === 0 ? <p className="mt-3 text-muted-foreground">No execution events were recorded for this job.</p> : <ol className="mt-3 divide-y divide-border">
            {details.events.map(event => <li key={event.id} className="space-y-1 py-3 text-xs">
              <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{labels[event.state]} · Attempt {event.attempts}</span><time dateTime={new Date(event.occurredAt).toISOString()}>{exactTime(event.occurredAt)}</time></div>
              {event.errorCode && <p className="text-muted-foreground">{errors[event.errorCode] ?? 'Unknown error.'} <code>{event.errorCode}</code></p>}
              {event.state === 'retrying' && <p className="text-muted-foreground">Next attempt {exactTime(event.nextRunAt)}</p>}
            </li>)}
          </ol>}
        </section>
      </>}
    </DialogContent>
  </Dialog>;
}
