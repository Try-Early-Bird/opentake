import { CoinbaseMark } from '../logos';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, MoreHorizontal, Pencil, Plus, RefreshCw, Unplug } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import type { CoinbaseConnectionResult, PlatformAccountConnection } from '../../../shared/platform-connections';
import { CoinbaseSetup } from './CoinbaseSetup';


export function CoinbaseConnections({ onConnected }: { onConnected?: (connected: boolean) => void }) {
  const [items, setItems] = useState<PlatformAccountConnection[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ id?: string }>();
  const [label, setLabel] = useState('');
  const [rename, setRename] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const mounted = useRef(true);
  const working = useRef(false);
  const callback = useRef(onConnected); callback.current = onConnected;
  const apply = useCallback((connections: PlatformAccountConnection[]) => {
    setItems(connections); callback.current?.(connections.some(c => c.status === 'connected'));
  }, []);
  useEffect(() => {
    mounted.current = true;
    const refresh = async () => {
      if (working.current) return;
      try { const result = await window.coinbase.list(); if (mounted.current) { if (result.ok) apply(result.connections); else setError(result.message); } }
      catch { if (mounted.current) setError('Coinbase connection status unavailable.'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { mounted.current = false; clearInterval(timer); if (working.current) void window.coinbase.cancel().catch(() => {}); };
  }, [apply]);
  async function run(action: () => Promise<CoinbaseConnectionResult>, finished?: (connections: PlatformAccountConnection[]) => void) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      const result = await action();
      if (!mounted.current) return;
      if (result.ok) { if (!result.cancelled) { apply(result.connections); finished?.(result.connections); } }
      else setError(result.message);
    } catch { if (mounted.current) setError('Coinbase connection request failed. Try again.'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  function start(item?: PlatformAccountConnection) {
    setSetup({ id: item?.connectionId }); setError(''); setConfirm(undefined); setRename(undefined);
  }
  const feedback = <>
    {busy && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Checking Coinbase connection…<button type="button" onClick={() => { void window.coinbase.cancel().catch(() => setError('Could not cancel. Try again.')); }} className="ml-auto underline">Cancel</button></div>}
    {error && !items?.some(item => item.issue === error) && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </>;
  // A key that was rejected or can no longer be read is fixed the same way: connect it again.
  const needsReconnect = (item: PlatformAccountConnection) => item.status === 'reauth_required' || item.status === 'storage_locked';
  const status = (item: PlatformAccountConnection) => ({ connected: 'Connected', disconnected: 'Disconnected', reauth_required: 'Reconnect needed', storage_locked: 'Reconnect needed' })[item.status];
  const menuItemClass = 'flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-xs outline-none data-[highlighted]:bg-muted disabled:opacity-50';
  const verified = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const today = date.toDateString() === new Date().toDateString();
    return `Verified ${today ? 'today' : date.toLocaleDateString()}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };
  return <section aria-label="Coinbase connections" className="rounded-2xl border border-border/60 bg-card px-4 py-3">
    <div className="flex items-center gap-3">
      <CoinbaseMark className="size-8 shrink-0" />
      <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">Coinbase</h3><p className="text-xs text-muted-foreground">Connect a portfolio with an API key</p></div>
      <button type="button" disabled={busy} onClick={() => start()} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-3 py-2 text-xs font-medium hover:bg-muted/80 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">{items?.length ? <><Plus size={12} aria-hidden="true"/>Add account</> : 'Connect'}</button>
    </div>
    {items === undefined && !error && <p role="status" className="mt-3 text-xs text-muted-foreground">Loading Coinbase connections…</p>}
    {items?.map(item => <div key={item.connectionId} className="mt-3 border-t border-border/60 pt-3 text-sm">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="break-words text-sm row-title">{item.label}</span><span role="status" className={`inline-flex items-center gap-1 text-xs ${item.status === 'connected' ? 'text-success' : needsReconnect(item) ? 'text-destructive' : 'text-muted-foreground'}`}><span aria-hidden="true" className="size-1 rounded-full bg-current"/>{status(item)}</span></div>
          <p className="mt-0.5 text-xs text-muted-foreground">{item.maskedReference} · {item.permissions.trade ? 'View + Trade' : 'Read-only'}{item.checkedAt && verified(item.checkedAt) ? ` · ${verified(item.checkedAt)}` : ''}</p>
        </div>
        {needsReconnect(item) ? <button type="button" disabled={busy} onClick={() => start(item)} className="shrink-0 rounded-full bg-muted px-3 py-1.5 text-xs font-medium hover:bg-muted/80 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Reconnect</button>
          : <button type="button" aria-label={`Verify ${item.label} connection`} title="Verify connection" disabled={busy || item.status === 'disconnected'} onClick={() => void run(() => window.coinbase.refresh(item.connectionId))} className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><RefreshCw size={13} aria-hidden="true"/></button>}
        <Menu.Root>
          <Menu.Trigger aria-label={`Manage ${item.label}`} disabled={busy} className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><MoreHorizontal size={16} aria-hidden="true"/></Menu.Trigger>
          <Menu.Portal><Menu.Positioner align="end" sideOffset={6} collisionPadding={12} className="z-[100]"><Menu.Popup className="min-w-40 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            <Menu.Item disabled={busy} onClick={() => start(item)} className={menuItemClass}><KeyRound size={13} className="text-muted-foreground" aria-hidden="true"/>{item.status === 'connected' ? 'Replace key' : 'Reconnect'}</Menu.Item>
            <Menu.Item disabled={busy} onClick={() => { setRename(item.connectionId); setLabel(item.label); setConfirm(undefined); setSetup(undefined); }} className={menuItemClass}><Pencil size={13} className="text-muted-foreground" aria-hidden="true"/>Rename</Menu.Item>
            <Menu.Separator className="my-1 h-px bg-border"/>
            <Menu.Item disabled={busy || item.status === 'disconnected'} onClick={() => { setConfirm(item.connectionId); setRename(undefined); }} className={`${menuItemClass} text-destructive`}><Unplug size={13} aria-hidden="true"/>Disconnect</Menu.Item>
          </Menu.Popup></Menu.Positioner></Menu.Portal>
        </Menu.Root>
      </div>
      {item.issue && <p role="alert" className="mt-2 text-xs text-destructive">{item.issue}</p>}
      {rename === item.connectionId ? <form className="mt-2 flex gap-2" onSubmit={event => { event.preventDefault(); void run(() => window.coinbase.rename(item.connectionId, label), () => setRename(undefined)); }}>
        <input aria-label="Connection label" maxLength={80} value={label} onChange={event => setLabel(event.target.value)} disabled={busy} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1" />
        <button disabled={busy || !label.trim()} className="rounded px-2 py-1 hover:bg-muted">Save</button>
        <button type="button" disabled={busy} onClick={() => setRename(undefined)}>Cancel</button>
      </form> : null}
      {confirm === item.connectionId && <div className="mt-2 space-y-2 rounded bg-muted p-3">
        <p>Disconnect {item.label}? History stays here. Revoke the API key in Coinbase separately.</p>
        <div className="flex gap-3"><button type="button" disabled={busy} onClick={() => void run(() => window.coinbase.disconnect(item.connectionId), () => setConfirm(undefined))} className="text-destructive">Disconnect account</button><button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>Keep connected</button></div>
      </div>}
    </div>)}
    {setup && <CoinbaseSetup existing={items?.find(item => item.connectionId === setup.id)} connections={items ?? []} onConnected={apply} onClose={() => setSetup(undefined)} />}
    {!setup && (busy || error) && <div className="mt-3">{feedback}</div>}
  </section>;
}
