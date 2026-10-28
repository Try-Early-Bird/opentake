import { ConnectionRow, connectionActionClass, connectionDisconnectClass } from './ConnectionRow';
import { actionsClass, fieldLabelClass, inputClass, linkButtonClass, primaryButtonClass } from './ui/modal-styles';
import { GrokMark, OpenaiMark, ClaudeMark, OpencodeMark, OpenrouterMark, LocalModelMark } from './ai-provider-marks';
import { OpenCodeConnect } from './OpenCodeConnect';
import { LocalModelConnect } from './LocalModelConnect';
import { checkAiConnections } from '../ai-connection-status';
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Dialog, DialogBackTitle, DialogContent } from './ui/dialog';
import { RowMenu, RowMenuItem } from './ui/row-menu';
import type { AiConnectionState, AiProvider } from '../../../shared/ai-connections';

/** Embedded in another dialog, Back lives in that dialog's header: this reports whether it applies and sets what it does. */
export interface StepBack { handler: MutableRefObject<(() => void) | undefined>; change(state: { available: boolean; disabled: boolean }): void }
// `start` opens the dialog on one provider's setup step, for example from the model picker.
export function AiConnectDialog({ open, onClose, embedded = false, start, stepBack: hostBack }: { open: boolean; onClose(): void; embedded?: boolean; start?: AiConnectionState['provider']; stepBack?: StepBack }) {
  const [connections, setConnections] = useState<AiConnectionState[]>([]);
  const [opencode, setOpencode] = useState(false);
  const [local, setLocal] = useState(false);
  const [openrouter, setOpenrouter] = useState(false);
  const [provider, setProvider] = useState<AiProvider>();
  const activeProvider = useRef<AiProvider>();
  activeProvider.current = provider;
  useEffect(() => {
    if (!embedded || !open) return;
    return () => { if (activeProvider.current) void window.aiConnections.cancel().catch(() => {}); };
  }, [embedded, open]);
  const [state, setState] = useState<AiConnectionState>();
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  // A key or local-model step reports its own save, so the header Back waits for it too.
  const [stepBusy, setStepBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [serviceError, setServiceError] = useState('');
  const [checking, setChecking] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) { setOpencode(false); setLocal(false); setOpenrouter(false); setProvider(undefined); setState(undefined); setCode(''); setSubmitted(false); setMessage(''); setServiceError(''); setChecking(true); return; }
    let active = true;
    let inFlight = false;
    setChecking(true);
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await checkAiConnections(window.aiConnections);
        if (!active) return;
        if (!result.ok) { setServiceError(result.message); return; }
        setServiceError('');
        const states = result.states;
        setConnections(states);
        if (provider) {
          const next = states.find(item => item.provider === provider);
          setState(next);
          if (next?.status === 'connected') { setCode(''); if (embedded) setProvider(undefined); else onClose(); }
        } else if (!embedded && states.some(item => item.status === 'connected' && (!start || item.provider === start))) onClose();
      } finally { inFlight = false; if (active) setChecking(false); }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [open, provider, onClose, retry, embedded, start]);
  useEffect(() => {
    if (!open || !start) return;
    if (start === 'opencode') setOpencode(true); else if (start === 'openrouter') setOpenrouter(true); else if (start === 'local') setLocal(true); else void begin(start);
  }, [open, start]);
  async function begin(next: AiProvider) {
    setBusy(true); setMessage(''); setCode(''); setSubmitted(false);
    try { setState(await window.aiConnections.start(next)); setProvider(next); }
    catch { setMessage('Could not start sign-in. Please retry.'); }
    finally { setBusy(false); }
  }
  async function back(close = false) {
    setBusy(true); setMessage('');
    try {
      if (window.aiConnections) await window.aiConnections.cancel();
      setProvider(undefined); setState(undefined); setCode(''); setSubmitted(false);
      if (close) onClose();
    } catch { if (!provider) onClose(); else setMessage('Could not cancel sign-in. Please retry.'); }
    finally { setBusy(false); }
  }
  async function disconnect(id: AiConnectionState['provider']) {
    setBusy(true); setMessage('');
    try {
      await window.aiConnections.disconnect(id);
      setConnections(current => current.map(item => item.provider === id ? { ...item, status: 'disconnected' } : item));
      setRetry(value => value + 1);
    } catch { setMessage('Could not disconnect. Please retry.'); }
    finally { setBusy(false); }
  }
  const label = provider === 'grok' ? 'Grok' : provider === 'claude' ? 'Claude' : 'ChatGPT';
  const openCodeInstalled = connections.find(item => item.provider === 'opencode')?.installed === true;
  const missing = (id: AiConnectionState['provider']) => connections.some(item => item.provider === id && item.installed === false);
  const viaOpenCode = (id: AiConnectionState['provider']) => id === 'opencode' || id === 'openrouter' || id === 'local';
  const keyed = (id: AiConnectionState['provider']) => id === 'opencode' || id === 'openrouter';
  const connected = (id: AiConnectionState['provider']) => connections.some(item => item.provider === id && item.status === 'connected');
  const stepBack = opencode ? () => setOpencode(false) : openrouter ? () => setOpenrouter(false) : local ? () => setLocal(false) : provider ? () => void back() : undefined;
  if (hostBack) hostBack.handler.current = stepBack;
  const backDisabled = busy || stepBusy;
  // Before paint, so the host header never shows a Back that no longer applies.
  useLayoutEffect(() => {
    hostBack?.change({ available: !!stepBack, disabled: backDisabled });
  }, [hostBack, !!stepBack, backDisabled]);
  useLayoutEffect(() => () => hostBack?.change({ available: false, disabled: false }), [hostBack]);
  const content = <>
      {!embedded && <DialogBackTitle onBack={stepBack} backDisabled={backDisabled}>{opencode ? 'Connect OpenCode Zen' : openrouter ? 'Connect OpenRouter' : local ? 'Connect a local model' : provider ? `Connect ${label}` : 'Connect your AI'}</DialogBackTitle>}
      {opencode ? <OpenCodeConnect onBusy={setStepBusy} onConnected={embedded ? () => { setOpencode(false); setRetry(value => value + 1); } : onClose} />
        : openrouter ? <OpenCodeConnect provider="OpenRouter" onBusy={setStepBusy} onConnected={embedded ? () => { setOpenrouter(false); setRetry(value => value + 1); } : onClose} />
        : local ? <LocalModelConnect onBusy={setStepBusy} onConnected={embedded ? () => { setLocal(false); setRetry(value => value + 1); } : onClose} /> : !provider ? <>
        <p className="text-sm text-muted-foreground">{embedded ? 'Use your own AI account to run takes on your connected platform.' : 'Bring your own AI account to use with your connected trading account.'}</p>
        {embedded ? <ul aria-label="AI providers" className="space-y-5">
          {([
            { id: 'claude', name: 'Claude', logo: <ClaudeMark className="size-6 text-[#D97757]" /> },
            { id: 'chatgpt', name: 'ChatGPT', logo: <OpenaiMark className="size-6" /> },
            { id: 'grok', name: 'Grok', logo: <GrokMark className="size-6" /> },
            { id: 'opencode', name: 'OpenCode Zen', logo: <OpencodeMark className="size-6" /> },
            { id: 'openrouter', name: 'OpenRouter', logo: <OpenrouterMark className="size-6" /> },
            { id: 'local', name: 'Local model', logo: <LocalModelMark className="size-6" /> },
          ] as const).map(({ id, name, logo }) => <ConnectionRow key={id} name={name} logo={logo} connected={connected(id)} description={
            missing(id) || (viaOpenCode(id) && !openCodeInstalled) ? 'Not installed' : id === 'grok' ? 'Connect with your Grok account' : id === 'opencode' ? 'Billed by OpenCode' : id === 'openrouter' ? 'Billed by OpenRouter' : id === 'local' ? 'Runs on this computer through OpenCode' : 'Uses your plan’s limits'
          }>
            <button type="button" aria-label={`${connected(id) ? 'Disconnect' : keyed(id) ? 'Add key for' : 'Connect'} ${name}`} disabled={busy || checking || !!serviceError || (!connected(id) && (viaOpenCode(id) ? !openCodeInstalled : missing(id)))}
              onClick={() => connected(id) ? void disconnect(id) : id === 'opencode' ? setOpencode(true) : id === 'openrouter' ? setOpenrouter(true) : id === 'local' ? setLocal(true) : void begin(id)}
              className={connected(id) ? connectionDisconnectClass : connectionActionClass}>{connected(id) ? 'Disconnect' : keyed(id) ? 'Add key' : 'Connect'}</button>
          </ConnectionRow>)}
        </ul> : <RowMenu aria-label="AI providers">
          <RowMenuItem aria-label="ChatGPT" aria-describedby="chatgpt-description" disabled={busy || checking || !!serviceError || missing('chatgpt') || connected('chatgpt')} onClick={() => void begin('chatgpt')}><OpenaiMark className="size-6 shrink-0" /><span><span className="block font-medium">ChatGPT{connected('chatgpt') && <span className="ml-2 text-xs text-green-600 dark:text-green-400">Connected</span>}</span><span id="chatgpt-description" className="mt-1 block text-xs text-muted-foreground">{missing('chatgpt') ? 'Not installed — install Codex CLI.' : 'Use your ChatGPT subscription. Your plan’s usage limits apply.'}</span></span></RowMenuItem>
          <RowMenuItem aria-label="Claude" aria-describedby="claude-description" disabled={busy || checking || !!serviceError || missing('claude') || connected('claude')} onClick={() => void begin('claude')}><ClaudeMark className="size-6 shrink-0 text-[#D97757]" /><span><span className="block font-medium">Claude{connected('claude') && <span className="ml-2 text-xs text-green-600 dark:text-green-400">Connected</span>}</span><span id="claude-description" className="mt-1 block text-xs text-muted-foreground">{missing('claude') ? 'Not installed — install Claude Code CLI.' : 'Use your Claude subscription. Your plan’s usage limits apply.'}</span></span></RowMenuItem>
          <RowMenuItem aria-label="Grok" disabled={busy || checking || !!serviceError || missing('grok') || connected('grok')} onClick={() => void begin('grok')}><GrokMark className="size-6 shrink-0" /><span><span className="block font-medium">Grok</span><span className="mt-1 block text-xs text-muted-foreground">{missing('grok') ? 'Install Grok CLI 1.0.46 on macOS.' : 'Connect with your Grok account.'}</span></span></RowMenuItem>
          <RowMenuItem aria-label="OpenCode Zen" aria-describedby="opencode-description" disabled={busy || checking || !!serviceError || !openCodeInstalled || connected('opencode')} onClick={() => setOpencode(true)}><OpencodeMark className="size-6 shrink-0" /><span><span className="block font-medium">OpenCode Zen{connected('opencode') && <span className="ml-2 text-xs text-green-600 dark:text-green-400">Connected</span>}</span><span id="opencode-description" className="mt-1 block text-xs text-muted-foreground">{!openCodeInstalled ? 'Not installed' : 'Use your OpenCode Zen key. Usage is billed by OpenCode.'}</span></span></RowMenuItem>
          <RowMenuItem aria-label="OpenRouter" aria-describedby="openrouter-description" disabled={busy || checking || !!serviceError || !openCodeInstalled || connected('openrouter')} onClick={() => setOpenrouter(true)}><OpenrouterMark className="size-6 shrink-0" /><span><span className="block font-medium">OpenRouter{connected('openrouter') && <span className="ml-2 text-xs text-green-600 dark:text-green-400">Connected</span>}</span><span id="openrouter-description" className="mt-1 block text-xs text-muted-foreground">{!openCodeInstalled ? 'Not installed — install OpenCode.' : 'Use your OpenRouter key for hundreds of models. Usage is billed by OpenRouter.'}</span></span></RowMenuItem>
          <RowMenuItem aria-label="Local model" aria-describedby="local-description" disabled={busy || checking || !!serviceError || !openCodeInstalled || connected('local')} onClick={() => setLocal(true)}><LocalModelMark className="size-6 shrink-0" /><span><span className="block font-medium">Local model{connected('local') && <span className="ml-2 text-xs text-green-600 dark:text-green-400">Connected</span>}</span><span id="local-description" className="mt-1 block text-xs text-muted-foreground">{!openCodeInstalled ? 'Not installed — install OpenCode.' : 'Use Ollama, LM Studio or another server on this computer.'}</span></span></RowMenuItem>
        </RowMenu>}
        {(!openCodeInstalled || missing('claude') || missing('chatgpt') || missing('grok')) && <button type="button" disabled={checking || busy} className={linkButtonClass} onClick={() => {
          setChecking(true);
          void window.aiConnections.checkOpenCode().then(() => setRetry(value => value + 1)).catch(() => { setMessage('Could not check OpenCode installation. Restart the app and retry.'); setChecking(false); });
        }}>Check again</button>}
      </> : <div className="space-y-4">
        {state?.status === 'error' ? <>
          <p role="alert" className="text-sm text-destructive">{state.message}</p>
          <button type="button" disabled={busy || checking || !!serviceError} onClick={() => void begin(provider)} className={linkButtonClass}>Retry sign-in</button>
        </> : <>
          {!state?.verificationUrl ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Preparing sign-in…</div> : <>
            <p className="text-sm text-muted-foreground">{provider !== 'claude' ? `Open ${label} sign-in and enter or confirm this one-time code:` : 'Open Claude sign-in, approve the connection, then paste the code shown in your browser.'}</p>
            {state.userCode && <p aria-label={`${label} device code`} className="rounded-md bg-muted p-3 text-center font-mono text-lg select-all">{state.userCode}</p>}
            <button type="button" disabled={busy} onClick={() => {
              void window.aiConnections.reopen().catch(() => setMessage('Could not open sign-in. Go back and retry.'));
            }} className={linkButtonClass}>Open {label} sign-in ↗</button>
            {provider === 'claude' && !submitted && <form className="space-y-3" onSubmit={event => {
              event.preventDefault(); setBusy(true); setMessage('');
              void window.aiConnections.submitCode('claude', code.trim()).then(() => { setCode(''); setSubmitted(true); })
                .catch(() => setMessage('Could not submit that code. Check it and retry.')).finally(() => setBusy(false));
            }}>
              <label className={fieldLabelClass}>Claude authorization code<input type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} placeholder="Paste the code from Claude" className={inputClass} /></label>
              <div className={actionsClass}><button type="submit" disabled={busy || !code.trim()} className={primaryButtonClass}>Connect Claude</button></div>
            </form>}
            {(provider !== 'claude' || submitted) && <p role="status" className="text-sm text-muted-foreground">Waiting for sign-in to finish…</p>}
          </>}
        </>}
      </div>}
      {serviceError && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{serviceError}</p><button type="button" disabled={checking} onClick={() => setRetry(value => value + 1)} className={linkButtonClass}>{checking ? 'Checking…' : 'Retry AI connection check'}</button></div>}
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
  </>;
  return embedded ? <div className="space-y-6">{content}</div> : <Dialog open={open} onOpenChange={next => { if (!next && !busy) void back(true); }}><DialogContent className="max-w-sm">{content}</DialogContent></Dialog>;
}
