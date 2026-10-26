import { useEffect, useState } from 'react';
import { actionsClass, backButtonClass, choiceClass, fieldLabelClass, inputClass, linkButtonClass, mutedTextClass, primaryButtonClass, secondaryButtonClass } from './ui/modal-styles';
import type { CredentialInput, CredentialMetadata } from '../../../shared/credentials';


// Saved API-key connections for OpenCode-run providers: OpenCode Zen (default) and OpenRouter.
type KeyProvider = 'OpenCode Zen' | 'OpenRouter';
const notices: Record<KeyProvider, string> = {
  'OpenCode Zen': 'Use your OpenCode Zen API key. Validation sends a tiny test request that may incur a small charge. Keys are saved in Credentials.',
  OpenRouter: 'Use your OpenRouter API key. Validation only reads the key’s limits and costs nothing. Usage is billed by OpenRouter. Keys are saved in Credentials.',
};
export function OpenCodeConnect({ onBack, onConnected, provider = 'OpenCode Zen' }: { onBack(): void; onConnected(): void; provider?: KeyProvider }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState<string>(provider);
  const [items, setItems] = useState<CredentialMetadata[]>([]);
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void window.settings.listCredentials().then(result => {
      if (!active) return;
      if (!result.ok) { setError(result.message); return; }
      const available = result.items.filter(item => item.type === 'ai-provider' && item.provider === provider);
      setItems(available); setSelected(available[0]?.id ?? '');
    }).catch(() => { if (active) setError('Could not load credentials. Please retry.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  async function connect(id: string) {
    setBusy(true); setError('');
    try { const result = await (provider === 'OpenRouter' ? window.aiConnections.useOpenRouterCredential(id) : window.aiConnections.useCredential(id)); if (result.ok) onConnected(); else setError(result.message ?? 'Validation failed. Please retry.'); }
    catch { setError('Could not connect this credential. Check OS secret storage and retry.'); }
    finally { setBusy(false); }
  }
  async function save(input: CredentialInput) {
    setBusy(true); setError('');
    try {
      const result = await window.settings.saveCredential(input);
      if (!result.ok) { setError(result.message); return; }
      const saved = result.items.find(item => item.name === input.name.trim() && item.type === 'ai-provider' && item.provider === provider);
      if (!saved) throw new Error('Missing saved credential');
      setItems(result.items.filter(item => item.type === 'ai-provider' && item.provider === provider));
      setSelected(saved.id); setAdding(false);
      await connect(saved.id);
    } catch { setError('Could not save the API key. Please retry.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4">
    <button type="button" disabled={busy} onClick={onBack} className={backButtonClass}>← Back</button>
    <p className={mutedTextClass}>{notices[provider]}</p>
    {adding ? <form className="space-y-4" onSubmit={event => {
      event.preventDefault();
      void save({ name, provider, type: 'ai-provider', value: JSON.stringify({ provider, baseUrl: '', apiKey: key.trim() }) }); setKey('');
    }}>
      <label className={fieldLabelClass}>Name<input required maxLength={80} disabled={busy} value={name} onChange={event => setName(event.target.value)} className={inputClass} /></label>
      <label className={fieldLabelClass}>{provider} API key<input required type="password" autoComplete="new-password" maxLength={4096} disabled={busy} value={key} onChange={event => setKey(event.target.value)} className={inputClass} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className={actionsClass}>
        <button type="button" disabled={busy} onClick={() => { setAdding(false); setKey(''); }} className={secondaryButtonClass}>Cancel</button>
        <button type="submit" disabled={busy || !key.trim() || !name.trim()} className={primaryButtonClass}>{busy ? 'Validating…' : 'Save and validate'}</button>
      </div>
    </form> : <>
      {loading ? <p role="status" className={mutedTextClass}>Loading credentials…</p> : items.length ? <fieldset disabled={busy} className="space-y-2">
        <legend className={`mb-2 ${fieldLabelClass}`}>Choose an {provider} credential</legend>
        {items.map(item => <label key={item.id} className={choiceClass}><input type="radio" name="ai-credential" checked={selected === item.id} onChange={() => setSelected(item.id)} />{item.name} · {item.provider}</label>)}
      </fieldset> : <p className={mutedTextClass}>No {provider} keys saved yet.</p>}
      {error && <><p role="alert" className="text-sm text-destructive">{error}</p><button type="button" disabled={busy || loading} onClick={() => setRetry(value => value + 1)} className={linkButtonClass}>Retry</button></>}
      <div className="flex items-center justify-between gap-3">
        <button type="button" disabled={busy || loading} className={linkButtonClass} onClick={() => { setAdding(true); setError(''); }}>Add API key</button>
        <button type="button" disabled={busy || loading || !selected} onClick={() => void connect(selected)} className={primaryButtonClass}>{busy ? 'Validating…' : 'Validate and connect'}</button>
      </div>
    </>}
  </div>;
}
