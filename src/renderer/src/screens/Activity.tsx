import {useEffect,useRef} from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { ActivityRows, ActivityRowsSkeleton } from '../components/ActivityRows';
import { useActivity } from '../hooks/useActivity';

// Recent stored fills on the selected local account.

export function Activity(): React.JSX.Element {
  const { items, status, currency,hasMore,loadingMore,error,loadMore } = useActivity();
  const sentinel=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!hasMore||loadingMore||error||!sentinel.current)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))void loadMore();},{rootMargin:'240px'});
    observer.observe(sentinel.current);return()=>observer.disconnect();
  },[hasMore,loadingMore,error,loadMore]);
  return (
    <section>
      <Link to="/portfolio" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Portfolio
      </Link>
      <h1 className="mt-4 mb-6 font-display text-[26px] tracking-[-0.02em]">Activity</h1>
      {items === null ? (
        <ActivityRowsSkeleton rows={6} />
      ) : status !== 200 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {status === 401 ? 'Sign in to see your activity.' : 'Activity could not be loaded. Please try again.'}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No recorded activity yet.
        </div>
      ) : (
        <ActivityRows items={items} currency={currency} />
      )}
      {hasMore&&<div ref={sentinel} className="py-6 text-center text-xs text-muted-foreground">
        {error&&<p role="alert" className="mb-2">{error}</p>}
        {loadingMore?<span role="status">Loading more activity…</span>:<button type="button" onClick={()=>void loadMore()} className="rounded px-3 py-2 hover:bg-muted">{error?'Retry':'Load more'}</button>}
      </div>}
    </section>
  );
}
