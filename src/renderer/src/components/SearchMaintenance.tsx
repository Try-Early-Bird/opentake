import { useState } from 'react';
import type { SearchBackupPreview, SearchRecoveryPreview } from '../../../shared/search-agent';

export function SearchMaintenance() {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [backup, setBackup] = useState<SearchBackupPreview | null>(null);
  const [recovery, setRecovery] = useState<SearchRecoveryPreview | null>(null);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : 'Search action failed. Try again.'); }
    finally { setBusy(false); }
  }
  const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50';
  return <div className="space-y-5 border-t border-border pt-4">
    <section aria-labelledby="saved-screen-backup-heading" className="space-y-2">
      <h3 id="saved-screen-backup-heading" className="text-sm font-medium">Saved-screen backups</h3>
      <p className="text-xs text-muted-foreground">Export saved filters in a file up to 4 MB. Importing adds screens without replacing existing ones and keeps their original account selection. Credentials and links to Robinhood screeners are not included.</p>
      <div className="flex gap-2">
        <button className={button} disabled={busy} onClick={() => void act(async () => { const result = await window.searchAgent.exportBackup(); if (result.status === 'saved') setMessage('Saved screens exported.'); })}>Export saved screens</button>
        <button className={button} disabled={busy} onClick={() => void act(async () => { setBackup(null); const result = await window.searchAgent.previewBackup(); if (result.status === 'preview') setBackup(result.preview); })}>Import saved screens</button>
      </div>
      {backup && <div className="space-y-2 rounded-md border border-border p-3" aria-label="Saved-screen import preview">
        <p className="text-sm">{backup.screens.length} screens to add · {backup.skipped} duplicates skipped</p>
        <ul className="max-h-48 space-y-2 overflow-auto text-xs">{backup.screens.map(screen => <li key={screen.id}><p className="font-medium">{screen.title} · {screen.venues.join(', ')}</p><p className="text-muted-foreground">{screen.conditions.join(' · ')}</p></li>)}</ul>
        <p className="text-xs text-muted-foreground">Imported screens need the account they were saved with. On another installation, you may need to recreate them. Importing does not run a search or use AI.</p>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void act(async () => { const result = await window.searchAgent.importBackup(backup.token); setBackup(null); setMessage(`${result.imported} saved screens imported; ${result.skipped} duplicates skipped.`); })}>Confirm import</button>
          <button className={button} disabled={busy} onClick={() => setBackup(null)}>Cancel import</button></div>
      </div>}
    </section>
    <section aria-labelledby="screener-recovery-heading" className="space-y-2">
      <h3 id="screener-recovery-heading" className="text-sm font-medium">Interrupted screener recovery</h3>
      <p className="text-xs text-muted-foreground">If Opentake did not receive confirmation that a screener was created, check Robinhood for it. Reconnecting links it to this app without changing the screener on Robinhood.</p>
      <button className={button} disabled={busy} onClick={() => void act(async () => { setRecovery(null); setRecovery(await window.searchAgent.previewRecovery()); })}>Check Robinhood for interrupted screener</button>
      {recovery?.status === 'none' && <p role="status" className="text-xs">No interrupted creation needs recovery for the selected account.</p>}
      {recovery?.status === 'missing' && <p role="status" className="text-xs">No matching screener found. Check the selected Robinhood account and retry once the earlier request has settled. Automatic creation remains blocked.</p>}
      {recovery?.status === 'ambiguous' && <p role="status" className="text-xs">Opentake could not confirm which screener it can update. Check Robinhood before trying again. No screeners were changed.</p>}
      {recovery?.status === 'ready' && <div className="space-y-2 rounded-md border border-border p-3">
        <p className="break-all text-xs">{recovery.title}<br />Screener ID: {recovery.id}</p>
        <p className="text-xs text-muted-foreground">Future AI searches will update this screener’s filters and sorting. Confirm only if this is the screener Opentake was creating when the connection was interrupted.</p>
        <button className={button} disabled={busy} onClick={() => void act(async () => { await window.searchAgent.confirmRecovery(recovery.token); setRecovery(null); setMessage('Search screener reconnected. You can rerun your search.'); })}>Reconnect search screener</button>
        <button className={`${button} ml-2`} disabled={busy} onClick={() => setRecovery(null)}>Cancel recovery</button>
      </div>}
    </section>
    {busy && <p role="status" className="text-xs">Working…</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
  </div>;
}
