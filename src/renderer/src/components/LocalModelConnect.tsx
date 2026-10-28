import { useEffect, useState } from 'react';
import { actionsClass, fieldLabelClass, inputClass, mutedTextClass, primaryButtonClass } from './ui/modal-styles';

export function LocalModelConnect({ onBusy, onConnected }: { onBusy?(busy: boolean): void; onConnected(): void }) {
  const [url, setUrl] = useState('http://127.0.0.1:11434/v1');
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy, onBusy]);
  const [error, setError] = useState('');
  async function connect() {
    setBusy(true); setError('');
    try { const result = await window.aiConnections.connectLocal(url.trim()); if (result.ok) onConnected(); else setError(result.message ?? 'Could not connect. Please retry.'); }
    catch { setError('Could not connect to the local model server. Please retry.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4">
    <p className={mutedTextClass}>Connect a model running on this computer with Ollama, LM Studio or another OpenAI-compatible server. Your conversation and tool results are sent to that local server.</p>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void connect(); }}>
      <label className={fieldLabelClass}>Server URL<input required maxLength={300} disabled={busy} value={url} onChange={event => setUrl(event.target.value)} className={`${inputClass} font-mono`} /></label>
      <p className="text-xs text-muted-foreground">Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1. Only this computer’s addresses are allowed.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className={actionsClass}><button type="submit" disabled={busy || !url.trim()} className={primaryButtonClass}>{busy ? 'Checking…' : 'Check and connect'}</button></div>
    </form>
  </div>;
}
