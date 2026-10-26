import {ActionProgressCard} from './ActionProgressCard';
import { useToast } from './ui/action-toast';
import {NotificationAccount} from './NotificationAccount';
import {OrderNotificationRow} from './OrderNotificationRow';
import {OrderActivityDetails} from './OrderActivityDetails';
import type {OrderActivity} from '../../../shared/order-activity';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from './ui/dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { TradingNotificationRow } from './TradingNotificationRow';
import { TakeEventNotificationRow } from './TakeEventNotificationRow';
import { allocationActions } from '../strategies/allocation-actions';
import { noteQueueActed, useQueueVersion } from '../waiting-store';
import { Bell } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import {NotificationRow} from './NotificationRow';
import { useNavigate } from '@tanstack/react-router';
import type { NotificationPage, NotificationTarget, NotificationItem } from '../../../shared/notifications';

function closedRuleReview(item: NotificationItem) {
  if (item.source.type !== 'trading_queue' || item.eventKey !== 'rule-rebalance') return null;
  if (item.resolvedAt) return { title: 'Rule rebalance review closed', body: 'This review is no longer active, so there is nothing to approve here. Check the Take’s rule activity for the recorded outcome.' };
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) return { title: 'Rule rebalance review expired', body: 'The approval window ended. This review can no longer be confirmed. Check the Take’s rule activity before requesting another run.' };
  return null;
}

/**
 * Local notifications (trigger, badge, popup, rows and scroll paging), with the
 * trading CTAs. The host validates current queue state.
 */
