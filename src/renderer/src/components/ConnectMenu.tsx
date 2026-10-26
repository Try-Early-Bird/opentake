import { CoinbaseConnections } from './CoinbaseConnections';
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkAiConnections } from '../ai-connection-status';
import { ConnectionRow, connectionDisconnectClass } from './ConnectionRow';
import { AiConnectDialog } from './AiConnectDialog';
import { LoaderCircle, Plug } from 'lucide-react';
import { RobinhoodLogoTile } from '../logos';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { RowMenu, RowMenuItem } from './ui/row-menu';
import type { ConnectionResult, ConnectionSummary } from '../../../shared/connections';

export function ConnectMenu() {
  const [coinbaseConnected, setCoinbaseConnected] = useState(false);
  const onCoinbaseConnected = useCallback((connected: boolean) => { setCoinbaseConnected(connected); if (connected) { setConnectionRequired(false); setManaging(true); } }, []);
  const [managing, setManaging] = useState(false);
  const [tab, setTab] = useState<'platform' | 'ai'>('platform');
  const keepMenuOpen = useCallback(() => {}, []);
  const [open, setOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const closeAi = useCallback(() => setAiOpen(false), []);
  async function continueToAi() {
    setBusy(true); setMessage('');
    try {
      const result = await checkAiConnections(window.aiConnections);
      // Account selection already succeeded. A bridge failure belongs to the AI
      // step, where status can be retried without resubmitting the account.
      setOpen(false);
      setAiOpen(!result.ok || !result.states.some(state => state.status === 'connected'));
    } finally { setBusy(false); }
  }
  const [connectionRequired, setConnectionRequired] = useState(false);
  const [connection, setConnection] = useState<ConnectionSummary>();
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const backRequested = useRef(false);
  const [message, setMessage] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const eligibleAccounts = connection?.accounts.filter(account => account.agenticAllowed) ?? [];
  useEffect(() => {
    const accounts = connection?.accounts.filter(account => account.agenticAllowed) ?? [];
    setSelectedAccountId(current => accounts.some(account => account.id === current) ? current
      : accounts.find(account => account.selected)?.id ?? (accounts.length === 1 ? accounts[0].id : undefined));
  }, [connection]);
  useEffect(() => {
    let active = true;
    // An interrupted OAuth attempt leaves reauth_required, not disconnected.
    // Only a usable connection can bypass the startup prompt.
    void Promise.all([window.connections.status(), window.coinbase.list().catch(() => ({ ok: false as const, message: 'Coinbase unavailable' }))]).then(([result, cb]) => {
      if (!active || !result.ok) return;
      setConnection(result.connection);
      if (cb.ok && cb.connections.some(c => c.status === 'connected')) { setCoinbaseConnected(true); setConnectionRequired(false); return; }
      if (result.connection.status !== 'connected' || !result.connection.accounts.some(account => account.agenticAllowed && account.selected)) { setConnectionRequired(true); setOpen(true); }
      else void checkAiConnections(window.aiConnections).then(result => {
        if (active && (!result.ok || !result.states.some(state => state.status === 'connected'))) setAiOpen(true);
      });
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = () => window.connections.status().then(result => {
      if (!active) return;
      if (result.ok) { setConnection(result.connection); if (result.connection.status === 'connected') setConnectionRequired(false); }
      else setMessage(result.message);
    }).catch(() => { if (active) setMessage('Connection status unavailable.'); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [open]);
  async function run(operation: () => Promise<ConnectionResult>, signIn = false) {
    setBusy(true); setSigningIn(signIn); setMessage('');
    try {
      const result = await operation();
      if (result.ok) { setConnection(result.connection); if (result.connection.status === 'connected') setConnectionRequired(false); }
      else {
        if (!backRequested.current) setMessage(result.message);
        const current = await window.connections.status();
        if (current.ok) setConnection(current.connection);
      }
      return result.ok;
    } catch { setMessage('Connection request failed. Please retry.'); return false; }
    finally { setBusy(false); setSigningIn(false); setCancelling(false); backRequested.current = false; }
  }
  async function cancelSignIn() {
    if (cancelling) return;
    backRequested.current = true;
    setCancelling(true);
    try { await window.connections.cancel(); }
    catch { backRequested.current = false; setCancelling(false); setMessage('Unable to cancel sign-in. Please try again.'); }
  }
  function changeOpen(next: boolean) {
    if (!next && connectionRequired && connection?.status !== 'connected' && !coinbaseConnected) return;
    if (next) { setManaging(coinbaseConnected || (connection?.status === 'connected' && connection.accounts.some(account => account.agenticAllowed && account.selected))); setTab('platform'); setConnection(undefined); setSelectedAccountId(undefined); setMessage(''); }
    setOpen(next);
    if (!next && busy) void window.connections.cancel().catch(() => {});
  }
  return <>
    <button type="button" aria-label="Connect trading platform" title="Connect trading platform" onClick={() => changeOpen(true)} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <Plug size={18} aria-hidden="true" />
    </button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className={`data-[nested-dialog-open]:invisible ${managing ? "max-w-[570px] gap-6 rounded-[28px] p-6 sm:p-8 [.dark_&]:bg-[#111113] ring-black/5 [.dark_&]:ring-white/[0.03] shadow-[0_24px_64px_rgba(0,0,0,0.35)] [&>button:last-child]:top-8 [&>button:last-child]:right-8 [&>button:last-child]:text-muted-foreground" : "max-w-sm"}`} showCloseButton={!connectionRequired || coinbaseConnected || connection?.status === 'connected'}>
        <DialogTitle>{managing ? 'Connections' : 'Connect a trading platform'}</DialogTitle>
        {managing && <div role="tablist" aria-label="Connections" className="-ml-1 flex gap-1">
          {(['platform', 'ai'] as const).map(value => <button key={value} type="button" role="tab" id={`connection-tab-${value}`} aria-controls={`connection-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'platform' : event.key === 'End' ? 'ai' : value === 'ai' ? 'platform' : 'ai';
            setTab(next); document.getElementById(`connection-tab-${next}`)?.focus();
          }} disabled={busy} onClick={() => setTab(value)} className={`rounded-full px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${tab === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{value === 'ai' ? 'AI' : 'Platform'}</button>)}
        </div>}
        {managing && tab === 'ai' ? <div role="tabpanel" id="connection-panel-ai" aria-labelledby="connection-tab-ai"><AiConnectDialog open={open} embedded onClose={keepMenuOpen} /></div> : <div role={managing ? 'tabpanel' : undefined} id="connection-panel-platform" aria-labelledby={managing ? 'connection-tab-platform' : undefined} className="space-y-4">
        {managing && <p className="text-sm text-muted-foreground">Your connected platform accounts.</p>}
        {signingIn ? <div className="space-y-4">
          <button type="button" disabled={cancelling} onClick={() => void cancelSignIn()} className="rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">{cancelling ? 'Going back…' : '← Back'}</button>
          <div role="status" aria-label="Connecting to Robinhood" className="flex justify-center py-5 text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-6 animate-spin motion-reduce:animate-none" />
          </div>
          <button type="button" role="link" disabled={cancelling} onClick={() => {
            setMessage('');
            void window.connections.reopenSignIn().catch(() => setMessage('Sign-in link is unavailable. Go back and try again.'));
          }} className="rounded text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Reopen Robinhood sign-in ↗</button>
        </div> : connection?.status !== 'connected' && <RowMenu aria-label="Trading platforms">
          <RowMenuItem disabled={busy || !connection} onClick={() => { setManaging(false); void run(() => window.connections.connect(), true); }}>
            <RobinhoodLogoTile className="size-8 shrink-0 rounded-md" markClassName="size-5" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Robinhood</span>
              <span className="mt-1 block text-xs text-muted-foreground">Sign in to your Robinhood agentic account or create one to get started.</span>
            </span>
          </RowMenuItem>
        </RowMenu>}
        {!connection && <p className="text-sm text-muted-foreground">Loading connection…</p>}
        {managing && !signingIn && connection?.status === 'connected' ? <ul aria-label="Connected platforms" className="space-y-3">
          <ConnectionRow name="Robinhood" logo={<RobinhoodLogoTile className="size-8 shrink-0 rounded-md" markClassName="size-5" />} connected description={eligibleAccounts.filter(account => account.selected).map(account => <p key={account.id} className="truncate">MCP · {account.maskedNumber}</p>)}>
            <button type="button" disabled={busy} onClick={() => {
              void run(() => window.connections.disconnect()).then(removed => {
                if (removed) { setConnectionRequired(false); setSelectedAccountId(undefined); }
              });
            }} className={connectionDisconnectClass}>Disconnect</button>
          </ConnectionRow>
        </ul> : !signingIn && connection?.status === 'connected' && <>
          <p className="text-sm font-medium">Robinhood <span className="ml-2 text-xs text-green-600 dark:text-green-400">Connected</span></p>
          <div className="flex items-center gap-3">
            <RobinhoodLogoTile className="size-8 shrink-0 rounded-md" markClassName="size-5" />
            {eligibleAccounts.length > 0 ? <fieldset className="min-w-0 flex-1 space-y-1" disabled={busy}>
              <legend className="sr-only">Choose your trading account</legend>
              {eligibleAccounts.map(account => <label key={account.id} className="flex min-w-0 items-center gap-2 rounded-md py-1 text-sm">
                {eligibleAccounts.length > 1 && <input type="radio" name="robinhood-account" checked={selectedAccountId === account.id} onChange={() => { setSelectedAccountId(account.id); setMessage(''); }} />}
                <span className="truncate" title={`${account.nickname ?? 'Robinhood'} · ${account.maskedNumber}`}>{account.nickname ?? 'Robinhood'} · {account.maskedNumber}</span>
              </label>)}
            </fieldset> : <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">No agentic-enabled accounts are available. Enable an agentic account in Robinhood to continue.</p>}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => {
              void run(() => window.connections.disconnect()).then(removed => {
                if (removed) { setConnectionRequired(!managing); setSelectedAccountId(undefined); }
              });
            }} className="flex-1 rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Disconnect</button>
            {eligibleAccounts.length > 0 &&
            <button type="button" disabled={busy || !selectedAccountId} onClick={() => {
              if (!selectedAccountId) return;
              void run(() => window.connections.selectAccount(selectedAccountId)).then(saved => {
                if (saved) void continueToAi();
              });
            }} className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
              Continue
            </button>}
          </div>
        </>}
        {!signingIn && <CoinbaseConnections onConnected={onCoinbaseConnected} />}
        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
        </div>}
      </DialogContent>
    </Dialog>
    <AiConnectDialog open={aiOpen} onClose={closeAi} />
  </>;
}
