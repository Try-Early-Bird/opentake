import { useState } from 'react';
import { useAppUpdates } from './useAppUpdates';

// The app-wide prompt to update, under the header. "Later" hides it until the next launch (or a
// newer version); the status-bar notice stays as a reminder. Signed builds download and install in
// place; other builds open the release page.
export function UpdateBanner() {
  const state = useAppUpdates();
  const [later, setLater] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!state?.version || !['available', 'downloading', 'ready', 'installing'].includes(state.status) || later === `${state.version}:${state.status}`) return null;
  const version = state.version;
  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true); setError('');
    try { await action(); } catch { setError(failure); } finally { setBusy(false); }
  }
  const primary = 'rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring';
  const secondary = 'rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring';
  const message = state.status === 'available' ? `Opentake ${version} is available.`
    : state.status === 'downloading' ? `Downloading Opentake ${version}… ${Math.round(state.percent ?? 0)}%`
    : state.status === 'ready' ? `Opentake ${version} is ready to install.`
    : 'Installing the update. Opentake will restart.';
  return <section aria-label="App update" className="border-y border-border bg-muted/60">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 text-sm">
      <p role="status" className="min-w-0 flex-1">{message}{state.status === 'ready' && <span className="text-muted-foreground"> Your data and settings stay as they are.</span>}</p>
      {state.status === 'available' && (state.native
        ? <button type="button" className={primary} disabled={busy} onClick={() => void run(() => window.settings.downloadUpdate(), 'Could not start the download. Try again from Settings.')}>Update now</button>
        : <button type="button" className={primary} disabled={busy} onClick={() => void run(() => window.settings.openUpdateDownload(), 'Could not open the download page. Try again from Settings.')}>Download</button>)}
      {state.status === 'ready' && <button type="button" className={primary} disabled={busy} onClick={() => void run(() => window.settings.installUpdate(), 'Could not install. Restart Opentake and try again.')}>Restart to update</button>}
      {(state.status === 'available' || state.status === 'ready') && <button type="button" className={secondary} onClick={() => { setLater(`${version}:${state.status}`); setError(''); }}>Later</button>}
      {error && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
    </div>
    {state.status === 'downloading' && <div aria-hidden="true" className="h-0.5 bg-border"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(100, Math.max(0, state.percent ?? 0))}%` }} /></div>}
  </section>;
}
