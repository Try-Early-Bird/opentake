import {routedMappingError} from './websocket-draft';
import { Select } from '../components/ui/select';
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog';
import type { CredentialMetadata } from '../../../shared/credentials';
import type { CustomDataSource, CustomSourceConfig, DataSourceInspection, DestinationWritePreview } from '../../../shared/data-sources';
import { DestinationSetup, WritePreview, type Destination } from './DestinationSetup';
import { buildSourceDraft } from './source-draft';

const control = 'mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm';
const button = 'rounded-full border border-border px-4 py-2 text-sm disabled:opacity-40';
const steps = ['Connect', 'Choose fields', 'Destination', 'Collection & storage', 'Review'];
export function SourceSetup({ source, onSaved, onClose, onWebsocket }: { onWebsocket?(): void; source?: CustomDataSource; onSaved(source: CustomDataSource): void; onClose(): void }) {
  const config = source?.config, storage = config?.feeds[0]?.storage;
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [name, setName] = useState(config?.name ?? ''), [endpoint, setEndpoint] = useState(config?.endpoint ?? '');
  const [credentialId, setCredentialId] = useState(config?.credentialId ?? ''), [credentials, setCredentials] = useState<CredentialMetadata[]>([]), [credentialError, setCredentialError] = useState(false);
  const [inspection, setInspection] = useState<DataSourceInspection>(), [selected, setSelected] = useState<number[]>([]);
  const [unit, setUnit] = useState(config?.feeds[0]?.unit ?? 'points');
  const [collection, setCollection] = useState<CustomSourceConfig['collection']>(config?.collection ?? 'when-open');
  const [poll, setPoll] = useState(config?.pollIntervalMs ?? 60000), [mode, setMode] = useState<'live' | 'latest' | 'history'>(storage?.mode ?? 'live');
  const [sample, setSample] = useState(storage?.sampleEveryMs ?? 60000), [days, setDays] = useState<1 | 7 | 30 | 90>(storage?.retentionDays ?? 7);
  const [saved, setSaved] = useState(source), [validated, setValidated] = useState(false);
  const [destination, setDestination] = useState<Destination>(config?.feeds[0]?.destination ?? {kind:'custom-feed'});
  const [timestamp, setTimestamp] = useState<string[]>(config?.feeds[0]?.eventTimePath ?? []);
  const [metadataKeys, setMetadataKeys] = useState<string[]>([]);
  const [previews, setPreviews] = useState<DestinationWritePreview[]>([]), [consent, setConsent] = useState(false);
  const chosenFields = selected.map(index => inspection!.fields[index]);
  function updateDestination(value: Destination) { setDestination(value); if(value.kind==='market-prices')setUnit('USD'); if (value.kind !== 'custom-feed' && mode === 'live') setMode('latest'); changed(); }
  function prepareDestination() {
    const mapping = config?.feeds[0]?.mapping;
    setMetadataKeys(chosenFields.map((field, index) => mapping?.kind === 'event' ? Object.entries(mapping.fields).find(([, entry]) => JSON.stringify(entry.path) === JSON.stringify(field.path))?.[0] ?? `field_${index + 1}` : `field_${index + 1}`));
    setStep(2);
  }
  const destinationReady = destination.kind === 'custom-feed' || (destination.kind==='market-prices'?!routedMappingError(destination,chosenFields.map((field,index)=>({key:metadataKeys[index]??`field_${index+1}`,field})),timestamp):Boolean(destination.market.reference && (destination.kind === 'market-price' ? chosenFields.length === 1 && chosenFields[0].type === 'number' && inspection?.fields.some(field => field.type === 'number' && JSON.stringify(field.path) === JSON.stringify(timestamp)) : /^[a-z][a-z0-9_-]{0,63}$/.test(destination.namespace) && !['constructor','prototype','__proto__'].includes(destination.namespace) && metadataKeys.length === chosenFields.length && new Set(metadataKeys).size === metadataKeys.length && metadataKeys.every(key => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && !['constructor','prototype','__proto__'].includes(key)))));
  useEffect(() => { let alive = true; void window.settings.listCredentials().then(result => {
    if (!alive) return; if (result.ok) setCredentials(result.items.filter(item => item.type === 'http-api')); else setCredentialError(true);
  }).catch(() => { if (alive) setCredentialError(true); }); return () => { alive = false; }; }, []);
  function changed() { setValidated(false); setPreviews([]); setConsent(false); setError(''); }
  async function inspect() {
    setBusy(true); changed(); setInspection(undefined); setSelected([]);
    try {
      const result = await window.dataSources.inspect({ endpoint: endpoint.trim(), ...(credentialId ? { credentialId } : {}) });
      setInspection(result); setStep(1);
      const mapping = config?.feeds[0]?.mapping;
      if (mapping) { const paths = mapping.kind === 'event' ? Object.values(mapping.fields).map(field => JSON.stringify(field.path)) : [JSON.stringify(mapping.valuePath)]; setSelected(result.fields.flatMap((field,index) => field.selectable && paths.includes(JSON.stringify(field.path)) ? [index] : [])); }
    } catch { setError('Could not inspect this endpoint. Check its URL, saved credential, and JSON response.'); }
    finally { setBusy(false); }
  }
  async function validate() {
    setBusy(true); changed();
    try {
      const draft = buildSourceDraft({ name, endpoint, credentialId, fields: selected.map(index => inspection!.fields[index]), unit, collection, pollIntervalMs: poll, mode, sampleEveryMs: sample, retentionDays: days, destination, eventTimePath: timestamp.length?timestamp:undefined, metadataKeys, retainedFields:config?.feeds[0]?.storage.fields, feedId: config?.feeds[0]?.id });
      const next = await window.dataSources.saveSource(draft, saved ? { id: saved.id, revision: saved.revision } : undefined);
      setSaved(next); onSaved(next);
      const result = await window.dataSources.previewSource(next.id, next.revision);
      if (destination.kind !== 'custom-feed' && !result.destinations?.length) throw Error('Missing destination preview');
      setPreviews(result.destinations ?? []); setConsent(false);
      setValidated(true); onSaved({ ...next, validated: true });
    } catch { setError('Could not validate this source. It remains disabled. Check the response mapping and credential, then retry.'); }
    finally { setBusy(false); }
  }
  async function enable() {
    if (!saved || !validated || ['market-price','market-prices'].includes(destination.kind) && !consent) return;
    setBusy(true); setError('');
    try { await window.dataSources.enableSource(saved.id, saved.revision, true); onSaved({ ...saved, validated: true, enabled: true }); onClose(); }
    catch { setError('Could not enable this revision. Reload its settings and validate again.'); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto gap-0 p-0" showCloseButton={!busy}>
    <header className="px-7 pt-7 pb-5"><DialogTitle className="text-2xl">{source ? 'Edit data source' : 'Add a data source'}</DialogTitle><DialogDescription className="mt-2">Connect first, then choose the data you want to use.</DialogDescription></header>
    <nav aria-label="Setup steps" className="mx-7 flex flex-wrap gap-x-6 border-b border-border">{steps.map((label, index) => <button key={label} disabled={busy || index > step} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)} className={`border-b-2 py-3 text-sm disabled:opacity-40 ${step === index ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}>{label}</button>)}</nav>
    <fieldset disabled={busy} className="min-w-0 space-y-5 px-7 py-6" onChange={event => { if (!(event.target instanceof HTMLInputElement && event.target.name === 'price-consent')) changed(); }}>
      {step === 0 && <>
        {!source && onWebsocket && <label className="block text-sm">Source type<Select id="source-type" ariaLabel="Source type" className={control} value="http" onValueChange={value=>{if(value==='websocket')onWebsocket();}} items={[{value:'http',label:'HTTP'},{value:'websocket',label:'WebSocket'}]}/></label>}
        <label className="block text-sm">Name<input className={control} value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Market sentiment" /></label>
        <label className="block text-sm">Endpoint<input className={control} value={endpoint} maxLength={2048} spellCheck={false} onChange={event => { setEndpoint(event.target.value); setInspection(undefined); }} placeholder="https://data.example.com/sentiment" /><span className="mt-2 block text-xs text-muted-foreground">HTTPS · read-only JSON request · no query parameters</span></label>
        <label className="block text-sm">Credential<Select id="source-credential" ariaLabel="Credential" className={control} value={credentialId} onValueChange={value => { setCredentialId(value); setInspection(undefined); }} items={[{value:'',label:'No authentication'}, ...(credentialId && !credentials.some(item => item.id === credentialId) ? [{value:credentialId,label:'Previously selected credential'}] : []), ...credentials.map(item => ({value:item.id,label:`${item.name} · HTTP API`}))]} /></label>
        {credentialError && <p className="text-sm text-destructive">Could not load saved credentials. Unlock secure storage and reopen setup.</p>}
        <p className="text-xs text-muted-foreground">Secrets stay hidden. Manage HTTP API credentials in <Link to="/settings" search={{ section: 'credentials' }} onClick={onClose} className="underline">Settings → Credentials</Link>.</p>
        <div className="rounded-lg bg-muted/40 p-4 text-sm">Inspect one response<p className="mt-1 text-xs text-muted-foreground">Discover fields and types before setting up your feed. Recurring collection stays off.</p></div>
      </>}
      {step === 1 && inspection && <>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">Choose fields from the response</h3><p className="mt-1 text-xs text-muted-foreground">{inspection.fields.length} fields found · select up to 32</p></div><button className={button} onClick={() => void inspect()}>Inspect again</button></div>
        {inspection.truncated && <p className="text-xs text-muted-foreground">Showing a bounded selection of fields. Use a smaller response if a field is missing.</p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr>{['Use', 'Field', 'Inferred type', 'Sample value'].map(label => <th className="border-b border-border px-2 py-3 font-normal" key={label}>{label}</th>)}</tr></thead><tbody>{inspection.fields.map((field, index) => <tr key={JSON.stringify(field.path)}><td className="border-b border-border px-2 py-3"><input type="checkbox" aria-label={`Select ${field.path.join('.')}`} disabled={!field.selectable || !selected.includes(index) && selected.length >= 32} checked={selected.includes(index)} onChange={event => setSelected(current => event.target.checked ? [...current, index].sort((a,b)=>a-b) : current.filter(value => value !== index))} /></td><td className="max-w-48 break-words border-b border-border px-2 py-3 font-mono text-xs">{field.path.map(key => JSON.stringify(key)).join(' → ')}</td><td className="border-b border-border px-2 py-3 text-muted-foreground">{field.type}</td><td className="max-w-60 break-words border-b border-border px-2 py-3">{String(field.sample)}{!field.selectable && <span className="block text-xs text-muted-foreground">Item mapping not supported yet</span>}</td></tr>)}</tbody></table></div>
        {!inspection.fields.length && <p>No selectable fields were found. Try an endpoint returning a JSON object.</p>}
        <label className="block text-sm">Unit<input className={control} value={unit} maxLength={80} onChange={event => setUnit(event.target.value)} /><span className="mt-2 block text-xs text-muted-foreground">Confirm the unit for this feed. Multiple fields are kept together as a record.</span></label>
        <p className="rounded-lg bg-muted/40 p-4 text-xs text-muted-foreground">Types are inferred from one response. Future responses are checked against your mapping. Sensitive fields are omitted.</p>
      </>}
      {step === 2 && <DestinationSetup destination={destination} onChange={updateDestination} fields={chosenFields} timestampFields={inspection?.fields ?? []} timestamp={timestamp} onTimestamp={value=>{setTimestamp(value);changed();}} keys={metadataKeys} onKeys={setMetadataKeys} />}
      {step === 3 && <>
        <label className="block">Collect<Select id="source-collection" ariaLabel="Collect" className={control} value={collection} onValueChange={value => setCollection(value as typeof collection)} items={[{value:'when-open',label:'Only when open'},{value:'automatic',label:'Automatic'},{value:'off',label:'Off'}]} /><span className="mt-2 block text-xs text-muted-foreground">Automatic currently follows open views. Take-driven collection comes later.</span></label>
        <label className="block">Refresh every<Select id="source-refresh" ariaLabel="Refresh every" className={control} value={String(poll)} onValueChange={value => setPoll(Number(value))} items={[15000,60000,300000,3600000].map(value => ({value:String(value),label:`${value / 1000} seconds`}))} /></label>
        <label className="block">Keep on this device<Select id="source-storage" ariaLabel="Keep on this device" className={control} value={mode} onValueChange={value => setMode(value as typeof mode)} items={[{value:'live',label:'Live only',disabled:destination.kind !== 'custom-feed'},{value:'latest',label:'Latest value'},{value:'history',label:'History'}]} /></label>
        {mode === 'history' && <div className="grid gap-4 sm:grid-cols-2"><label>Sample every<Select id="source-sample" ariaLabel="Sample every" className={control} value={String(sample)} onValueChange={value => setSample(Number(value))} items={[15000,60000,300000,3600000].map(value => ({value:String(value),label:`${value / 1000} seconds`}))} /></label><label>Keep for<Select id="source-retention" ariaLabel="Keep for" className={control} value={String(days)} onValueChange={value => setDays(Number(value) as typeof days)} items={[1,7,30,90].map(value => ({value:String(value),label:`${value} days`}))} /></label></div>}
        <p className="text-xs text-muted-foreground">Only selected fields are retained. Up to 100,000 history samples across your sources; oldest samples go first.</p>
      </>}
      {step === 4 && <><h3 className="font-medium">{validated ? 'Validation passed' : 'Ready to validate'}</h3><p className="text-sm text-muted-foreground">{validated ? 'Enable this source when you’re ready. Collection starts when a view requests its feed.' : 'Save this source as disabled, then check your selected fields against a fresh response.'}</p><dl className="space-y-4 text-sm"><div className="flex justify-between gap-4 border-b border-border pb-3"><dt>Source</dt><dd>{name}</dd></div><div className="flex justify-between border-b border-border pb-3"><dt>Selected fields</dt><dd>{selected.length}</dd></div><div className="flex justify-between border-b border-border pb-3"><dt>Destination</dt><dd>{destination.kind==='market-prices'?'Mapped market prices':destination.kind === 'custom-feed' ? 'Custom feed' : `${destination.market.reference} · ${destination.kind === 'market-price' ? 'Market price' : destination.namespace}`}</dd></div><div className="flex justify-between border-b border-border pb-3"><dt>Keep on device</dt><dd>{mode === 'live' ? 'Live only' : mode === 'latest' ? 'Latest value' : `History · ${days} days`}</dd></div></dl><p className="text-xs text-muted-foreground">Inspection and validation do not write destination values or retain samples.</p>{previews.map(preview => <WritePreview key={preview.feedId} result={preview}/>)}{validated && (destination.kind === 'market-price'||destination.kind==='market-prices') && <label className="flex items-start gap-3 text-sm"><input name="price-consent" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>Allow this source to update {destination.kind==='market-price'?`the shared ${destination.market.reference} price`:'shared market prices under these rules'}.<span className="mt-1 block text-xs text-muted-foreground">This can affect valuations and execution calculations.</span></span></label>}</>}
    </fieldset>
    {error && <p role="alert" className="px-7 pb-4 text-sm text-destructive">{error}</p>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-7 py-5"><span role="status" className="text-xs text-muted-foreground">{busy ? 'Working…' : validated ? 'Validated · collection off' : saved ? 'Saved source · changes need validation' : 'Unsaved source'}</span><div className="flex gap-2"><button disabled={busy || step === 0} onClick={() => setStep(step - 1)} className={button}>Back</button><button disabled={busy || step === 0 && (!name.trim() || !endpoint.trim()) || step === 1 && (!selected.length || !unit.trim()) || step === 2 && !destinationReady || step === 4 && validated && collection !== 'off' && ['market-price','market-prices'].includes(destination.kind) && !consent} className={`${button} bg-foreground text-background`} onClick={() => { if (step === 0) void inspect(); else if (step === 1) prepareDestination(); else if (step < 4) setStep(step + 1); else if (!validated) void validate(); else if (collection === 'off') onClose(); else void enable(); }}>{step === 0 ? 'Connect & inspect' : step === 1 ? 'Use selected fields' : step === 2 ? 'Collection & storage' : step === 3 ? 'Review source' : !validated ? 'Save & validate' : collection === 'off' ? 'Done' : 'Enable source'}</button></div></footer>
  </DialogContent></Dialog>;
}
