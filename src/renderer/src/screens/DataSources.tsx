import { CoinbaseStreamDetails } from '../data-sources/CoinbaseStreamDetails';
import { WebsocketDetails, StreamIcon } from '../data-sources/WebsocketDetails';
import { WebsocketSetup } from '../data-sources/WebsocketSetup';
import type { WebsocketSource } from '../../../shared/websocket-sources';
import { SourceHeader, SourceSectionHeader, SourceFeedRow } from '../data-sources/SourceComponents';
import { ManagedPollingSettings } from '../data-sources/ManagedPollingSettings';
import { SourceSetup } from '../data-sources/SourceSetup';
import { CustomSourceDetails } from '../data-sources/CustomSourceDetails';
import type { CustomDataSource } from '../../../shared/data-sources';
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw, Database, Plus } from 'lucide-react';
import type { DataSourceInventory, ManagedDataFeed, ManagedDataSource } from '../../../shared/data-sources';
import { CoinbaseMark, RobinhoodLogoTile } from '../logos';
import { cn } from '../lib/utils';

function SourceLogo({ venue, large = false }: { venue: ManagedDataSource['venue']; large?: boolean }) {
  return venue === 'coinbase'
    ? <CoinbaseMark className={cn('shrink-0', large ? 'size-9' : 'size-6')} />
    : <RobinhoodLogoTile className={large ? 'size-9' : 'size-6'} markClassName="size-5" />;
}
const venueName = (source: ManagedDataSource) => source.venue === 'coinbase' ? 'Coinbase' : 'Robinhood';
function status(source: ManagedDataSource) {
  if (!source.connected) return 'Connection needs attention';
  if (source.settingsUnreadable) return 'Settings need attention';
  if (source.feeds.some(feed => feed.state === 'failed' || feed.state === 'interrupted')) return 'Sync needs attention';
  if (source.feeds.some(feed => feed.state === 'running')) return 'Syncing';
  if (!source.feeds.length || source.feeds.every(feed => !feed.lastUpdatedAt)) return 'Awaiting first sync';
  return 'Connected';
}
function updated(value: string | null) {
  if (!value) return 'Not synced';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}) : 'Unavailable';
}
const stateLabels: Record<ManagedDataFeed['state'], string> = {
  waiting: 'Waiting for sync', running: 'Syncing', completed: 'Last sync completed',
  failed: 'Last sync failed', interrupted: 'Sync interrupted', partial: 'Partially synced',
};

