import { useEffect, useState } from 'react';
import type { AppVersion } from '../../../shared/app-updates';
import { useAppUpdates } from './useAppUpdates';

export function AppUpdates(): React.JSX.Element {
  const [info, setInfo] = useState<AppVersion>();
  const [preview, setPreview] = useState<boolean>();
  const result = useAppUpdates();
  const checking = result?.status === 'checking';
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.settings.appVersion().then(value => {
      if (active) setInfo(value);
    }).catch(() => { if (active) setError('Unable to read the app version. Restart the app and try again.'); });
    return () => { active = false; };
  }, []);
  async function check() {
    setError('');
    try { await window.settings.checkForUpdates(preview ?? result?.preview ?? false); setPreview(undefined); }
    catch { setError('Unable to check for updates. Please try again.'); }
  }
  async function download() {
    setError('');
    try { await window.settings.downloadUpdate(); } catch { setError('Unable to download this update. Check for updates and try again.'); }
  }
  async function install() {
    setOpening(true); setError('');
    try { await window.settings.installUpdate(); } catch { setError('Unable to install. Restart the app and try again.'); }
    finally { setOpening(false); }
  }
  const locked = checking || result?.status === 'downloading' || result?.status === 'ready' || result?.status === 'installing';
  async function openDownload() {
    setOpening(true); setError('');
    try { await window.settings.openUpdateDownload(); }
    catch { setError('Could not open the download page. Check for updates and try again.'); }
    finally { setOpening(false); }
  }
  const button = 'rounded-md border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';
  return <section aria-labelledby="app-updates-heading" className="space-y-3 border-t border-border pt-6">
    <h3 id="app-updates-heading" className="font-medium">Version & updates</h3>
    {info && <p className="text-sm">Opentake {info.version} · {info.packaged ? 'Installed app' : 'Development build'}<span className="block text-xs text-muted-foreground">Build {info.build} · {info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : info.platform} {info.arch}</span></p>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preview ?? result?.preview ?? false} disabled={locked || opening || !info} onChange={event => { setPreview(event.target.checked); setError(''); }} />Include preview releases</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={locked || opening || !info} onClick={() => void check()}>{checking ? 'Checking…' : 'Check for updates'}</button>
      {result?.status === 'available' && (preview === undefined || preview === result.preview) && <button type="button" className={button} disabled={opening} onClick={() => void (result.native ? download() : openDownload())}>{opening ? 'Opening…' : `Download ${result.version}`}</button>}
      {result?.status === 'ready' && <button type="button" className={button} disabled={opening} onClick={() => void install()}>Restart and install</button>}
    </div>
    <p role="status" className="text-sm text-muted-foreground">{checking ? 'Checking GitHub releases…'
      : result?.status === 'available' ? `Version ${result.version} is available.${result.native ? ' Download now and restart when ready.' : ' Open the release page and choose the installer for your system and architecture.'}`
      : result?.status === 'downloading' ? `Downloading update… ${Math.round(result.percent ?? 0)}%`
      : result?.status === 'ready' ? 'Update downloaded. You can keep working and install later.'
      : result?.status === 'installing' ? 'Stopping the background host and installing…'
      : result?.status === 'current' ? 'No newer release is available for this system and channel.'
      : result?.status === 'unpublished' ? 'No installers have been published for this system and channel yet.' : ''}</p>
    {(error || result?.message) && <p role="alert" className="text-sm text-destructive">{error || result?.message}</p>}
    <p className="text-xs text-muted-foreground">{info?.packaged ? 'Checks for updates shortly after launch and every six hours while the desktop is open. ' : 'Development builds check only when requested. '}{result?.native ? 'Downloads and installation start only when you choose. Your data and preferences stay on this device.' : 'Downloads open on GitHub; installation is manual. Use “Quit completely” before replacing the installed app.'}</p>
    {info && !info.packaged && <p className="text-xs text-muted-foreground">For this source checkout, stop the app and background host, save your local changes, then pull your branch, run npm ci, and rebuild or restart development.</p>}
  </section>;
}