export function NotificationCenter() {
  const navigate = useNavigate();
  const toast = useToast();
  const toastSequence = useRef<bigint | null>(null);
  const actionToasts=useRef(new Map<string,{signature:string;state:string;toastId?:string;dismissed:boolean}>());
  const announce = useCallback((next: NotificationPage) => {
    const previous = toastSequence.current;
    const through = BigInt(next.throughSequence);
    for (const item of next.items) {
      if (!item.action) continue;
      const signature = JSON.stringify(item.action);
      const old = actionToasts.current.get(item.id);
      if (old?.signature === signature) continue;
      const stateChanged = !!old && old.state !== item.action.state;
      const entry = old ?? {signature, state:item.action.state, dismissed: localStorage.getItem(`dismissed-action:${item.id}`) === '1'};
      entry.signature = signature;
      entry.state = item.action.state;
      actionToasts.current.set(item.id, entry);
      const timeout = ['completed','attention','cancelled'].includes(item.action.state) ? 10000 : 0;
      const options = {
        title: item.title, data: {action: item.action}, timeout,
        onClose: () => {entry.dismissed = true; localStorage.setItem(`dismissed-action:${item.id}`, '1');},
        actionProps: {children: 'View', onClick: () => {
          if ('strategyId' in item.context) void navigate({to:'/strategies/$strategyId', params:{strategyId:item.context.strategyId}});
        }},
      };
      if (entry.dismissed) continue;
      if (entry.toastId) toast.update(entry.toastId, options);
      else if (previous !== null && document.hasFocus() &&
        ((stateChanged && ['completed','attention'].includes(item.action.state)) || Date.now()-Date.parse(item.occurredAt)<60000)) {
        entry.toastId = toast.add(options);
      }
    }
    if (previous !== null && through <= previous) return;
    toastSequence.current = through;
    // Establish a baseline on launch; never replay historical notifications.
    if (previous === null || !document.hasFocus()) return;
    for (const item of [...next.items].reverse()) {
      if (BigInt(item.sequence) <= previous || item.resolvedAt ||
          !['order_update', 'capital_update'].includes(item.kind)) continue;
      if(item.order?.strategyId)continue; // The action projection owns Take order announcements.
      toast.add({ title: item.title, description: item.body, timeout: 8000 });
    }
  }, [toast,navigate]);
  const [order,setOrder]=useState<OrderActivity|null>(null);
  const queueVersion=useQueueVersion();
  const [pending,setPending]=useState<string>();
  const acting=useRef(false);
  const [actionError,setActionError]=useState('');
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<NotificationPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const cursor = useRef<string | null>(null);
  const showing = useRef(false); showing.current = open;
  const go = useCallback(async (target: NotificationTarget) => {
    if (target.type === 'attention') { setOpen(true); return; }
    setOpen(false);
    if(target.type==='order'){setOrder(target.order);return;}
    if(target.type==='strategy'){await navigate({to:'/strategies/$strategyId',params:{strategyId:target.strategyId}});return;}
    if (target.type === 'take') await navigate({ to: '/', search: { takeId: target.takeId } });
    else await navigate({ to: '/settings', search: { section: 'connections' } });
  }, [navigate]);
  async function openNotification(item: NotificationItem) {
    try {
      const latest = (await window.notifications.list()).items.find(row => row.id === item.id) ?? item;
      const closed = closedRuleReview(latest);
      await go(await window.notifications.target(item.id));
      if (closed) toast.add({ title: closed.title, description: closed.body, timeout: 10000 });
    } catch { setError('This item is unavailable.'); }
  }
  useEffect(()=>{if(queueVersion)cursor.current=null;},[queueVersion]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const handoff = await window.notifications.navigation();
        if (!active) return;
        if (handoff) { await go(handoff.target); if (active) await window.notifications.acknowledge(handoff.id); }
        // Preserve an explicitly paged list while it is open.
        const next = await window.notifications.list();
        if (active) {
          announce(next);
          if (!showing.current || cursor.current === null) setPage(next);
          else setPage(old=>old?{...old,unreadCount:next.unreadCount,actionRequiredCount:next.actionRequiredCount,throughSequence:next.throughSequence,items:old.items.map(item=>next.items.find(n=>n.id===item.id)??item)}:next);
          setError('');
        }
      } catch { if (active) setError('Notifications are unavailable. Retrying…'); }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [go,queueVersion,announce]);
  useEffect(() => {
    if (!open) { cursor.current = null; return; }
    let active = true;
    void window.notifications.list().then(async next => {
      if (!active) return;
      setPage(next); setError('');
      // Stamp seen first so the refreshed page reports zero unread.
      await window.notifications.markSeen(next.throughSequence);
      const seen = await window.notifications.list();
      if (active) setPage(seen);
    }).catch(() => { if (active) setError('Could not load notifications.'); });
    return () => { active = false; };
  }, [open]);
  async function more() {
    if (!page?.nextCursor || loading) return;
    setLoading(true);
    try {
      const next = await window.notifications.list(page.nextCursor);
      cursor.current = page.nextCursor;
      setPage(old => old ? { ...next, items: [...old.items, ...next.items.filter(item => !old.items.some(previous => previous.id === item.id))] } : next);
    } catch { setError('Could not load more notifications.'); }
    finally { setLoading(false); }
  }
  async function act(item:NotificationItem,action:'confirm'|'cancel'){
    if(acting.current)return;acting.current=true;setPending(item.id);setActionError('');
    try{await window.notifications.act(item.id,action);cursor.current=null;setPage(await window.notifications.list());noteQueueActed();}
    catch(e){setActionError(e instanceof Error?e.message:'Could not update the trading item.');}
    finally{acting.current=false;setPending(undefined);}
  }
  // Hold all on an archive row: the take's positions become your own shares now.
  async function holdAll(item:NotificationItem,allocationId:string){
    if(acting.current||allocationActions===null)return;acting.current=true;setPending(item.id);setActionError('');
    try{const result=await allocationActions.strategyBuckets.close(allocationId,'none');if(!result.ok)throw new Error(result.message);cursor.current=null;setPage(await window.notifications.list());noteQueueActed();}
    catch(e){setActionError(e instanceof Error?e.message:'Could not update this take.');}
    finally{acting.current=false;setPending(undefined);}
  }
  // The badge is the unread count; opening the menu marks everything up to the newest seen.
  const unread = page?.unreadCount ?? 0;
  // Scroll paging: the next page loads as the end of the list comes into view.
  const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!open || sentinel === null || !page?.nextCursor) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void more(); }, { rootMargin: '80px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, sentinel, page?.nextCursor]); // eslint-disable-line react-hooks/exhaustive-deps
  const failure = actionError || error;
  return (
    <><Dialog open={!!order} onOpenChange={open=>{if(!open)setOrder(null);}}><DialogContent><DialogHeader><DialogTitle>Order details</DialogTitle><DialogDescription>Latest locally observed status for this account’s order.</DialogDescription></DialogHeader>{order&&<OrderActivityDetails order={order}/>}
      {order?.strategyId&&<Button variant="outline" onClick={()=>{const id=order.strategyId!;setOrder(null);void navigate({to:'/strategies/$strategyId',params:{strategyId:id}});}}>Open Take</Button>}</DialogContent></Dialog>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={<Button variant="ghost" size="icon-sm" aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'} title="Notifications" />}
        className="relative"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-semibold leading-none text-background">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6}>
          <Popover.Popup
            className={cn(
              'z-50 w-[23rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none',
              'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-3.5 py-3"><h2 className="text-xs font-medium">Notifications</h2><button type="button" disabled={!page||loading} className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={()=>{if(!page)return;void window.notifications.markSeen(page.throughSequence).then(()=>window.notifications.list()).then(setPage).catch(()=>setError('Could not mark notifications read.'));}}>Mark all read</button></div>
            {failure && <p role="alert" className="px-2 pb-1 text-xs text-error">{failure}</p>}
            {!page?.items.length ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No notifications yet.</p>
            ) : (
              <ul className="max-h-[min(32rem,65vh)] divide-y divide-border overflow-y-auto">
                {page.items.map(item => item.action
                  ? <li key={item.id} className="px-3.5 py-3"><ActionProgressCard action={item.action} onView={()=>{if(item.action?.accounts.some(account=>account.state==='awaiting_confirmation')&&'strategyId' in item.context){setOpen(false);void navigate({to:'/strategies/$strategyId',params:{strategyId:item.context.strategyId},hash:'order-review'});}else void window.notifications.target(item.id).then(go);}}/></li>
                  : item.trading
                  ? <TradingNotificationRow key={item.id} item={item} busy={!!pending} onAct={action => void act(item, action)} onNavigate={() => setOpen(false)} />
                  : item.takeEvent
                    ? <TakeEventNotificationRow key={item.id} item={item} busy={!!pending} onHoldAll={allocationId => void holdAll(item, allocationId)} onNavigate={() => setOpen(false)} />
                    : item.order
                      ? <OrderNotificationRow key={item.id} item={item} onOpen={() => void window.notifications.target(item.id).then(go).catch(() => setError('This item is unavailable.'))}/>
                    : (
                      <NotificationRow key={item.id} occurredAt={item.occurredAt} tone={item.kind==='capital_update'?'success':item.requiresAction&&!item.resolvedAt?'attention':'neutral'} attention={item.requiresAction&&!item.resolvedAt}>
                        <button type="button" className="block w-full text-left" onClick={() => void openNotification(item)}>
                          <span className="block font-medium">{closedRuleReview(item)?.title ?? item.title}</span>
                          {item.body&&item.kind!=='capital_update'&&<span className="mt-1 block text-muted-foreground">{closedRuleReview(item)?.body ?? item.body}</span>}{item.account?<NotificationAccount {...item.account}/>:item.kind==='capital_update'&&<span className="mt-1 block text-muted-foreground">{item.body}</span>}
                        </button>
                      </NotificationRow>
                    ))}
                {page.nextCursor && (
                  <li ref={setSentinel} className="px-2 py-2 text-center text-xs text-muted-foreground" aria-hidden={!loading}>
                    {loading ? 'Loading…' : ''}
                  </li>
                )}
              </ul>
            )}
            <button type="button" className="w-full border-t border-border px-3.5 py-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={()=>{setOpen(false);void navigate({to:'/activity'});}}>See all activity</button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root></>
  );
}
