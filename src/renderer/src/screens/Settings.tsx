import {Logs} from './Logs';
import { CryptoSettings } from './CryptoSettings';
import { SearchSettings } from './SearchSettings';
import { TradingSettings } from './TradingSettings';
import { AiSettings } from './AiSettings';
import { DataRetention } from './DataRetention';
import { McpSettings } from './McpSettings';
import { AboutYou } from '../components/AboutYou';
import { AiInstructions } from './AiInstructions';
import { useEffect, useState } from 'react';
import { Credentials } from './Credentials';
import { Connections } from './Connections';
import { LaunchAtLogin } from '../components/LaunchAtLogin';
import { AppUpdates } from '../components/AppUpdates';
import { Select } from '../components/ui/select';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ShortcutEditor, useShortcutLock } from '../shortcuts/Shortcuts';
import { APP_FONTS, getFont, setFont, type AppFont } from '../font';
import { getTheme, setTheme, type AppTheme } from '../theme';
import { cn } from '../lib/utils';
import type { MemoryStats } from '../../../shared/settings';
import type { SettingsAPI } from '../../../shared/settings';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';

const control = 'rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring';
function bytes(value: number | null): string {
  if (value === null) return 'Unavailable';
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function Memory(): React.JSX.Element {
  const [stats, setStats] = useState<MemoryStats>();
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState<{ token: string; name: string }>();
  const [confirmation, setConfirmation] = useState('');
  const [importing, setImporting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [security, setSecurity] = useState<Awaited<ReturnType<SettingsAPI['securityStatus']>>>();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [allowLegacy, setAllowLegacy] = useState(false);
  function closeImport() { setSelection(undefined); setImportPassword(''); setConfirmation(''); setAllowLegacy(false); }
  function closeExport() { setExportOpen(false); setExportPassword(''); setRepeatPassword(''); }
  useEffect(() => { let active = true; void window.settings.securityStatus().then(value => { if (active) setSecurity(value); }).catch(() => {}); return () => { active = false; }; }, []);
  useShortcutLock(importing || exporting || choosing);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await window.settings.memoryStats();
        if (!cancelled) { setStats(result); setError(''); }
      } catch { if (!cancelled) setError('Unable to read memory statistics. Retrying…'); }
      if (!cancelled) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  async function exportData() {
    setExporting(true);
    setMessage('');
    try {
      const password = exportPassword;
      setExportPassword(''); setRepeatPassword('');
      const result = await window.settings.exportDatabase(password);
      setMessage(result.status === 'saved' ? 'Database exported.' : result.status === 'cancelled' ? 'Export cancelled.' : result.message ?? 'Export failed.');
    } catch { setMessage('Export failed. Please try again.'); }
    finally { setExporting(false); closeExport(); }
  }
  async function chooseImport() {
    setChoosing(true);
    setMessage('');
    try {
      const result = await window.settings.chooseImport();
      if (result.status === 'selected') { setSelection(result); setConfirmation(''); setImportPassword(''); setAllowLegacy(false); }
      else if (result.status === 'error') setMessage(result.message ?? 'Unable to choose archive.');
    } catch { setMessage('Unable to choose archive.'); }
    finally { setChoosing(false); }
  }
  async function importData() {
    if (!selection || confirmation !== 'IMPORT' || importing) return;
    setImporting(true);
    try {
      const password = importPassword;
      setImportPassword('');
      const result = await window.settings.importDatabase(selection.token, password, allowLegacy);
      setMessage(result.message);
      closeImport();
      if (result.status === 'imported') {
        setStats(await window.settings.memoryStats());
        setError('');
      }
    } catch { setMessage('Import could not finish. Your previous database is retained.'); closeImport(); }
    finally { setImporting(false); }
  }
  return (
    <section aria-labelledby="memory-heading" className="space-y-6">
      <h2 id="memory-heading" className="text-lg font-medium">Memory</h2>
      <p className="text-sm text-muted-foreground">Refreshes every 5 seconds while this section is open.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!stats ? <p role="status">Loading statistics…</p> : (
        <dl className="divide-y divide-border text-sm">
          {[
            ['App working set', bytes(stats.appWorkingSetBytes)],
            ['Background host (includes PGlite)', bytes(stats.mainWorkingSetBytes)],
            ['App processes', String(stats.processCount)],
            ['PGlite PostgreSQL memory contexts', bytes(stats.postgresAllocatedBytes)],
            ['PGlite storage on disk', bytes(stats.storageBytes)],
          ].map(([label, value]) => <div key={label} className="flex justify-between gap-6 py-3"><dt>{label}</dt><dd className="font-mono tabular-nums">{value}</dd></div>)}
        </dl>
      )}
      <p className="text-xs text-muted-foreground">Working sets are summed across Electron processes and may count shared pages more than once. PGlite memory contexts exclude WASM and JavaScript overhead, so they are not total PGlite RAM. Storage is logical file size, including database metadata and WAL.</p>
      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="font-medium">Storage protection</h3>
        <p className="text-sm text-muted-foreground">The local database and recovery copies are not encrypted by Opentake. Protect them with FileVault, BitLocker, or Linux disk encryption. Opentake cannot verify whether disk encryption is enabled.</p>
        <p className="text-sm text-muted-foreground">{security ? security.filesystemProtection === 'owner-only' ? 'App and database directories use owner-only filesystem permissions.' : 'On Windows, access to app files depends on your user account’s folder permissions.' : 'Storage status unavailable.'}</p>
        <p className="text-sm text-muted-foreground">{security ? security.secretStorageAvailable ? 'Your operating system can encrypt saved credentials. Credentials are stored separately from the app database.' : 'Secure credential storage is unavailable. Opentake cannot save credentials without encryption.' : 'Checking secure credential storage…'}</p>
      </div>
      <div className="space-y-3 border-t border-border pt-6">
        <h3 className="font-medium">Database backup</h3>
        <p className="text-sm text-muted-foreground">Save a password-encrypted backup (.ebbackup). Includes database data, but not app preferences or credentials. Keep the passphrase separately: a forgotten passphrase cannot be recovered. After restoring on another device, reconnect accounts.</p>
        <p className="text-sm text-muted-foreground">Replace this app’s database with a trusted PGlite export. The previous database is retained locally for recovery. Maximum archive size: 64 MiB compressed / 256 MiB expanded.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setExportOpen(true)} disabled={exporting || importing || choosing} className={cn(control, 'hover:bg-muted disabled:opacity-50')}>{exporting ? 'Exporting…' : 'Export PGlite data'}</button>
          <button type="button" onClick={() => void chooseImport()} disabled={importing || exporting || choosing} className={cn(control, 'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50')}>{choosing ? 'Choosing…' : 'Import PGlite data'}</button>
        </div>
      </div>
      <p role="status" className="break-words text-sm text-muted-foreground">{message}</p>
      <Dialog open={exportOpen} onOpenChange={open => { if (!open && !exporting) closeExport(); }}>
        <DialogContent showCloseButton={!exporting}>
          <DialogTitle>Encrypt database backup</DialogTitle>
          <DialogDescription>Use a unique, strong passphrase (at least 12 characters). It is not saved by the app, and cannot be recovered. Credentials are excluded from this backup.</DialogDescription>
          <label htmlFor="export-password">Backup passphrase</label>
          <input id="export-password" type="password" autoComplete="new-password" maxLength={256} value={exportPassword} disabled={exporting} onChange={event => setExportPassword(event.target.value)} className={control} />
          <label htmlFor="export-repeat">Confirm backup passphrase</label>
          <input id="export-repeat" type="password" autoComplete="new-password" maxLength={256} value={repeatPassword} disabled={exporting} onChange={event => setRepeatPassword(event.target.value)} className={control} />
          <DialogFooter>
            <button type="button" disabled={exporting} onClick={closeExport} className={control}>Cancel</button>
            <button type="button" disabled={exporting || exportPassword.length < 12 || exportPassword !== repeatPassword} onClick={() => void exportData()} className={control}>{exporting ? 'Encrypting…' : 'Save encrypted backup'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(selection)} onOpenChange={open => { if (!open && !importing) closeImport(); }}>
        <DialogContent showCloseButton={!importing}>
          <DialogTitle>Replace the current database?</DialogTitle>
          <DialogDescription>
            Importing <strong className="break-all text-foreground">{selection?.name}</strong> replaces all current database data; it does not merge records. Only import a backup you trust and that was exported by a compatible version of PGlite. A separate recovery copy of the previous database stays on this device. Theme, font, and keychain settings are unchanged.
          </DialogDescription>
          <p className="text-sm text-muted-foreground">Keep Opentake open until the import finishes. Importing does not place trades.</p>
          <label htmlFor="import-password">Backup passphrase</label>
          <input id="import-password" type="password" autoComplete="off" maxLength={256} value={importPassword} disabled={importing || allowLegacy} onChange={event => setImportPassword(event.target.value)} className={control} />
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allowLegacy} disabled={importing} onChange={event => { setAllowLegacy(event.target.checked); setImportPassword(''); }} />I am importing a legacy unencrypted .tar.gz backup. I understand that file remains unencrypted and may contain sensitive data.</label>
          <label htmlFor="import-confirmation" className="text-sm">Type <strong>IMPORT</strong> to confirm replacement</label>
          <input id="import-confirmation" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={importing} className={control} />
          <DialogFooter>
            <button type="button" autoFocus disabled={importing} onClick={closeImport} className={cn(control, 'hover:bg-muted disabled:opacity-50')}>Cancel</button>
            <button type="button" disabled={confirmation !== 'IMPORT' || importing || (!allowLegacy && importPassword.length < 12)} onClick={() => void importData()} className={cn(control, 'bg-destructive text-destructive-foreground disabled:opacity-50')}>{importing ? 'Importing…' : 'Replace database'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function Settings(): React.JSX.Element {
  const { section = 'general' } = useSearch({ from: '/settings' });
  // The Trading section is hidden only when the host runs with trading switched off.
  const [tradingEnabled, setTradingEnabled] = useState(false);
  useEffect(() => { void (window.orders as typeof window.orders | undefined)?.status().then(state => setTradingEnabled(state.enabled)).catch(() => {}); }, []);
  const navigate = useNavigate();
  const [theme, updateTheme] = useState(getTheme);
  const [font, updateFont] = useState(getFont);
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <h1 className="text-2xl font-medium">Settings</h1>
      <div className="flex flex-col gap-8 sm:flex-row">
        <nav aria-label="Settings sections" className="flex gap-1 sm:w-40 sm:shrink-0 sm:flex-col">
          {([['general', 'General'], ['data-sources', 'Data sources'], ['ai', 'AI instructions'], ['ai-settings', 'AI settings'], ['search', 'Search'], ['mcp', 'MCP servers & tools'], ['connections', 'Connections'], ['crypto', 'Crypto'], ...(tradingEnabled ? [['trading', 'Trading'] as const] : []), ['memory', 'Memory'], ['logs', 'Logs'], ['data-retention', 'Data Retention'], ['credentials', 'Credentials'], ['shortcuts', 'Keyboard Shortcuts']] as const).map(([id, name]) => id === 'data-sources' ? <Link key={id} to="/data-sources" className="rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">{name}</Link> : <button key={id} type="button" aria-pressed={section === id} onClick={() => void navigate({ to: '/settings', search: { section: id }, replace: true })} className={cn('rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring', section === id ? 'bg-muted text-foreground' : 'text-muted-foreground')}>{name}</button>)}
        </nav>
        <div className="min-w-0 flex-1">
          {section === 'search' ? <SearchSettings /> : section === 'logs' ? <Logs /> : section === 'crypto' ? <CryptoSettings /> : section === 'trading' && tradingEnabled ? <TradingSettings /> : section === 'data-retention' ? <DataRetention /> : section === 'mcp' ? <McpSettings /> : section === 'ai' ? <AiInstructions /> : section === 'ai-settings' ? <AiSettings /> : section === 'connections' ? <Connections /> : section === 'memory' ? <Memory /> : section === 'credentials' ? <Credentials /> : section === 'shortcuts' ? <ShortcutEditor /> : (
            <section aria-labelledby="general-heading" className="space-y-6">
              <h2 id="general-heading" className="text-lg font-medium">General</h2>
              <AboutYou />
              <LaunchAtLogin />
              <AppUpdates />
              <div className="flex items-center justify-between gap-4"><label htmlFor="theme">Theme</label><Select className="w-48 shrink-0" id="theme" value={theme} onValueChange={next => { const value = next as AppTheme; updateTheme(value); setTheme(value); }} items={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></div>
              <div className="flex items-center justify-between gap-4"><label htmlFor="font">Font</label><Select className="w-48 shrink-0" id="font" value={font} onValueChange={next => { const value = next as AppFont; updateFont(value); setFont(value); }} items={APP_FONTS.map(item => ({ value: item.id, label: item.id === 'geist' ? 'System / Geist fallback' : item.label }))} /></div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
