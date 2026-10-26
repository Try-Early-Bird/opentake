import { useEffect, useState } from 'react';
import { RefreshCw, ChevronRight, ArrowLeft, Sparkles, Globe, Database, KeyRound } from 'lucide-react';
import { credentialMenu, credentialTypes, type CredentialMetadata, type CredentialType, type CredentialResult } from '../../../shared/credentials';
import { CredentialForm } from './CredentialForm';
import { RowMenu, RowMenuItem } from '../components/ui/row-menu';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';
import { useShortcutLock } from '../shortcuts/Shortcuts';

const control = 'rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
export function Credentials() {
  const [items, setItems] = useState<CredentialMetadata[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CredentialMetadata | 'new' | null>(null);
  const [removing, setRemoving] = useState<CredentialMetadata | null>(null);
  const [type, setType] = useState<CredentialType | null>(null);
  useShortcutLock(busy);
  async function refresh() {
    setBusy(true); setError('');
    try {
      const status = await window.settings.securityStatus();
      setAvailable(status.secretStorageAvailable);
      if (status.secretStorageAvailable) {
        const result = await window.settings.listCredentials();
        if (!result.ok) throw new Error(result.message);
        setItems(result.items);
      }
    } catch { setError('Unable to load credentials. Unlock OS secret storage and retry.'); }
    finally { setLoaded(true); setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  function edit(item: CredentialMetadata | 'new') {
    setError(''); setEditing(item);
    setType(item === 'new' ? null : item.type);
  }
  function close() { setEditing(null); setRemoving(null); setType(null); }
  async function perform(operation: () => Promise<CredentialResult>) {
    setBusy(true); setError('');
    try {
      const result = await operation();
      if (!result.ok) { setError(result.message); return; }
      setItems(result.items); close();
    } catch { setError('Credential operation failed. Please retry.'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="credentials-heading" className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      <h2 id="credentials-heading" className="text-lg font-medium">Credentials</h2>
      <button type="button" aria-label="Refresh credentials" title="Refresh credentials" disabled={busy} onClick={() => void refresh()} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
        <RefreshCw size={16} aria-hidden="true" />
      </button>
    </div>
    <p className="text-sm text-muted-foreground">Credentials are stored encrypted on your computer, protected by your operating system’s secure storage.</p>
    {!loaded ? <p role="status">Checking secure storage…</p> : !available ? <p role="status">OS secret storage is unavailable. Unlock or configure your OS keychain, then retry. Saving credentials is disabled.</p> : null}
    {error && !editing && !removing && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><button type="button" className={control} disabled={!available || busy || !loaded} onClick={() => edit('new')}>Add credential</button></div>
    {loaded && available && !error && !items.length && <p className="text-sm text-muted-foreground">No credentials saved yet.</p>}
    <ul className="divide-y divide-border">{items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div className="min-w-0"><p className="break-words font-medium">{item.name}</p><p className="break-words text-xs text-muted-foreground">{item.provider} · {credentialTypes[item.type]} · Stored locally, not connected</p><p className="text-xs text-muted-foreground">Updated {new Date(item.updatedAt).toLocaleString()}</p></div>
      <div className="flex gap-2"><button type="button" className={control} disabled={busy || !available} onClick={() => edit(item)} aria-label={`Edit ${item.name}`}>Edit</button><button type="button" className={`${control} text-destructive`} disabled={busy || !available} onClick={() => { setError(''); setRemoving(item); }} aria-label={`Remove ${item.name}`}>Remove</button></div>
    </li>)}</ul>
    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogTitle>{type ? `${editing === 'new' ? 'Add' : 'Edit'} ${credentialTypes[type]}` : 'Add credential'}</DialogTitle>
        {!type ? <RowMenu aria-label="Credential types">{credentialMenu.map(id => {
          const Icon = { 'ai-provider': Sparkles, 'http-api': Globe, 'websocket-api': Globe, database: Database, 'key-value': KeyRound }[id];
          return <RowMenuItem key={id} disabled={id === 'database'} title={id === 'database' ? 'Database connections are not available yet' : undefined} onClick={() => setType(id)}><Icon size={18} aria-hidden="true" /><span className="flex-1">{credentialTypes[id]}</span>{id === 'database' ? <span className="text-xs text-muted-foreground">Unavailable</span> : <ChevronRight size={16} aria-hidden="true" />}</RowMenuItem>;
        })}</RowMenu> : <>
          {editing === 'new' && <button type="button" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => { setType(null); setError(''); }}><ArrowLeft size={14} aria-hidden="true" />Back</button>}
          <CredentialForm key={`${editing === 'new' ? 'new' : editing?.id}-${type}`} type={type} item={editing && editing !== 'new' ? editing : undefined} busy={busy} error={error} save={input => void perform(() => window.settings.saveCredential(input))} cancel={close} />
        </>}
      </DialogContent>
    </Dialog>
    <Dialog open={removing !== null} onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogTitle>Remove credential?</DialogTitle>
        <DialogDescription>Remove {removing?.name} from this app? This does not revoke it at the provider. You must revoke it there separately if it should no longer work.</DialogDescription>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><button type="button" className={control} disabled={busy} onClick={close}>Cancel</button><button type="button" className={`${control} bg-destructive text-destructive-foreground`} disabled={busy} onClick={() => { if (removing) void perform(() => window.settings.removeCredential(removing.id)); }}>{busy ? 'Removing…' : 'Remove credential'}</button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
