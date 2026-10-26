import { useState } from 'react';
import { credentialFields, credentialTypes, validateCredentialPayload, visibleCredentialFields, type CredentialInput, type CredentialMetadata, type CredentialType } from '../../../shared/credentials';
import { DialogFooter } from '../components/ui/dialog';
import { Select } from '../components/ui/select';

const control = 'rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
export function CredentialForm({ type, item, busy, error, save, cancel }: { type: CredentialType; item?: CredentialMetadata; busy: boolean; error: string; save: (input: CredentialInput) => void; cancel: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [provider, setProvider] = useState(item?.provider ?? '');
  const [replacement, setReplacement] = useState(!item);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((credentialFields[type] ?? []).map(field => [field.key, field.key === 'provider' && item && field.options?.includes(item.provider) ? item.provider : field.options?.[0] ?? (field.key === 'port' ? '5432' : '')])));
  const [value, setValue] = useState('');
  const [validation, setValidation] = useState('');
  const structured = Boolean(credentialFields[type]);
  return <form className="grid gap-3" onSubmit={event => {
    event.preventDefault(); if (busy) return;
    const payload = replacement ? structured ? JSON.stringify(Object.fromEntries(visibleCredentialFields(type, values).map(field => [field.key, values[field.key] ?? '']))) : value : undefined;
    try { if (payload !== undefined) validateCredentialPayload(type, payload, true); }
    catch { setValidation(type === 'ai-provider' ? 'Check the API key and provider fields. Custom providers need an API format and HTTPS URL (HTTP is allowed for localhost). URLs cannot contain credentials or query parameters.' : 'Check the required fields, URL, header name, and port.'); return; }
    const label = replacement && structured ? values.provider || values.engine || credentialTypes[type] : provider;
    save({ id: item?.id, name, provider: label, type, value: payload });
    setValue(''); setValues(current => Object.fromEntries(Object.entries(current).map(([key, data]) => [key, credentialFields[type]?.some(field => field.key === key && field.secret) ? '' : data])));
  }}>
    <label htmlFor="credential-name">Name</label><input id="credential-name" className={control} maxLength={80} required value={name} disabled={busy} onChange={event => setName(event.target.value)} />
    {item && <label className="flex gap-2 text-sm"><input type="checkbox" checked={replacement} disabled={busy} onChange={event => setReplacement(event.target.checked)} />Replace credential details</label>}
    {item && replacement && structured && <p className="text-xs text-muted-foreground">Re-enter all connection details and secrets to replace this credential. Saved values are never loaded into the form.</p>}
    {replacement && structured ? visibleCredentialFields(type, values).map(field => <div key={field.key} className="grid gap-2">
      <label htmlFor={`credential-${field.key}`}>{field.label}</label>
      {field.options ? <Select id={`credential-${field.key}`} disabled={busy} value={values[field.key]} onValueChange={value => { setValidation(''); setValues(current => type === 'ai-provider' && field.key === 'provider' ? { ...current, provider: value, apiKey: '', baseUrl: '', organization: '', project: '', apiFormat: 'OpenAI-compatible' } : { ...current, [field.key]: value }); }} items={field.options.map(option => ({ value: option, label: option }))} />
        : <input id={`credential-${field.key}`} className={control} type={field.secret ? 'password' : 'text'} placeholder={field.placeholder} autoComplete={field.secret ? 'new-password' : 'off'} spellCheck={false} maxLength={4096} required={!field.optional} disabled={busy} value={values[field.key] ?? ''} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />}
    </div>) : !structured ? <>
      <label htmlFor="credential-provider">Provider</label><input id="credential-provider" className={control} required maxLength={80} value={provider} disabled={busy} onChange={event => setProvider(event.target.value)} />
      {replacement && <><label htmlFor="credential-value">Secret value</label><input id="credential-value" className={control} type="password" autoComplete="new-password" required value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></>}
    </> : null}
    {(validation || error) && <p role="alert" className="text-sm text-destructive">{validation || error}</p>}
    <DialogFooter><button type="button" className={control} disabled={busy} onClick={cancel}>Cancel</button><button type="submit" className={control} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save credential'}</button></DialogFooter>
  </form>;
}
