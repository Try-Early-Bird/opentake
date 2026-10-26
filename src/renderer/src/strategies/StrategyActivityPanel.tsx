import { money } from '../portfolio/format';
import { useEffect, useRef, useState } from 'react';

import { formatActivityDay } from '../components/ActivityRows';
import { rebalanceTriggerLabel } from './holdings';
import { allocationActions } from './allocation-actions';

// The strategy page's activity feed: what the strategy did (published,
// allocation changed, rebalanced, archived) and what its investors did
// (invested, deposited, closed), newest first. Members are named when their
// profile is public or they are the viewer; otherwise "A member".

export interface StrategyActivityEvent {
  id: string;
  kind: 'published' | 'allocation' | 'archived' | 'rebalance' | 'invested' | 'deposit' | 'closed' | 'covered' | 'withdrawn' | 'returned';
  occurredAt: string;
  member: { handle: string | null; name: string; isViewer: boolean } | null;
  amount: string | null;
  currency?: string;
  detail: string | null;
  members: number | null;
  legs: number | null;
}

function Who({ member }: { member: NonNullable<StrategyActivityEvent['member']> }): React.JSX.Element {
  if (member.isViewer) return <span className="font-medium">You</span>;
  if (member.handle === null) return <span className="font-medium">A member</span>;
  // Self-hosted has no member profiles to link to; the handle is plain text.
  return <span className="font-medium">@{member.handle}</span>;
}

function EventLine({ event, currency }: { event: StrategyActivityEvent; currency: string }): React.JSX.Element {
  currency = event.currency ?? currency;
  const amount = event.amount === null ? '' : currency === 'USDC' ? `${Number(event.amount).toLocaleString('en-US', {maximumFractionDigits: 2})} USDC` : money(event.amount, currency);
  switch (event.kind) {
    case 'withdrawn': return <><Who member={event.member!} /> withdrew{event.amount ? ` ${amount}` : ''}</>;
    case 'returned': return <>{event.amount ? amount : 'Cash'} returned to your account</>;
    case 'published': return <>Published</>;
    case 'archived': return <>Archived by the author</>;
    case 'allocation': return <>Allocation updated{event.detail ? ` to ${event.detail}` : ''}</>;
    case 'rebalance': {
      const who = event.members === null ? '' : ` · ${event.members} ${event.members === 1 ? 'investor' : 'investors'}`;
      const legs = event.legs === null ? '' : ` · ${event.legs} ${event.legs === 1 ? 'order' : 'orders'}`;
      return <>Rebalanced{event.detail ? ` · ${rebalanceTriggerLabel(event.detail)}` : ''}{who}{legs}</>;
    }
    case 'invested': return <><Who member={event.member!} /> invested{event.amount ? ` ${amount}` : ''}</>;
    case 'deposit': return <><Who member={event.member!} /> deposited{event.amount ? ` ${amount}` : ''}</>;
    // The take overspent its cash and you recorded the difference as money you put in.
    case 'covered': return <><Who member={event.member!} /> covered{event.amount ? ` ${amount}` : ''} the take spent from your cash</>;
    case 'closed': return <><Who member={event.member!} /> closed{event.detail ? ` · ${event.detail}` : ''}</>;
  }
}

const PAGE_SIZE = 30;
const REFRESH_MS = 60_000;

export function StrategyActivityPanel({ strategyId, reloadKey = 0, currency = 'USD' }: { strategyId: string; reloadKey?: number; currency?: string }): React.JSX.Element {
  const [events, setEvents] = useState<StrategyActivityEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  // First page on open and after the member acts; the list starts over.
  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setNextCursor(null);
    // No activity source until the execution layer exists: the empty state.
    const source = allocationActions;
    if (source === null) {
      setEvents([]);
      return;
    }
    void source.getStrategyActivity(strategyId, PAGE_SIZE).then((result) => {
      if (cancelled) return;
      setEvents(result.status === 200 ? (result.events as StrategyActivityEvent[]) : []);
      setNextCursor(result.status === 200 ? result.nextCursor : null);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId, reloadKey]);

  // Newer events from other investors: refetch the first page when the window
  // comes back and once a minute while it is visible, and slot in what is new.
  useEffect(() => {
    let cancelled = false;
    const source = allocationActions;
    if (source === null) return;
    const refresh = (): void => {
      if (document.visibilityState !== 'visible') return;
      void source.getStrategyActivity(strategyId, PAGE_SIZE).then((result) => {
        if (cancelled || result.status !== 200) return;
        const fresh = result.events as StrategyActivityEvent[];
        setEvents((current) => {
          if (current === null) return current;
          const known = new Set(current.map((event) => event.id));
          const added = fresh.filter((event) => !known.has(event.id));
          return added.length === 0 ? current : [...added, ...current].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
        });
      });
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [strategyId]);

  // Older events as the member scrolls to the end of the list.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    const source = allocationActions;
    if (sentinel === null || root === null || nextCursor === null || loadingMore || source === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setLoadingMore(true);
      void source.getStrategyActivity(strategyId, PAGE_SIZE, nextCursor).then((result) => {
        setLoadingMore(false);
        if (result.status !== 200) {
          setNextCursor(null);
          return;
        }
        const more = result.events as StrategyActivityEvent[];
        setEvents((current) => {
          const known = new Set((current ?? []).map((event) => event.id));
          return [...(current ?? []), ...more.filter((event) => !known.has(event.id))];
        });
        setNextCursor(result.nextCursor);
      });
    }, { root, rootMargin: '80px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [strategyId, nextCursor, loadingMore, events]);

  return (
    <section aria-label="Take activity" className="mt-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Activity</p>
      {events === null ? (
        <div className="mt-2 h-24 animate-pulse rounded-lg bg-muted" />
      ) : events.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul ref={listRef} className="mt-2 max-h-80 divide-y divide-border overflow-y-auto">
          {events.map((event) => (
            <li key={event.id} className="py-2">
              <p className="text-[13px] font-normal text-pretty"><EventLine event={event} currency={currency} /></p>
              <time dateTime={event.occurredAt} className="mt-0.5 block text-[11px] text-muted-foreground">{formatActivityDay(event.occurredAt)}</time>
            </li>
          ))}
          {nextCursor !== null && (
            <li ref={sentinelRef} className="py-2 text-center text-[11px] text-muted-foreground" aria-live="polite">
              {loadingMore ? 'Loading more…' : ''}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
