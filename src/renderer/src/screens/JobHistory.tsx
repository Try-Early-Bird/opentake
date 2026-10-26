import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ActivityJob, JobHistoryCursor } from '../../../shared/activity';
import type { LinkedAccount } from '../../../shared/connections';
import { ActivityJobRow } from '../components/ActivityJobRow';

export function JobHistory() {
  const [jobs, setJobs] = useState<ActivityJob[]>([]);
  const [account, setAccount] = useState<LinkedAccount>();
  const [cursor, setCursor] = useState<JobHistoryCursor>();
  const [nextCursor, setNextCursor] = useState<JobHistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void window.connections.status().then(result => {
      if (active && result.ok) setAccount(result.connection.accounts.find(item => item.selected) ?? result.connection.accounts[0]);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void window.activity.history(cursor).then(page => {
      if (!active) return;
      setJobs(previous => {
        const seen = new Set(previous.map(job => job.id));
        return [...previous, ...page.jobs.filter(job => !seen.has(job.id))];
      });
      setNextCursor(page.nextCursor);
      setError('');
    }).catch(() => {
      if (active) setError('Could not load job history. Try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cursor, attempt]);

  useEffect(() => {
    const element = sentinel.current;
    if (!element || loading || error || !nextCursor) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setLoading(true);
        setCursor(nextCursor);
        observer.disconnect();
      }
    }, { rootMargin: '240px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, error, nextCursor]);

  return <section aria-labelledby="job-history-heading" className="mx-auto max-w-3xl px-6 pt-6 pb-20">
    <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Home</Link>
    <div className="mt-4 flex items-center justify-between gap-4"><h1 id="job-history-heading" className="text-2xl font-medium">Job History</h1><Link to="/settings" search={{ section: 'data-retention' }} className="text-sm text-muted-foreground hover:text-foreground">Data retention</Link></div>
    <p className="mt-2 text-sm text-muted-foreground">Sync jobs and filled, failed, or cancelled trading orders, newest first.</p>
    <ul className="mt-6 divide-y divide-border">{jobs.map(job => <ActivityJobRow key={job.id} job={job} account={account} />)}</ul>
    <div ref={sentinel} className="py-4 text-center text-sm text-muted-foreground" aria-live="polite">
      {loading && <p role="status">Loading history…</p>}
      {error && <div><p role="alert">{error}</p><button className="mt-2 rounded px-3 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setError(''); setLoading(true); setAttempt(value => value + 1); }}>Retry</button></div>}
      {!loading && !error && !nextCursor && <p>{jobs.length ? 'You’ve reached the end of your job history.' : 'No job history yet.'}</p>}
    </div>
  </section>;
}
