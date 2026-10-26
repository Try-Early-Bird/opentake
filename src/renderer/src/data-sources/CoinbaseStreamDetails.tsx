import {coinbaseMessageSummary,messageTime,messageBytes} from './coinbase-message-summary';
import { useEffect, useRef, useState } from 'react';
import type { CoinbaseStreamInspection } from '../../../shared/coinbase-stream';
import type { WebsocketMessage } from '../../../shared/websocket-sources';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog';

/** Observe shared demand without creating a demonstration subscription. */
export function CoinbaseStreamDetails() {
  const [subscriptions,setSubscriptions]=useState<CoinbaseStreamInspection['subscriptions']>([]);
  const [issue,setIssue]=useState<string|null>(null),[retrying,setRetrying]=useState(false);
  async function reconnect(){setRetrying(true);try{await window.dataSources.coinbaseStream.reconnect();setStatus('Connecting');setIssue(null);}catch{setIssue('Could not restart the public connection.');}finally{setRetrying(false);}}
  const [status, setStatus] = useState('Connecting');
  const [rows, setRows] = useState<WebsocketMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [paused, setPaused] = useState(false);
  const [raw, setRaw] = useState(false),[filter,setFilter]=useState('all');
  const [startedAt,setStartedAt]=useState<number|null>(null);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<WebsocketMessage | null>(null);
  const pending = useRef<WebsocketMessage[]>([]);
  const pausedRef = useRef(false), followRef = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  pausedRef.current = paused; followRef.current = follow;
  useEffect(() => {
    let disposed = false, running = false, cursor = 0;
    const api = window.dataSources.coinbaseStream;
    pending.current = []; setRows([]); setTotal(0);
    async function tick() {
      if (disposed || running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const inspection=await api.inspect(cursor);
        if(disposed)return;
        const {messages,connection:state}=inspection;
        setSubscriptions(inspection.subscriptions);
        const reasons:Record<string,string>={transport:'The public connection was interrupted.',timeout:'The connection timed out waiting for data.',gap:'The stream restarted after a subscription or sequence change.',clock_changed:'The system clock changed.',invalid_data:'The provider response could not be validated.',capacity:'The stream reached its data limit.'};
        setIssue(inspection.issue ? reasons[inspection.issue]??'The stream is temporarily unavailable.' : null);
        setStatus(state==='paused'?'Paused':state==='live'?'Connected':state==='idle'?'Idle':state==='blocked'?'Needs attention':state==='retrying'?'Reconnecting':'Connecting');
        if (messages.cursor < cursor) pending.current = [];
        cursor = messages.cursor; setTotal(messages.total);setStartedAt(messages.startedAt);
        let bytes = 0;
        pending.current = [...pending.current, ...messages.messages].slice(-200).reverse().filter(row => {
          bytes += new TextEncoder().encode(JSON.stringify(row)).length;
          return bytes <= 512 * 1024;
        }).reverse();
        if (!pausedRef.current) {
          setRows([...pending.current].reverse());
          if (followRef.current && list.current) list.current.scrollTop = 0;
        }
      } catch { if (!disposed) setStatus('Connection unavailable · retrying'); }
      finally { running = false; }
    }
    function visibility() {
      if (document.visibilityState === 'hidden') { setStatus('View paused while hidden'); }
      else void tick();
    }
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const visible=rows.map(row=>({row,summary:coinbaseMessageSummary(row)})).filter(({summary})=>filter==='all'||summary.kind===(filter==='trades'?'trade':'heartbeat'));
  const rate=startedAt?total/Math.max(1,(Date.now()-startedAt)/1000):0;
  const tabClass=(active:boolean)=>active?'border-b-2 border-foreground pb-1 font-medium text-foreground':'border-b-2 border-transparent pb-1';
  return <section aria-label="Coinbase public WebSocket" className="mb-8 pt-6">
    <div className="flex items-center justify-between gap-3 border-b border-border pb-2 text-[11px] text-muted-foreground">
      <h3 className="uppercase tracking-wider">Subscriptions · {subscriptions.length} markets</h3><span>Why · Channel · Last tick</span>
    </div>
    {(status==='Reconnecting'||status==='Needs attention'||issue)&&<div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-xs text-muted-foreground"><span>{issue??'Waiting to reconnect.'} Automatic retries may wait up to five minutes.</span><button type="button" disabled={retrying} onClick={()=>void reconnect()} className="shrink-0 underline underline-offset-4 disabled:opacity-50">{retrying?'Restarting…':'Reconnect now'}</button></div>}
    <div aria-label="Coinbase subscriptions" className="divide-y divide-border border-b border-border">
      {subscriptions.map(item=>{
        const why=[...(item.uses.includes('holdings')?[item.accounts?.length?'Held in '+item.accounts.join(', '):'Held in Coinbase accounts']:[]),...(item.uses.includes('view')?['Asset page open']:[]),...(item.uses.includes('manual')?['Selected in source settings']:[]),...(item.uses.includes('rule')?['Take rule']:[])].join(' · ');
        const age=item.lastTick?Math.max(0,Math.floor((Date.now()-Date.parse(item.lastTick))/1000)):null;
        return <div key={item.product} className="grid grid-cols-[8px_108px_minmax(0,1fr)_minmax(100px,160px)_64px] items-center gap-3 py-3 text-xs">
          <span aria-label={item.confirmed?'Subscribed':'Requested'} className={`size-1.5 rounded-full ${item.confirmed?'bg-success':'bg-amber-500'}`}/>
          <span className="font-medium">{item.product}</span><span className="text-muted-foreground">{why}</span>
          <span className={`text-right font-mono text-[11px] ${item.confirmed?'text-muted-foreground':'text-amber-700'}`}>{item.confirmed?item.channels.join(' · '):'requested…'}</span>
          <span title="Time since the latest live trade" className="text-right font-mono text-[11px] text-muted-foreground">{item.confirmed&&age!==null&&Number.isFinite(age)?age+' s ago':'—'}</span>
        </div>;
      })}
      {!subscriptions.length&&<p className="py-4 text-xs text-muted-foreground">{status==='Paused'?'Collection is off. Open Edit to enable the stream.':'No markets requested. Open Edit to choose holdings, asset pages or additional markets.'}</p>}
    </div>
    <p className="mt-3 text-[11px] text-muted-foreground">Subscriptions follow your source settings. Latest prices update the shared cache; raw messages stay in memory.</p>
    <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
      <div className="flex gap-3"><h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Messages</h3><span className="font-mono text-[11px] text-muted-foreground">{rate.toFixed(1)} /s · {total.toLocaleString()} since connect</span></div>
      <div className="flex gap-4 text-xs text-muted-foreground">
        <div className="flex gap-3 border-r border-border pr-3">{['all','trades','heartbeats'].map(value=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)} className={tabClass(filter===value)}>{value[0].toUpperCase()+value.slice(1)}</button>)}</div>
        {[false,true].map(value=><button key={String(value)} aria-pressed={raw===value} onClick={()=>setRaw(value)} className={tabClass(raw===value)}>{value?'Raw':'Summary'}</button>)}
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/>Follow</label>
        <button onClick={() => { setPaused(!paused); if (paused) setRows([...pending.current].reverse()); }}>{paused ? 'Resume' : 'Pause'}</button>
        <button onClick={() => { pending.current = []; setRows([]); }}>Clear</button>
      </div>
    </div>
    <div ref={list} aria-label="Incoming Coinbase messages" className="max-h-[360px] overflow-auto">
      {visible.map(({row,summary})=><button key={row.id} onClick={()=>setSelected(row)} title={summary.kind==='trade'?'Trade side is the Coinbase maker side. Click for the raw frame.':'Click for the raw frame'} className="grid w-full grid-cols-[88px_38px_70px_minmax(0,1fr)_52px] items-start gap-3 border-b border-border py-2.5 text-left font-mono text-[11px] leading-4">
        <time className="text-muted-foreground">{messageTime(row.receivedAt)}</time><span className="text-muted-foreground">#{row.id}</span>
        <span className={summary.kind==='open'?'text-success':summary.kind==='close'?'text-destructive':summary.kind==='heartbeat'?'text-muted-foreground':''}>{summary.kind}</span>
        <span className={`truncate ${summary.kind==='heartbeat'?'text-muted-foreground':''}`}>{raw?row.text:summary.text}</span>
        <span className="text-right text-muted-foreground">{row.type==='json'||row.type==='text'?messageBytes(row.bytes):''}</span>
      </button>)}
      {!visible.length&&<p className="py-8 text-xs text-muted-foreground">{filter==='all'?'Waiting for messages…':'No matching messages.'}</p>}

    </div>
    <p className="mt-4 text-xs text-muted-foreground">Last 200 messages, in memory only · click a row for the raw frame · frames over 64 KiB show as a size notice{paused ? ' Display paused; collection continues.' : ''}</p>
    {selected && <Dialog open onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="max-w-3xl"><DialogTitle>Message payload</DialogTitle><DialogDescription>{selected.type} · {selected.bytes} B</DialogDescription><pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{selected.text}</pre></DialogContent></Dialog>}
  </section>;
}
