import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

type Notice = { id: string; message: string; version: number };
type Notifications = { error(id: string, message: string, once?: boolean): void; recover(id: string): void };
const Context = createContext<Notifications | null>(null);

function Toast({ notice, dismiss }: { notice: Notice; dismiss(id: string): void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(notice.id), 8000);
    return () => clearTimeout(timer);
  }, [notice.id, notice.version, paused, dismiss]);
  return <div role="alert" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
    className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-background p-4 text-sm text-foreground shadow-lg">
    <p className="min-w-0 flex-1">{notice.message}</p>
    <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(notice.id)}
      className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X size={16} aria-hidden="true"/></button>
  </div>;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const failures = useRef(new Set<string>());
  const version = useRef(0);
  const dismiss = useCallback((id: string) => setNotices(items => items.some(item => item.id === id) ? items.filter(item => item.id !== id) : items), []);
  const error = useCallback((id: string, message: string, once = false) => {
    if (once && failures.current.has(id)) return;
    if (once) failures.current.add(id);
    const notice = { id, message, version: ++version.current };
    setNotices(items => [...items.filter(item => item.id !== id), notice].slice(-3));
  }, []);
  const recover = useCallback((id: string) => { failures.current.delete(id); dismiss(id); }, [dismiss]);
  const api = useMemo(() => ({ error, recover }), [error, recover]);
  return <Context.Provider value={api}>{children}
    <aside aria-label="Notifications" className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {notices.map(notice => <Toast key={notice.id} notice={notice} dismiss={dismiss}/>)}
    </aside>
  </Context.Provider>;
}
export function useToasts() {
  const value = useContext(Context);
  if (!value) throw new Error('ToastProvider is required');
  return value;
}
