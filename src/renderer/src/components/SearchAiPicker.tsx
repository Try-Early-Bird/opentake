import { useEffect, useRef, useState } from 'react';
import type { AiConnectionState } from '../../../shared/ai-connections';
import type { ModelProvider, ModelResult, ReasoningEffort } from '../../../shared/ai-models';
import type { SearchSettings } from '../../../shared/search-settings';
import { checkAiConnections } from '../ai-connection-status';
import { AiPicker } from './chat/AiPicker';

export function SearchAiPicker({ preferences, onSaved, onSettings, onError }: {
  preferences: SearchSettings | null; onSaved: (value: SearchSettings) => void;
  onSettings: () => void; onError: (message: string) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [connections, setConnections] = useState<AiConnectionState[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<ModelProvider, ModelResult>>>({});
  const [refresh, setRefresh] = useState(0), [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
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
  async function select(provider: ModelProvider, model: string, effort?: ReasoningEffort) {
    if (saving) return;
    setSaving(true);
    try {
      const latest = await window.settings.search();
      onSaved(await window.settings.saveSearch({ ...latest, selection: { provider, model, ...(effort ? { effort } : {}) } }));
    } catch { onError('Could not save the search AI model. Try again.'); }
    finally { setSaving(false); }
  }
  return <div ref={anchor}><AiPicker iconOnly provider={preferences?.selection?.provider ?? 'claude'} model={preferences?.selection?.model ?? ''} effort={preferences?.selection?.effort}
    connections={connections} catalogs={catalogs} disabled={saving} anchor={anchor} onSelect={(provider, model, effort) => void select(provider, model, effort)}
    onRefresh={() => setRefresh(n => n + 1)} onConnect={onSettings} onSettings={onSettings} /></div>;
}
