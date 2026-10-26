import { setSearchOpen } from '../search-state';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { bindingError, commands, defaults, displayBinding, loadBindings, recordedBinding, type Bindings, type CommandId } from './registry';

const mac = /Mac/.test(navigator.platform);
const storageKey = `earlybird-shortcuts-v1-${mac ? 'mac' : 'pc'}`;
type Context = {
  bindings: Bindings; recording: CommandId | null; error: string;
  setRecording: (id: CommandId | null) => void; reset: () => void;
  summary: boolean; setSummary: (open: boolean) => void; lock: (token: symbol, enabled: boolean) => void;
};
const ShortcutContext = createContext<Context | null>(null);
export function useShortcuts(): Context {
  const value = useContext(ShortcutContext);
  if (!value) throw new Error('ShortcutProvider is missing');
  return value;
}
export function useShortcutLock(enabled: boolean): void {
  const { lock } = useShortcuts();
  const [token] = useState(() => Symbol());
  useEffect(() => { lock(token, enabled); return () => lock(token, false); }, [enabled, lock, token]);
}
function CommandBinding({ id, binding, enabled, run }: { id: CommandId; binding: string; enabled: boolean; run: (id: CommandId) => void }) {
  useHotkeys(binding, event => {
    if (event.repeat || event.isComposing) return;
    // Observe overlays before Base UI handles Escape, preventing a second dismissal.
    const hasOpenOverlay = [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"], [data-slot="popover-content"], [role="menu"], [role="listbox"]')].some(element =>
      !element.closest('[hidden], [data-closed]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
    );
    if (hasOpenOverlay) {
      if (id !== 'dismiss') event.preventDefault();
      return;
    }
    if (id === 'dismiss' && (event.target as HTMLElement)?.closest('select')) return;
    event.preventDefault();
    run(id);
  }, { enabled, useKey: true, enableOnFormTags: id === 'dismiss', enableOnContentEditable: false, eventListenerOptions: { capture: true } }, [id, run]);
  return null;
}
export function ShortcutProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const [bindings, setBindings] = useState(() => {
    try { return loadBindings(localStorage.getItem(storageKey), mac); } catch { return defaults(mac); }
  });
  const [summary, setSummary] = useState(false);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [error, setError] = useState('');
  const [locks, setLocks] = useState<Set<symbol>>(() => new Set());
  const [lock] = useState(() => (token: symbol, enabled: boolean) => setLocks(current => {
    if (current.has(token) === enabled) return current;
    const next = new Set(current); enabled ? next.add(token) : next.delete(token); return next;
  }));
  function save(next: Bindings) {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setBindings(next); setError(''); }
    catch { setError('Unable to save shortcuts on this device.'); }
  }
  useEffect(() => {
    if (!recording) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape') { setRecording(null); return; }
      const key = recordedBinding(event);
      if (!key) return;
      const problem = bindingError(recording, key, bindings);
      if (problem) { setError(problem); return; }
      save({ ...bindings, [recording]: key }); setRecording(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [recording, bindings]);
  function run(id: CommandId) {
    if (locks.size || recording) return;
    if (id === 'dismiss' && pathname === '/settings') void navigate({ to: '/' });
    if (id === 'back' && router.history.canGoBack()) router.history.back();
    if (id === 'settings') void navigate({ to: pathname === '/settings' ? '/' : '/settings' });
    if (id === 'search') setSearchOpen(true);
    if (id === 'summary') setSummary(true);
  }
  return <ShortcutContext.Provider value={{ bindings, recording, error, setRecording: id => { setError(''); setRecording(id); }, reset: () => { setRecording(null); save(defaults(mac)); }, summary, setSummary: open => { setRecording(null); setSummary(open); }, lock }}>
    {commands.map(command => <CommandBinding key={command.id} id={command.id} binding={bindings[command.id]} enabled={!recording && locks.size === 0} run={run} />)}
    {children}
  </ShortcutContext.Provider>;
}
export function ShortcutEditor() {
  const { bindings, recording, setRecording, reset, error } = useShortcuts();
  useEffect(() => () => setRecording(null), []);
  return <section aria-labelledby="shortcuts-heading" className="space-y-5">
    <h2 id="shortcuts-heading" className="text-lg font-medium">Keyboard Shortcuts</h2>
    <p className="text-sm text-muted-foreground">Click a shortcut to change it, then press a key combination. Escape cancels recording. Bindings are saved on this device. Escape remains reserved for closing overlays.</p>
    <div className="divide-y divide-border">{commands.map(command => <div key={command.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div><p className="text-sm">{command.label}</p><p className="text-xs text-muted-foreground">{command.scope}</p></div>
      <div className="flex items-center gap-3">{command.editable ? <button type="button" aria-label={`Change ${command.label}`} aria-pressed={recording === command.id} title="Click to change shortcut" onClick={() => setRecording(recording === command.id ? null : command.id)} className="min-h-8 rounded-md border border-input bg-muted px-3 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><kbd>{recording === command.id ? 'Press shortcut…' : displayBinding(bindings[command.id])}</kbd></button> : <><kbd className="rounded border border-border bg-muted px-2 py-1 text-xs">{displayBinding(bindings[command.id])}</kbd><span className="text-xs text-muted-foreground">Reserved</span></>}</div>
    </div>)}</div>
    {recording && <p role="status" className="text-sm">Listening for a shortcut. Press Escape to cancel.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <button type="button" onClick={reset} className="rounded-md border border-input px-3 py-2 text-sm hover:bg-muted">Reset shortcuts</button>
  </section>;
}