export function DataSources(): React.JSX.Element {
  const [coinbaseSource,setCoinbaseSource]=useState<WebsocketSource>();
  const [websockets,setWebsockets]=useState<WebsocketSource[]>([]);
  const [wsSetup,setWsSetup]=useState<WebsocketSource|'new'|null>(null);
  function wsSaved(item:WebsocketSource){if(item.config.provider){setCoinbaseSource(item);setCustomId(undefined);setSelection('coinbase-public');return;}setWebsockets(items=>[...items.filter(value=>value.id!==item.id),item]);setCustomId(item.id);}
  const [custom, setCustom] = useState<CustomDataSource[]>([]);
  const [customId, setCustomId] = useState<string>();
  const [setup, setSetup] = useState<CustomDataSource | 'new' | null>(null);
  function saved(item: CustomDataSource) { setCustom(items => [...items.filter(value => value.id !== item.id), item]); setCustomId(item.id); }
  const selectedWs = websockets.find(item=>item.id===customId);
  const selectedCustom = custom.find(item => item.id === customId);
  const [inventory, setInventory] = useState<DataSourceInventory>();
  const [selection, setSelection] = useState<string>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activity, setActivity] = useState(false);
  useEffect(() => {
    let disposed = false, inFlight = false;
    async function load() {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const [next, customItems, wsItems, coinbaseItem] = await Promise.all([window.dataSources.inventory(), window.dataSources.customSources(), window.dataSources.configure({action:'websocket-list'}) as Promise<WebsocketSource[]>, window.dataSources.coinbaseStream.source()]);
        if (!disposed) {setWebsockets(wsItems);setCoinbaseSource(coinbaseItem);}
        if (!disposed) setCustom(customItems);
        if (!disposed) { setInventory(next); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally { inFlight = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 10_000);
    const visible = () => void load();
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [retry]);
  const platforms = inventory?.sources ?? [];
  const publicSelected = !customId && (selection === 'coinbase-public' || !platforms.length);
  const source = platforms.find(item => item.id === selection) ?? platforms[0];
  const sourceStatus = source ? status(source) : '';
  return <div className="mx-auto w-full max-w-[1400px] space-y-8">
    <Link to="/settings" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={13} aria-hidden="true" />Settings</Link>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="font-display text-[26px] tracking-[-0.02em]">Data sources</h1><p className="mt-2 text-sm text-muted-foreground">Account sync, shared market feeds, and your custom data sources.</p></div>
      <button type="button" onClick={() => setSetup('new')} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium"><Plus size={14} aria-hidden="true" />Add source</button>
    </header>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive"><p>Could not update data source status.{inventory ? ' Showing the last loaded status.' : ''}</p><button type="button" onClick={() => setRetry(value => value + 1)} className="underline underline-offset-4">Try again</button></div>}
    {!inventory && !error && <p role="status" className="py-12 text-sm text-muted-foreground">Loading data sources…</p>}
    {inventory && <div className="grid gap-8 md:grid-cols-[230px_minmax(0,1fr)] lg:gap-12">
      <aside aria-label="Data source selection" className="flex flex-col gap-7">
        <section><h2 className="mx-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Platforms</h2>
          <div className="mt-1 space-y-1">{platforms.map(item => <button key={item.id} type="button" aria-pressed={!customId && !publicSelected && source?.id === item.id} onClick={() => { setCustomId(undefined); setSelection(item.id); setActivity(false); }} className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted/50', !customId && !publicSelected && source?.id === item.id && 'bg-muted/70')}>
            <SourceLogo venue={item.venue} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{venueName(item)}</span><span className="block break-words text-xs text-muted-foreground">{item.label}</span></span>
            <span role="img" aria-label={status(item)} className={cn('size-1.5 shrink-0 rounded-full', status(item) === 'Connected' ? 'bg-success' : 'bg-muted-foreground')} />
          </button>)}</div>
          {!inventory.sources.length && <p className="px-3 py-4 text-xs text-muted-foreground">No connected platforms.</p>}
        </section>
        <section>
          <h2 className="mx-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Custom sources</h2>
          <button type="button" aria-pressed={publicSelected} onClick={()=>{setCustomId(undefined);setSelection('coinbase-public');}} className={cn('mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted/50',publicSelected&&'bg-muted/70')}>
            <SourceLogo venue="coinbase"/><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{coinbaseSource?.config.name??'Coinbase market data'}</span><span className="block text-xs text-muted-foreground">WebSocket</span></span>
          </button>
          {websockets.map(item=><button key={item.id} type="button" aria-pressed={customId===item.id} onClick={()=>setCustomId(item.id)} className={cn('mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left',customId===item.id&&'bg-muted/70')}><StreamIcon/><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{item.config.name}</span><span className="text-xs text-muted-foreground">WebSocket{!item.enabled?' · Paused':''}</span></span></button>)}{custom.map(item => <button key={item.id} type="button" aria-pressed={customId === item.id} onClick={() => setCustomId(item.id)} className={cn('mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left', customId === item.id && 'bg-muted/70')}><span aria-hidden="true" className="rounded bg-muted p-2 font-mono text-xs">{'{ }'}</span><span className="min-w-0"><span className="block break-words text-sm font-medium">{item.config.name}</span><span className="text-xs text-muted-foreground">HTTP · {item.enabled ? `every ${item.config.pollIntervalMs / 1000} s` : 'Paused'}</span></span></button>)}</section>
      </aside>
      {publicSelected ? <section className="min-w-0" aria-label="Coinbase market data source">
        <SourceHeader icon={<SourceLogo venue="coinbase" large/>} title={coinbaseSource?.config.name??'Coinbase market data'} description="WebSocket · Shared across accounts and asset pages" status={coinbaseSource&&!coinbaseSource.enabled?'Paused':undefined} actions={<button disabled={!coinbaseSource} onClick={()=>coinbaseSource&&setWsSetup(coinbaseSource)} className="rounded-full border border-border px-4 py-2 text-sm disabled:opacity-40">Edit</button>}/>
        <CoinbaseStreamDetails/>
      </section> : selectedWs ? <WebsocketDetails key={selectedWs.id} source={selectedWs} onEdit={()=>setWsSetup(selectedWs)} onUpdated={wsSaved}/> : selectedCustom ? <CustomSourceDetails key={selectedCustom.id} source={selectedCustom} onEdit={() => setSetup(selectedCustom)} onUpdated={saved} /> : source ? <section key={source.id} aria-label={`${venueName(source)} data feeds`} className="min-w-0">
        <SourceHeader icon={<SourceLogo venue={source.venue} large/>} title={venueName(source)} description={<>{source.label} · Account data used by your portfolio and Takes</>} status={sourceStatus}/>
        <ManagedPollingSettings venue={source.venue} accountId={source.id} accountLabel={source.label} />
        <SourceSectionHeader title={`${source.label} · Feeds`} actions={<><span className="flex items-center gap-1.5"><span aria-hidden="true" className={cn('size-1.5 rounded-full',sourceStatus==='Connected'?'bg-success':'bg-muted-foreground')}/>{sourceStatus==='Connected'?'Synced':sourceStatus}{source.feeds.some(feed=>feed.lastUpdatedAt)&&` ${updated(source.feeds.map(feed=>feed.lastUpdatedAt).filter((value):value is string=>!!value).sort().at(-1)!)}`}</span><button type="button" aria-expanded={activity} onClick={()=>setActivity(value=>!value)} className="hover:underline">Activity</button><button type="button" aria-label="Refresh saved sync status" onClick={()=>setRetry(value=>value+1)} className="rounded-full p-1.5 hover:bg-muted"><RefreshCw size={13}/></button></>}/>
        {activity && <section aria-label="Latest sync activity" className="my-4 space-y-2 rounded-lg bg-muted/40 p-4"><h3 className="text-sm font-medium">Latest sync activity</h3><p className="text-xs text-muted-foreground">Saved sync results; connection status alone does not mean data is current.</p>{source.feeds.map(feed=><div key={feed.id} className="flex flex-wrap justify-between gap-2 text-xs"><span>{feed.name} · {stateLabels[feed.state]}</span><span className="text-muted-foreground">{updated(feed.lastUpdatedAt)}</span></div>)}</section>}
        {source.settingsUnreadable && <p role="status" className="my-3 text-xs text-destructive">Saved feed choices couldn’t be read, so all feeds are collecting. Open Choose feeds and save to replace them.</p>}
        {!source.feeds.length && <p className="py-8 text-sm text-muted-foreground">Waiting for the first account sync.</p>}
        {source.feeds.map(feed=><SourceFeedRow key={feed.id} name={feed.name==='Account balance and holdings'?'Balances and holdings':feed.name} description={<>{feed.description} · From Account sync</>} status={feed.enabled===false?'Background paused':<time dateTime={feed.lastUpdatedAt??undefined} title={feed.lastUpdatedAt?new Date(feed.lastUpdatedAt).toLocaleString():'Not synced'} className="font-mono">{updated(feed.lastUpdatedAt)}</time>}>{(feed.state==='failed'||feed.state==='interrupted'||!source.connected)&&<p className="mt-2 text-xs text-destructive">{stateLabels[feed.state]} · Check <Link to="/settings" search={{section:'connections'}} className="underline">Connections</Link>.</p>}</SourceFeedRow>)}
        <p className="mt-8 text-xs text-muted-foreground">Status updates automatically. <Link to="/settings" search={{section:'data-retention'}} className="underline underline-offset-4">Data retention</Link></p>
      </section> : <section className="flex min-h-72 flex-col items-center justify-center gap-3 text-center"><Database size={28} className="text-muted-foreground" aria-hidden="true" /><h2 className="text-lg font-medium">Connect a platform to see its data sources</h2><p className="max-w-sm text-sm text-muted-foreground">Your connected accounts and their saved sync status will appear here.</p><Link to="/settings" search={{ section: 'connections' }} className="mt-2 text-sm underline underline-offset-4">Manage connections</Link></section>}
    </div>}
    {wsSetup && <WebsocketSetup source={wsSetup==='new'?undefined:wsSetup} onSaved={wsSaved} onClose={()=>setWsSetup(null)} onHttp={()=>{setWsSetup(null);setSetup('new');}}/>}
    {setup && <SourceSetup source={setup === 'new' ? undefined : setup} onSaved={saved} onClose={() => setSetup(null)} onWebsocket={()=>{setSetup(null);setWsSetup('new');}} />}
  </div>;
}
