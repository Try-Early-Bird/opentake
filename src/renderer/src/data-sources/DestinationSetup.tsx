import {suggestedMetadataKey,suggestedFields} from './mapping-suggestions';
import {RoutedPriceSetup} from './RoutedPriceSetup';
import { Select } from '../components/ui/select';
import { useEffect, useState } from 'react';
import type { CustomSourceConfig, InspectedSourceField, DestinationWritePreview } from '../../../shared/data-sources';
import type { MarketHit } from '../../../shared/search';
export type Destination = NonNullable<CustomSourceConfig['feeds'][number]['destination']>;
const control = 'mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm';
export function DestinationSetup({ destination, onChange, fields, timestampFields, timestamp, onTimestamp, keys, onKeys }: {
  destination: Destination; onChange(value: Destination): void; fields: InspectedSourceField[];
  timestampFields: InspectedSourceField[]; timestamp: string[]; onTimestamp(path: string[]): void; keys: string[]; onKeys(keys: string[]): void;
}) {
  const [query, setQuery] = useState(''), [hits, setHits] = useState<{symbol: string; displayName: string}[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setHits([]); setError('');
    if (!query.trim()) return;
    const timer = setTimeout(() => { void window.portfolio.search(query.trim()).then(result => { if (alive) setHits(result); }).catch(() => { if (alive) setError('Could not search markets. Try again.'); }); }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [query]);
  const market = destination.kind !== 'custom-feed' && destination.kind !== 'market-prices' ? destination.market : undefined;
  function choose(kind: Destination['kind']) {
    if (kind === 'custom-feed') onChange({ kind });
    else if (kind === 'market-price') onChange({ kind, market: {venue:'robinhood', instance:'production', kind:'equity', reference: market?.venue === 'robinhood' && market.kind === 'equity' ? market.reference : ''}, currency:'USD', policy:'replace-stale', maxAgeMs:60000, allowSharedPriceWrites:true });
    else if(kind==='market-prices') onChange({kind,market:{venue:'robinhood',instance:'production',kind:'equity'},symbolField:'',priceField:'',conditions:[],currency:'USD',policy:'replace-stale',maxAgeMs:60000,allowSharedPriceWrites:true});
    else if(kind==='market-metadata') onChange({kind, market: market ?? {venue:'robinhood',instance:'production',kind:'equity',reference:''}, namespace:'details', maxAgeMs:60000});
  }
  function selectMarket(identity: MarketHit['identity']) {
    if (destination.kind === 'market-price') onChange({...destination, market:{venue:'robinhood',instance:'production',kind:'equity',reference:identity.reference}});
    else if (destination.kind === 'market-metadata') onChange({...destination,market:identity});
    setQuery('');
  }
  if(destination.kind==='market-prices')return <RoutedPriceSetup destination={destination} onChange={onChange} fields={fields.map((field,index)=>({key:keys[index]??`field_${index+1}`,field}))} inspection={timestampFields} timestamp={timestamp} onTimestamp={onTimestamp}/>;
  return <>
    <label className="block text-sm">Use this data for<Select id="source-destination" ariaLabel="Use this data for" className={control} value={destination.kind} onValueChange={value => choose(value as Destination['kind'])} items={[{value:'custom-feed',label:'Custom feed'},{value:'market-price',label:'One market price'},{value:'market-prices',label:'Market prices'},{value:'market-metadata',label:'Market metadata'}]} /></label>
    {market && <><div className="text-sm">Market{market.reference && <p className="mt-2 rounded-lg border border-input p-3">{market.reference} · {market.venue} · {market.instance} · {market.kind}</p>}<label className="block mt-2">Find or change market<input className={control} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Robinhood equities" maxLength={64}/></label><p className="mt-2 text-xs text-muted-foreground">This picker currently supports Robinhood equities. Price writes require an existing USD market price record.</p>{hits.map(hit => <button type="button" className="block w-full border-b border-border py-3 text-left" key={hit.symbol} onClick={() => selectMarket({venue:'robinhood',instance:'production',kind:'equity',reference:hit.symbol})}>{hit.symbol} · {hit.displayName}</button>)}{error && <p role="alert">{error}</p>}</div></>}
    {destination.kind === 'market-price' && <>
      <p className="text-sm">Price field: {fields.length === 1 && fields[0].type === 'number' ? fields[0].path.join('.') : 'Go back and select exactly one numeric price field.'} · USD</p>
      <label className="block text-sm">Provider timestamp<Select id="source-timestamp" ariaLabel="Provider timestamp" className={control} value={JSON.stringify(timestamp)} onValueChange={value => onTimestamp(JSON.parse(value))} items={[{value:'[]',label:'Choose a timestamp field'}, ...suggestedFields(timestampFields,'timestamp').map(({field,suggested}) => ({value:JSON.stringify(field.path),label:`${field.path.join('.')} · Unix milliseconds${suggested?' · Suggested':''}`}))]} /></label>
      <label className="block text-sm">Update rule<Select id="source-update-rule" ariaLabel="Update rule" className={control} value={destination.policy} onValueChange={value => onChange({...destination,policy:value as 'fill-missing' | 'replace-stale'})} items={[{value:'replace-stale',label:'Fill missing or replace stale prices'},{value:'fill-missing',label:'Fill missing prices only'}]} /></label>
      <p className="text-xs text-muted-foreground">Fresh competing quotes stay in place. This source can update its own values.</p>
    </>}
    {destination.kind === 'market-metadata' && <>
      <label className="block text-sm">Namespace<input className={control} value={destination.namespace} maxLength={64} onChange={event => onChange({...destination,namespace:event.target.value})}/></label>
      {fields.map((field,index) => <label className="block text-sm" key={JSON.stringify(field.path)}>{field.path.join('.')} → Metadata field<input className={control} value={keys[index] ?? ''} maxLength={64} onChange={event => onKeys(keys.map((key,i) => i === index ? event.target.value : key))}/>{keys[index]!==suggestedMetadataKey(field,keys.filter((_,i)=>i!==index))&&<button type="button" className="mt-2 text-xs underline" onClick={()=>onKeys(fields.map((_,i)=>i===index?suggestedMetadataKey(field,keys.filter((_,j)=>j!==index)):keys[i]??''))}>Use suggested: {suggestedMetadataKey(field,keys.filter((_,i)=>i!==index))}</button>}</label>)}
      <p className="text-xs text-muted-foreground">Only selected fields are updated. Null or missing values preserve previous values. Other namespaces stay unchanged. Metadata is stored for future market views.</p>
    </>}
    {destination.kind !== 'custom-feed' && <label className="block text-sm">Freshness limit<Select id="source-freshness" ariaLabel="Freshness limit" className={control} value={String(destination.maxAgeMs)} onValueChange={value => onChange({...destination,maxAgeMs:Number(value)})} items={[15000,60000,300000,...(destination.maxAgeMs > 300000 ? [destination.maxAgeMs] : [])].map(ms => ({value:String(ms),label:`${ms / 1000} seconds`}))} /><span className="mt-2 block text-xs text-muted-foreground">Reject incoming values older than this.{destination.kind === 'market-price' && ' Competing prices become replaceable after this limit.'}</span></label>}
    {destination.kind === 'market-price' && <p className="rounded-lg bg-muted/40 p-4 text-sm">Updates the app’s shared market price. This can affect portfolio values, Take calculations, and execution calculations. Broker refreshes take priority.</p>}
  </>;
}
export function WritePreview({result}: {result: DestinationWritePreview}) {
  const describe = (value: unknown) => {
    if (!value || typeof value !== 'object') return 'No value';
    const row = value as Record<string, unknown>;
    if ('price' in row) return `${row.price === null ? 'No price' : '$' + String(row.price)}\n${String(row.provider ?? '')}\n${row.eventTime || row.observedAt ? new Date(String(row.eventTime ?? row.observedAt)).toLocaleString() : ''}`;
    return Object.entries(row).map(([key, entry]) => `${key}: ${String(entry)}`).join('\n') || 'No values';
  };
  return <section className="space-y-3 text-sm" aria-label="Write preview"><p className="font-medium">{result.outcome === 'would-write' ? 'Would update' : result.outcome === 'preserved' ? 'Existing value preserved' : result.outcome.replaceAll('-', ' ')}</p><div className="grid gap-4 sm:grid-cols-2"><div><p className="text-muted-foreground">Current value</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{describe(result.current)}</pre></div><div><p className="text-muted-foreground">Incoming value</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{describe(result.proposed)}</pre></div></div><p className="text-xs text-muted-foreground">Preview only. Rules are checked again for every incoming value.</p></section>;
}
