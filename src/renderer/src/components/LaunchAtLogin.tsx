import { useEffect, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import type { LoginItemState } from '../../../shared/settings';

export function LaunchAtLogin() {
  const [state, setState] = useState<LoginItemState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.settings.loginItem().then(value => { if (active) setState(value); })
      .catch(() => { if (active) setError('Unable to read launch-at-login settings.'); });
    return () => { active = false; };
  }, []);
  async function change(enabled: boolean) {
    if (busy) return;
    setBusy(true); setError('');
    try { setState(await window.settings.setLoginItem(enabled)); }
    catch { setError('Unable to update launch at login. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 border-t border-border pt-6">
    <div className="flex items-center justify-between gap-4">
      <label htmlFor="launch-at-login">Launch at login</label>
      <Switch.Root id="launch-at-login" checked={state?.enabled ?? false} disabled={!state?.supported || busy}
        onCheckedChange={enabled => void change(enabled)}
        className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input p-0.5 transition-colors data-checked:bg-primary disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring">
        <Switch.Thumb className="size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4" />
      </Switch.Root>
    </div>
    <p className="text-sm text-muted-foreground">Start background syncing when you sign in to your computer, without opening a window.</p>
    {state?.message && <p className="text-xs text-muted-foreground">{state.message}</p>}
    {!state && !error && <p role="status" className="text-xs text-muted-foreground">Checking startup settings…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
