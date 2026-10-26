import { useEffect, useRef, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { Tabs } from '@base-ui/react/tabs';
import type { ActivityJob } from '../../../shared/activity';
import type { ConnectionSummary } from '../../../shared/connections';
import { ActivityJobRow } from './ActivityJobRow';
import { TradingQueueRow } from './TradingQueueRow';
import { readTradingQueue, type TradingQueueItem, type TradingQueueAction } from '../../../shared/trading-queue';
import { noteQueueActed, setWaitingOpen, useQueueVersion, useWaitingOpen } from '../waiting-store';
import { Link } from '@tanstack/react-router';

export function ActivityQueue() {
  const open=useWaitingOpen();const setOpen=setWaitingOpen;
  const queueVersion=useQueueVersion();
  const [trades,setTrades]=useState<TradingQueueItem[]>([]);
  const [tradeError,setTradeError]=useState('');
  const [actionError,setActionError]=useState('');
  const [loaded,setLoaded]=useState(false);
  const acting=useRef(false),readVersion=useRef(0);
  const [tab, setTab] = useState<string | number | null>('jobs');
  const [jobs, setJobs] = useState<ActivityJob[]>([]);
  const [history, setHistory] = useState<ActivityJob[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [connection, setConnection] = useState<ConnectionSummary>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if(!acting.current){
        const version=++readVersion.current;
        const [next,status,trading,past]=await Promise.allSettled([
          window.activity.list(),window.connections.status(),
          Promise.resolve().then(()=>window.allocations.queueList()).then(result=>{if(!result.ok)throw new Error(result.message);return readTradingQueue(result.items);}),
          Promise.resolve().then(()=>window.activity.history()),
        ]);
        if(active&&version===readVersion.current){
          if(next.status==='fulfilled'){setJobs(next.value);setError('');}else setError('Sync jobs are unavailable.');
          if(status.status==='fulfilled'&&status.value.ok)setConnection(status.value.connection);
          if(trading.status==='fulfilled'){setTrades(trading.value);setTradeError('');}else setTradeError('Trading queue is unavailable. Existing items may be out of date.');
          if(past.status==='fulfilled'){setHistory(past.value.jobs);setHistoryError('');}else setHistoryError('Job history is unavailable.');
          setLoaded(true);
        }
      }
      if(active)timer=setTimeout(()=>{void refresh();},open?2000:10_000);
    };
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[open,queueVersion]);

  const attention = jobs.filter(job => job.state === 'failed' || job.state === 'needs_attention');
  const activity = jobs.filter(job => job.state === 'pending' || job.state === 'running' || job.state === 'retrying');
  const tradeAttention=trades.filter(item=>item.state==='needs_you');
  const tradeActivity=trades.filter(item=>item.state!=='needs_you');
  const attentionCount=attention.length+tradeAttention.length;
  const activeCount=attention.length+activity.length+trades.length;
  const accounts = connection?.accounts ?? [];
  const account = accounts.find(account => account.selected) ?? accounts[0];
  async function retry(id: string) {
    if(acting.current)return;acting.current=true;++readVersion.current;setPending(id);setActionError('');
    try{await window.activity.retry(id);setJobs(await window.activity.list());noteQueueActed();}
    catch{setActionError('Could not retry. Check the connection first.');}
    finally{acting.current=false;setPending(undefined);}
  }
  async function act(item:TradingQueueItem,action:TradingQueueAction){
    if(acting.current||tradeError||!item.actions.includes(action))return;
    acting.current=true;++readVersion.current;setPending(`${item.id}/${action}`);setActionError('');
    try{
      const result=await window.allocations.queueAct(item.id,action);
      if(!result.ok){setActionError(result.message);return;}
      setTrades(readTradingQueue(result.items));noteQueueActed();
    }catch{setActionError('Could not update the trading queue. Refresh and review its status before trying again.');}
    finally{acting.current=false;setPending(undefined);}
  }
  function tradingList(items:TradingQueueItem[]){return <ul className="divide-y divide-border">{items.map(item=><TradingQueueRow key={item.id} item={item} pending={pending} disabled={!!pending||!!tradeError} onAct={(item,action)=>void act(item,action)} onNavigate={()=>setOpen(false)}/>)}</ul>;}

  function list(items: ActivityJob[], retryable = true) {
    return <ul>{items.map(job => <ActivityJobRow key={job.id} job={job} account={account} pending={pending === job.id} onRetry={retryable ? id => void retry(id) : undefined} />)}</ul>;
  }

  return <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
    <Popover.Trigger aria-label="Jobs" title="Jobs" className="relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
      <ListTodo size={16} />{attentionCount>0&&<span aria-label={`${attentionCount} need attention`} className="absolute right-0 top-0 size-2 rounded-full bg-destructive" />}
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50">
      <Popover.Popup data-slot="popover-content" className="w-96 max-w-[calc(100vw-1.5rem)] max-h-[min(32rem,var(--available-height))] overflow-y-auto rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none">
        <Popover.Title className="sr-only">Jobs</Popover.Title>
        <Tabs.Root value={tab} onValueChange={setTab}>
          <div className="flex items-start justify-between gap-3 border-b border-border">
            <Tabs.List aria-label="Job activity" className="flex gap-4">
              <Tabs.Tab value="jobs" className="border-b-2 border-transparent pb-2 text-muted-foreground data-active:border-foreground data-active:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Jobs</Tabs.Tab>
              <Tabs.Tab value="history" className="border-b-2 border-transparent pb-2 text-muted-foreground data-active:border-foreground data-active:text-foreground focus-visible:outline-2 focus-visible:outline-ring">History</Tabs.Tab>
            </Tabs.List>
            {tab === 'history' && <Link to="/job-history" onClick={() => setOpen(false)} className="pb-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">View all ↗</Link>}
          </div>
          {[error,tradeError,actionError].filter(Boolean).map(message=><p key={message} role="alert" className="mt-3 text-xs text-destructive">{message}</p>)}
          <Tabs.Panel value="jobs">
            {!loaded&&<p role="status" className="pt-3 text-xs text-muted-foreground">Loading jobs…</p>}
            {attentionCount>0&&<section className="mt-4"><h3 className="font-medium">Needs attention</h3>{tradingList(tradeAttention)}{list(attention)}</section>}
            {tradeActivity.length>0&&<section className="mt-4"><h3 className="font-medium">Trading</h3>{tradingList(tradeActivity)}</section>}
            {activity.length>0&&<section className="mt-4"><h3 className="font-medium">Account sync</h3>{list(activity)}</section>}
            {loaded&&activeCount===0&&!error&&!tradeError&&<p className="pt-3 text-xs text-muted-foreground">No active jobs.</p>}

          </Tabs.Panel>
          <Tabs.Panel value="history">
            {historyError && <p role="alert" className="pt-3 text-xs text-destructive">{historyError}</p>}
            {history.length > 0 ? list(history, false) : !historyError && <p className="pt-3 text-xs text-muted-foreground">No history yet.</p>}
          </Tabs.Panel>
        </Tabs.Root>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
