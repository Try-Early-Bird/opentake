import { SearchMaintenance } from '../components/SearchMaintenance';
import { Select } from '../components/ui/select';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { AiConnectionState } from '../../../shared/ai-connections';
import type { ModelProvider, ModelResult } from '../../../shared/ai-models';
import { defaultSearchSettings, type SearchSettings as Preferences } from '../../../shared/search-settings';
import { AiPicker, providerLabels } from '../components/chat/AiPicker';
import { checkAiConnections } from '../ai-connection-status';

export function SearchSettings() {
  const navigate = useNavigate();
  const anchor = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<Preferences>(defaultSearchSettings);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [connections, setConnections] = useState<AiConnectionState[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<ModelProvider, ModelResult>>>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    void window.settings.search().then(settings => { if (live) { setValue(settings); setReady(true); } })
      .catch(() => { if (live) setError('Could not load search settings. Reopen Settings to retry.'); });
    const check = () => void checkAiConnections(window.aiConnections).then(result => { if (live) setConnections(result.ok ? result.states : []); });
    check(); const timer = setInterval(check, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const connected = connections.filter(c => c.status === 'connected').map(c => c.provider).sort().join(',');
  useEffect(() => {
    let live = true; setCatalogs({});
    for (const provider of connected.split(',').filter(Boolean) as ModelProvider[]) {
      void window.chat.models(provider, refresh > 0).catch((): ModelResult => ({ ok: false, message: 'Could not load models. Refresh to retry.' }))
        .then(result => { if (live) setCatalogs(old => ({ ...old, [provider]: result })); });
    }
    return () => { live = false; };
  }, [connected, refresh]);
  function update(next: Preferences) { setValue(next); setSaved(false); }
  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try { setValue(await window.settings.saveSearch(value)); setSaved(true); }
    catch { setError('Could not save search settings. Try again.'); }
    finally { setBusy(false); }
  }
  const selection = value.selection;
  const catalog = selection ? catalogs[selection.provider] : undefined;
  const unavailable = selection && (!connections.some(c => c.provider === selection.provider && c.status === 'connected')
    || (catalog && (!catalog.ok || !catalog.models.some(m => m.value === selection.model && !m.disabled))));
  return <section aria-labelledby="search-settings-heading" className="space-y-4">
    <div><h2 id="search-settings-heading" className="text-lg font-medium">Search</h2>
      <p className="mt-1 text-sm text-muted-foreground">Choose the AI model for search. Your Take conversations and settings stay separate.</p></div>
    <p className="text-sm text-muted-foreground">Use Ask Agent to find markets and screen Robinhood for matches. You can also search for markets and Takes without AI.</p>
    <div ref={anchor} className="space-y-2">
      <p className="text-sm font-medium">Search AI</p>
      <p className="text-sm" data-testid="search-ai-selection">{selection ? `${providerLabels[selection.provider]} · ${selection.model}` : 'No search AI selected'}</p>
      <div className="flex items-center gap-3"><AiPicker provider={selection?.provider ?? 'claude'} model={selection?.model ?? ''} effort={selection?.effort} connections={connections} catalogs={catalogs} disabled={!ready || busy} anchor={anchor}
        onSelect={(provider, model, effort) => update({ ...value, selection: { provider, model, ...(effort ? { effort } : {}) } })} onRefresh={() => setRefresh(n => n + 1)}
        onConnect={() => void navigate({ to: '/settings', search: { section: 'connections' } })} />
        {selection && <button type="button" disabled={!ready || busy} onClick={() => update({ ...value, selection: null })} className="text-xs underline">Clear search AI</button>}</div>
      {unavailable && <p role="status" className="text-xs text-muted-foreground">This model is unavailable. Reconnect your AI account or choose another model.</p>}
    </div>
    <fieldset disabled={!ready || busy} className="space-y-3">
      <legend className="mb-2 text-sm font-medium">Search agent permissions</legend>
      {([
        ['marketData', 'Read market data', 'Allow the agent to look up markets, quotes, and screening filters.'],
        ['managedScreeners', 'Manage search screeners', 'Let the agent create and manage its own Robinhood screeners. Screeners you created yourself stay unchanged.'],
      ] as const).map(([key, label, description]) => <label key={key} className="flex items-start justify-between gap-4 text-sm">
        <span><span className="font-medium">{label}</span><span className="mt-1 block text-xs text-muted-foreground">{description}</span></span>
        <Select id={`search-permission-${key}`} ariaLabel={label} value={value.permissions[key]} disabled={!ready || busy}
          onValueChange={permission => update({ ...value, permissions: { ...value.permissions, [key]: permission as Preferences['permissions'][typeof key] } })}
          className="w-28 shrink-0" items={[{ value: 'ask', label: 'Ask' }, { value: 'allowed', label: 'Allow' }, { value: 'blocked', label: 'Block' }]} />
      </label>)}
    </fieldset>
    <p className="text-xs text-muted-foreground">These settings apply to your next AI search. Your other tool restrictions and data-sharing approvals still apply. Search cannot place trades.</p>
    <button type="button" disabled={!ready || busy} onClick={() => void save()} className="rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save search settings'}</button>
    {saved && <p role="status" className="text-sm">Search settings saved.</p>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    <SearchMaintenance />
  </section>;
}
