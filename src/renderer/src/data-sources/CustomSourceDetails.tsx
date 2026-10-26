import {MetadataValues} from './MetadataValues';
import { SourceHeader, SourceCollectionRow, SourceSectionHeader, SourceFeedRow } from './SourceComponents';
import { customSourceCapabilities } from './source-capabilities';
import { useSourceSnapshots } from './useSourceSnapshots';
import { useState } from 'react';
import type { CustomDataSource } from '../../../shared/data-sources';

export function CustomSourceDetails({ source, onEdit, onUpdated }: { source: CustomDataSource; onEdit(): void; onUpdated(source: CustomDataSource): void }) {
  const controlledDestination = source.config.feeds.some(feed => feed.destination && feed.destination.kind !== 'custom-feed');
  const { snapshots, error: readError } = useSourceSnapshots(source);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[activity,setActivity]=useState(false);
  const capabilities=customSourceCapabilities(source);
  async function toggle() {
    setBusy(true); setError('');
    try { await window.dataSources.enableSource(source.id, source.revision, !source.enabled); onUpdated({ ...source, enabled: !source.enabled }); }
    catch { setError('Could not change collection. Reopen setup and validate this source.'); }
    finally { setBusy(false); }
  }
  return <section className="min-w-0" aria-label="Custom source details">
    <SourceHeader icon={<span aria-hidden="true" className="rounded-lg bg-muted p-2 font-mono">{'{ }'}</span>} title={source.config.name} description={source.config.endpoint} status={source.enabled?'Enabled':'Paused'} actions={capabilities.edit&&<button className="rounded-full border border-border px-4 py-2 text-sm disabled:opacity-40" disabled={busy} onClick={onEdit}>Edit</button>}/>
    <section className="mb-9" aria-label="Source collection settings"><SourceSectionHeader title="Collection · HTTP" actions={<span>{busy?'Saving…':'Saved'}</span>}/><SourceCollectionRow name="HTTP polling" toggleLabel={source.enabled?'Pause':'Enable'} on={source.enabled} busy={busy} capabilities={capabilities} intervalMs={source.config.pollIntervalMs} onToggle={()=>void toggle()} onReview={onEdit} description={source.enabled?(source.config.collection==='automatic'?'Automatic · currently follows open views':'Only while a view is open'):'Paused · collection is off'}/><p className="mt-4 text-xs text-muted-foreground">Refresh changes create a new revision and require validation in Edit.</p></section>
    <SourceSectionHeader title={`${source.config.name} · Feeds`} actions={<button aria-expanded={activity} onClick={()=>setActivity(value=>!value)} className="hover:underline">Activity</button>}/>
    {activity&&<section aria-label="Latest source activity" className="my-4 rounded-lg bg-muted/40 p-4 text-xs text-muted-foreground">{source.config.feeds.map(feed=><p key={feed.id}>{feed.name} · {snapshots[feed.id]?.connection??'idle'} · {snapshots[feed.id]?.quality??'missing'}</p>)}</section>}
    {controlledDestination && <p className="mb-5 text-sm text-muted-foreground">This source has market write policies. You can pause it here; open Edit to review its destination before enabling it again.</p>}
    {!source.validated && <p className="mb-5 text-sm text-muted-foreground">Collection is off. Open Edit to inspect and validate this source.</p>}
    {(error||readError) && <p role="alert" className="mb-5 text-sm text-destructive">{error||readError}</p>}
    {source.config.feeds.map(feed => { const snapshot = snapshots[feed.id]; const payload = snapshot?.latest?.payload; return <SourceFeedRow key={feed.id} name={feed.name} status={!source.enabled?'Paused':snapshot?`${snapshot.connection} · ${snapshot.quality}`:'Waiting for data'} description={<>{feed.storage.mode === 'live' ? 'Live only' : feed.storage.mode === 'latest' ? 'Latest value' : `History · sample every ${feed.storage.sampleEveryMs / 1000}s · ${feed.storage.retentionDays} days`}{capabilities.destination&&feed.destination&&feed.destination.kind!=='custom-feed'?feed.destination.kind==='market-prices'?' · Mapped market prices':` · ${feed.destination.market.reference} · ${feed.destination.kind==='market-price'?'Market price':feed.destination.namespace}`:' · Custom feed'}</>}>
      {feed.destination?.kind==='market-metadata'?<MetadataValues key={`${source.id}:${source.revision}:${feed.id}`} source={source} feed={feed}/>:payload && <div className="my-5 space-y-2">{payload.kind === 'metric' || payload.kind === 'boolean' ? <p className="text-2xl">{String(payload.value)} <span className="text-sm text-muted-foreground">{feed.unit}</span></p> : payload.kind === 'event' ? Object.entries(payload.fields).map(([key, value]) => <div key={key} className="flex justify-between gap-4 text-sm"><span className="break-all text-muted-foreground">{feed.mapping.kind === 'event' ? feed.mapping.fields[key]?.path.map(part => JSON.stringify(part)).join(' → ') ?? key : key}</span><span className="max-w-[60%] break-words">{String(value)}</span></div>) : null}</div>}
      {snapshot?.issue && <p className="mt-3 text-sm text-destructive">{snapshot.issue === 'invalid_data' ? 'Response or credential needs attention. Edit and validate the source.' : `Feed needs attention: ${snapshot.issue.replaceAll('_', ' ')}.`}</p>}
      {snapshot?.latest && <p className="mt-3 text-xs text-muted-foreground">Received {new Date(snapshot.latest.receivedAt).toLocaleString()}</p>}
    </SourceFeedRow>; })}
    <p className="mt-8 text-xs text-muted-foreground">This open view requests the feed. Closing or hiding it releases collection demand. Retained data follows your storage settings.</p>
  </section>;
}
