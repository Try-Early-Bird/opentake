import {CoinbaseAccountFeeds} from './CoinbaseAccountFeeds';
import {ManagedPollingEditor} from './ManagedPollingEditor';
import { SourceCollectionRow, SourceSectionHeader } from './SourceComponents';
import { managedSourceCapabilities } from './source-capabilities';
import { useEffect, useRef, useState } from 'react';
import { managedPollDefaults, type ManagedPollSetting } from '../../../shared/managed-polls';
const descriptions: Record<string,string> = {
  'robinhood-account-sync':'Balances, holdings, orders and fills',
  'coinbase-account-sync':'Balances, holdings, orders and fills',
  'robinhood-prices':'Quotes and chart history for held symbols',
  'robinhood-earnings':'Upcoming reports for held symbols',
};
const intervals = (id:string) => id.endsWith('account-sync') ? [5000,30000,60000,300000] : id.endsWith('earnings') ? [30000,300000,3600000,86400000] : [30000,60000,300000,900000];
export function ManagedPollingSettings({venue,accountId,accountLabel}:{venue:'robinhood'|'coinbase';accountId:string;accountLabel:string}) {
  const [saved,setSaved]=useState<ManagedPollSetting[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  const [editing,setEditing]=useState<ManagedPollSetting>();
  const saving=useRef(false);
  useEffect(()=>{let alive=true;setError('');setSaved(undefined);void window.dataSources.managedSettings(accountId).then(items=>{if(alive)setSaved(items.filter(item=>managedPollDefaults.some(job=>job.id===item.id&&job.venue===venue)));}).catch(()=>{if(alive)setError('Could not load polling settings.');});return()=>{alive=false;};},[venue,accountId,retry]);
  async function change(item:ManagedPollSetting,patch:Partial<ManagedPollSetting>){
    if(saving.current)return false;saving.current=true;setBusy(true);setError('');
    try {const next=await window.dataSources.saveManagedSetting({...item,...patch});setSaved(items=>items?.map(old=>old.id===next.id?next:old));return true;}
    catch{setError('Change was not confirmed. Reload settings before trying again.');return false;}
    finally{saving.current=false;setBusy(false);}
  }
  return <section aria-label="Background polling settings" className="mb-9">
    <SourceSectionHeader title={`Background checks · ${accountLabel}`} actions={<><span role="status">{busy?'Saving…':error?'Settings need attention':saved?'Saved · applies to upcoming checks':'Loading settings…'}</span>{venue==='coinbase'&&<CoinbaseAccountFeeds accountId={accountId} accountLabel={accountLabel}/>}</>}/>
    <fieldset disabled={busy||!!error}>{saved?.map(item=>{const job=managedPollDefaults.find(job=>job.id===item.id)!;const on=item.collection==='automatic';return <div key={item.id}><SourceCollectionRow name={job.name} description={on?descriptions[item.id]:'Off · background checks paused'} on={on} busy={busy||!!error} capabilities={managedSourceCapabilities} intervalMs={item.intervalMs} choices={intervals(item.id)} onToggle={()=>void change(item,{collection:on?'off':'automatic'})} onInterval={ms=>void change(item,{intervalMs:ms})}/><div className="flex justify-end pt-2"><button type="button" aria-label={`Edit ${job.name.toLowerCase()}`} onClick={()=>setEditing(item)} className="text-xs text-muted-foreground underline underline-offset-4">Edit</button></div></div>;})}</fieldset>
    <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Checks follow {venue==='coinbase'?'Coinbase’s':'Robinhood’s'} refresh rules, so not every check brings new data. Turning one off pauses its background checks; in-progress work, manual refresh, reconnect recovery and trading-required reads can still run.</p>
    {error&&<p role="alert" className="mt-3 text-xs text-destructive">{error} <button disabled={busy} className="underline" onClick={()=>setRetry(value=>value+1)}>Reload settings</button></p>}
    {editing&&<ManagedPollingEditor setting={editing} accountLabel={accountLabel} onSave={next=>change(editing,next)} onClose={()=>setEditing(undefined)}/>}
  </section>;
}
