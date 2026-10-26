import type {WebsocketSource} from '../../../shared/websocket-sources';
import {useEffect,useState} from 'react';
import type {CustomDataSource,MarketMetadataSnapshot} from '../../../shared/data-sources';
type Feed=Pick<CustomDataSource['config']['feeds'][number],'id'|'destination'>;
type Namespace=MarketMetadataSnapshot['namespaces'][number];
/** Reads committed metadata, not the latest response (which may not have written). */
export function MetadataValues({source,feed}:{source:CustomDataSource|WebsocketSource;feed:Feed}){
 const [result,setResult]=useState<{key:string;value:Namespace|null}>(),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 const destination=feed.destination;
 const key=JSON.stringify([source.id,source.revision,source.enabled,source.validated,source.config.collection,feed.id,destination]);
 const active=source.enabled&&source.validated&&source.config.collection!=='off';
 useEffect(()=>{
  let disposed=false,pending=false;setResult(undefined);setError('');
  if(!active||destination?.kind!=='market-metadata')return;
  async function read(){
   if(pending||disposed||document.hidden||destination?.kind!=='market-metadata')return;
   pending=true;
   try{
    const snapshot=await window.dataSources.marketMetadata(destination.market);
    if(!disposed){setResult({key,value:snapshot.namespaces.find(row=>row.namespace===destination.namespace&&row.sourceId===source.id&&row.revision===source.revision&&row.feedId===feed.id)??null});setError('');}
   }catch{if(!disposed){setResult(undefined);setError('Could not read saved metadata.');}}finally{pending=false;}
  }
  void read();const interval=setInterval(()=>void read(),15000);
  const visible=()=>{if(!document.hidden)void read();};document.addEventListener('visibilitychange',visible);
  return()=>{disposed=true;clearInterval(interval);document.removeEventListener('visibilitychange',visible);};
 },[key,active,attempt]);
 if(destination?.kind!=='market-metadata')return null;
 if(!active)return <p className="mt-4 text-xs text-muted-foreground">Saved metadata is unavailable while this source is paused or unvalidated.</p>;
 if(error)return <p role="alert" className="mt-4 text-xs text-destructive">{error} <button type="button" className="underline" onClick={()=>setAttempt(n=>n+1)}>Retry</button></p>;
 if(!result||result.key!==key)return <p className="mt-4 text-xs text-muted-foreground">Loading saved metadata…</p>;
 if(!result.value||!Object.keys(result.value.fields).length)return <p className="mt-4 text-xs text-muted-foreground">No metadata saved for this source revision yet.</p>;
 const value=result.value;
 return <section className="my-5" aria-label="Saved metadata"><div className="mb-3 flex justify-between gap-4 text-xs text-muted-foreground"><span>Saved metadata · {value.namespace}</span><span>Last updated {new Date(value.updatedAt).toLocaleString()}</span></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2 font-normal">Field</th><th className="pb-2 font-normal">Value</th><th className="pb-2 text-right font-normal">Last updated</th></tr></thead><tbody>{Object.entries(value.fields).map(([name,field])=>{const update=value.fieldUpdates[name];return <tr key={name} className="border-t border-border"><td className="py-3 pr-4 align-top">{name}</td><td className="max-w-64 break-words py-3 pr-4 align-top">{String(field)}</td><td className="py-3 text-right text-xs text-muted-foreground" title={update?.eventTime!=null?`Provider time: ${new Date(update.eventTime).toLocaleString()}`:undefined}>{update?.updatedAt!=null?new Date(update.updatedAt).toLocaleString():'Unknown'}<span className="mt-1 block">{update?.updatedAt==null?'Awaiting refresh':update.quality==='fresh'?'Fresh':'Stale'}</span></td></tr>;})}</tbody></table></div></section>;
}
