import { CoinbaseMark } from '../logos';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, ChevronLeft, ChevronRight, File, Info, LoaderCircle, Shield } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import portfolioScreenshot from '../assets/guides/coinbase-new-portfolio.png';
import type { CoinbaseImportStage, PlatformAccountConnection } from '../../../shared/platform-connections';

type Step = 'start' | 'portfolio' | 'key' | 'import' | 'success';
type Route = 'new' | 'existing' | 'direct';
const primary = 'flex w-full items-center justify-center gap-2 rounded-full bg-zinc-100 px-4 py-3 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-40';
const secondary = 'flex w-full items-center justify-center gap-2 rounded-full bg-[#202024] px-4 py-3 text-sm font-medium text-zinc-100 hover:bg-[#29292e] disabled:opacity-40';
const quiet = 'rounded text-sm font-medium text-zinc-400 hover:text-zinc-100 disabled:opacity-40';
const stages: CoinbaseImportStage[] = ['key', 'permissions', 'portfolio', 'saving'];

export function CoinbaseSetup({ existing, connections, onConnected, onClose }: {
  existing?: PlatformAccountConnection; connections: PlatformAccountConnection[];
  onConnected: (items: PlatformAccountConnection[]) => void; onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(existing ? 'import' : 'start');
  const [route, setRoute] = useState<Route>('direct');
  const [readOnly, setReadOnly] = useState(existing ? !existing.permissions.trade : false);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<CoinbaseImportStage | null>(null);
  const [fileName, setFileName] = useState('Coinbase key JSON');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState<PlatformAccountConnection>();
  const group = useId();
  const alive = useRef(true); const working = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (working.current) void window.coinbase.cancel().catch(() => {}); }; }, []);
  const go = (next: Step) => { setError(''); setChanging(false); setStep(next); };
  function back() {
    if (busy) return;
    if (step === 'start' || step === 'success' || existing) onClose();
    else go(step === 'import' ? route === 'direct' ? 'start' : 'key' : step === 'key' && route === 'new' ? 'portfolio' : 'start');
  }
  async function open(destination: 'keys' | 'portfolios' | 'portfolio-help') {
    try { await window.coinbase.openPortal(destination); } catch { setError('Could not open Coinbase. Please try again.'); }
  }
  async function importKey(file?: globalThis.File) {
    if (working.current) return;
    if (file && (!file.name.toLowerCase().endsWith('.json') || file.size > 16384)) { setError('Choose a Coinbase JSON key file smaller than 16 KB.'); return; }
    working.current = true; setBusy(true); setError(''); setChanging(false); setStage(null); setFileName(file?.name ?? 'Coinbase key JSON');
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return; polling = true;
      try { const progress = await window.coinbase.importProgress(); if (alive.current && working.current && progress) setStage(progress); } catch { /* The import result reports errors. */ }
      finally { polling = false; }
    }, 200);
    try {
      const input = { connectionId: existing?.connectionId, readOnly };
      const result = await (file ? window.coinbase.importDroppedKey(file, input) : window.coinbase.importKey(input));
      if (!alive.current) return;
      if (!result.ok) { setError(result.message); return; }
      if (result.cancelled) return;
      setConnected(result.connections.find(c => existing ? c.connectionId === existing.connectionId : !connections.some(old => old.connectionId === c.connectionId && old.checkedAt === c.checkedAt)));
      onConnected(result.connections); go('success');
    } catch { if (alive.current) setError('Could not import this key. Please try again.'); }
    finally { clearInterval(timer); working.current = false; if (alive.current) { setBusy(false); setStage(null); } }
  }
  const total = route === 'new' ? 3 : route === 'existing' ? 2 : 1;
  const current = step === 'portfolio' ? 1 : step === 'key' ? route === 'new' ? 2 : 1 : total;
  const title = step === 'start' ? 'Connect Coinbase' : step === 'portfolio' ? 'Create a separate portfolio' : step === 'key' ? 'Create your API key' : step === 'success' ? 'You’re connected' : existing ? 'Replace your key' : 'Import your key';
  const permissionChoice = <fieldset disabled={busy} className="space-y-2">
    <legend className="mb-2 text-sm font-medium text-zinc-300">What should the key allow?</legend>
    <div className="grid grid-cols-2 gap-2">{[{ value: false, label: 'Trading', detail: 'View + Trade' }, { value: true, label: 'Read-only', detail: 'View only' }].map(option => <label key={option.label} className={`flex cursor-pointer items-start gap-2.5 rounded-xl p-3 ${readOnly === option.value ? 'bg-[#202024]' : 'hover:bg-[#17171a]'}`}>
      <input type="radio" name={group} checked={readOnly === option.value} onChange={() => setReadOnly(option.value)} className="mt-0.5 size-4 shrink-0 appearance-none rounded-full border border-zinc-600 bg-transparent checked:border-[5px] checked:border-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400" />
      <span><span className="block text-sm font-medium">{option.label}</span><span className="mt-0.5 block text-xs text-zinc-400">{option.detail}</span></span>
    </label>)}</div>
  </fieldset>;
  const number = (value: number) => <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#202024] text-xs font-medium text-zinc-300">{value}</span>;
  const footer = <p className="flex items-center justify-center gap-2 text-xs text-zinc-500"><Shield size={12} />Your key is stored securely on this device.</p>;
  return <Dialog open onOpenChange={next => { if (!next && !working.current) onClose(); }}>
    <DialogContent showCloseButton={false} className="w-[calc(100%-2rem)] visible max-w-[570px] gap-6 rounded-[28px] bg-[#111113] p-6 sm:p-8 text-zinc-100 ring-white/5 shadow-[0_24px_64px_rgba(0,0,0,0.4)]">
      <div className="flex items-center justify-between"><button type="button" disabled={busy} onClick={back} className={`${quiet} flex items-center gap-1`}><ChevronLeft size={14} />Back</button><span className="flex items-center gap-2 text-xs font-medium text-zinc-300"><CoinbaseMark size={24} className="size-6 shrink-0" />Coinbase</span></div>
      <div className="space-y-1.5">
        {step !== 'start' && step !== 'success' && <><div className="mb-2 flex gap-1" aria-hidden="true">{Array.from({ length: total }, (_, i) => <span key={i} className={`h-[3px] flex-1 rounded-full ${i + 1 < current ? 'bg-emerald-400' : i + 1 === current ? 'bg-zinc-100' : 'bg-zinc-800'}`} />)}</div><p className="text-xs text-zinc-500">Step {current} of {total} · {step === 'import' ? route === 'direct' ? 'In Opentake' : 'Back in Opentake' : 'On Coinbase'}</p></>}
        <DialogTitle>{title}</DialogTitle>
        <p className="text-sm leading-relaxed text-zinc-400">{step === 'portfolio' ? 'Keeps Opentake’s funds apart from the rest of your Coinbase account.' : step === 'key' ? 'Keep this window open while you finish on Coinbase.' : step === 'import' ? 'Choose the JSON file you downloaded. We’ll verify access and find your portfolio.' : step === 'success' ? 'Your portfolio is ready in Connections.' : 'Connect a portfolio, or bring a key you already have.'}</p>
      </div>
      {step === 'start' && <div className="space-y-2">{[
        { title: 'Connect my existing portfolio', detail: 'Use Primary or another portfolio.', route: 'existing' as const, step: 'key' as const },
        { title: 'Create a separate portfolio', detail: 'Use one portfolio across your Takes.', route: 'new' as const, step: 'portfolio' as const },
        { title: 'I already have an API key', detail: 'Go straight to import.', route: 'direct' as const, step: 'import' as const },
      ].map(item => <button key={item.route} type="button" onClick={() => { setRoute(item.route); go(item.step); }} className="flex w-full items-center justify-between rounded-xl border border-white/5 bg-[#171719] p-4 text-left hover:bg-[#202024]"><span><span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-zinc-500">{item.detail}</span></span><ChevronRight size={16} /></button>)}</div>}
      {step === 'portfolio' && <>
        <ol className="space-y-4 text-sm">
          <li className="flex gap-3">{number(1)}<p className="pt-0.5 font-medium">Open Coinbase Advanced, then Portfolio › Spot</p></li>
          <li className="flex gap-3">{number(2)}<div className="min-w-0 flex-1 space-y-3"><p className="pt-0.5 font-medium">Open the portfolio menu and pick New portfolio</p>
            <div role="img" aria-label="Example portfolio menu: select New portfolio below All portfolios and Primary" className="space-y-1 rounded-xl bg-[#0e0e10] p-2.5 text-xs"><div className="flex justify-between px-2 py-1 text-zinc-500"><span>All portfolios</span><span>▾</span></div><div className="flex justify-between rounded-lg bg-[#202024] px-2 py-1.5"><span>All portfolios</span><Check size={12} className="text-zinc-500" /></div><div className="px-2 py-1.5">Primary</div><div className="rounded-lg border border-emerald-400 px-2 py-1 font-medium">+ New portfolio</div></div>
            <details className="text-xs text-zinc-500"><summary className="cursor-pointer hover:text-zinc-300">See Coinbase screenshot</summary><img src={portfolioScreenshot} alt="Coinbase Advanced Portfolio page with Spot selected and the portfolio dropdown showing New portfolio." width={350} height={253} className="mt-2 h-auto w-full rounded-lg" /></details>
          </div></li>
          <li className="flex gap-3">{number(3)}<div><p className="pt-0.5 font-medium">Name it something you’ll recognize</p><p className="mt-1 text-xs text-zinc-400">Like “Opentake”</p></div></li>
        </ol>
        <div className="space-y-2"><button type="button" className={secondary} onClick={() => void open('portfolios')}>Open Coinbase Advanced<ArrowUpRight size={14} /></button><button type="button" className={primary} onClick={() => go('key')}>I’ve created my portfolio</button></div>
      </>}
      {step === 'key' && <>
        {permissionChoice}
        <ol className="space-y-4 border-t border-white/5 pt-5 text-sm">
          <li className="flex gap-3">{number(1)}<div><p className="pt-0.5 font-medium">Name the key</p><p className="mt-1 text-xs text-zinc-400">Like “Opentake”</p></div></li>
          <li className="flex gap-3">{number(2)}<div><p className="pt-0.5 font-medium">Expand API restrictions and Advanced settings</p><p className="mt-1 text-xs text-zinc-400">{route === 'new' ? 'Select the portfolio from step 1' : 'Select the portfolio you want to connect'}</p></div></li>
          <li className="flex gap-3">{number(3)}<div className="flex-1"><p className="pt-0.5 font-medium">Match these settings</p><dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 rounded-xl bg-[#0e0e10] p-3 text-xs"><dt className="text-zinc-400">Signature algorithm</dt><dd className="text-right font-medium">ECDSA</dd><dt className="text-zinc-400">Permissions</dt><dd className="text-right font-medium text-emerald-400">{readOnly ? 'View only' : 'View + Trade'}</dd><dt className="text-zinc-400">Transfer</dt><dd className="text-right font-medium">Off</dd></dl></div></li>
          <li className="flex gap-3">{number(4)}<div><p className="pt-0.5 font-medium">Create key, then download it</p><p className="mt-1 text-xs leading-relaxed text-zinc-400">Coinbase doesn’t download the JSON file automatically.</p></div></li>
        </ol>
        <p className="flex gap-2 text-xs leading-relaxed text-zinc-400"><Info size={13} className="mt-0.5 shrink-0" />Leave Transfer off either way. Choose Trading to place reviewed orders, or Read-only to sync your portfolio.</p>
        <div className="space-y-2"><button type="button" className={secondary} onClick={() => void open('keys')}>Open Coinbase key settings<ArrowUpRight size={14} /></button><button type="button" className={primary} onClick={() => go('import')}>I’ve downloaded my key</button></div>
      </>}
      {step === 'import' && <div className="space-y-3">
        <div className="flex items-center gap-3 rounded-xl bg-[#171719] p-4 text-sm"><Check size={14} className="text-emerald-400" /><span className="flex-1"><span className="font-medium">{readOnly ? 'Read-only key' : 'Trading key'}</span><span className="text-zinc-500"> · {readOnly ? 'View only' : 'View + Trade'}</span></span><button type="button" disabled={busy} className={quiet} onClick={() => setChanging(value => !value)}>{changing ? 'Done' : 'Change'}</button></div>
        {changing && <div className="rounded-xl border border-white/5 p-3">{permissionChoice}<p className="mt-2 text-xs text-zinc-500">Match the permissions on your key. This doesn’t change them on Coinbase.</p></div>}
        {!busy ? <div onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) { setError('Drop one JSON key file at a time.'); return; } void importKey(event.dataTransfer.files[0]); }} className={`flex flex-col items-center rounded-2xl border bg-[#0e0e10] px-4 py-7 text-center ${dragging ? 'border-emerald-400' : 'border-white/10'}`}>
          <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-[#202024]"><File size={18} className="text-zinc-400" /></span><p className="text-sm font-medium">Drop your key file here</p><p className="mt-1 text-xs text-zinc-500">cdp_api_key.json</p><button type="button" onClick={() => void importKey()} className={`${primary} mt-4 w-auto px-6`}>Choose JSON file</button>
        </div> : <div role="status" aria-label="Verifying Coinbase key" className="space-y-4 rounded-2xl border border-white/5 bg-[#0e0e10] p-4">
          <div className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#202024]"><File size={16} className="text-zinc-400" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{fileName}</p><p className="text-xs text-zinc-500">{stage ? 'Verifying access…' : 'Waiting for key file…'}</p></div><button type="button" className={quiet} onClick={() => void window.coinbase.cancel().catch(() => setError('Could not cancel. Please try again.'))}>Cancel</button></div>
          <div className="h-[3px] overflow-hidden rounded-full bg-zinc-800"><div className="h-full bg-zinc-100 transition-[width]" style={{ width: `${stage ? [15, 35, 65, 90][stages.indexOf(stage)] : 0}%` }} /></div>
          <ul className="space-y-2 text-sm">{['Validate key file', 'Check permissions match', 'Find your portfolio'].map((label, index) => { const current = stage ? stages.indexOf(stage) : -1; const done = current > index; return <li key={label} className={`flex items-center gap-2 ${current < index ? 'text-zinc-600' : 'text-zinc-300'}`}>{done ? <Check size={13} className="text-emerald-400" /> : current === index ? <LoaderCircle size={13} className="animate-spin" /> : <span className="size-[13px] rounded-full border border-zinc-700" />}{done && index === 0 ? 'Key file is valid' : label}</li>; })}</ul>
        </div>}
        <button type="button" disabled={busy} onClick={() => { setRoute('existing'); go('key'); }} className={`${quiet} w-full pt-3 text-center`}>Need help creating the key?</button>
      </div>}
      {step === 'success' && <><div className="flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4"><CheckCircle2 className="text-emerald-400" /><div><p className="font-medium">{connected?.portfolioName ?? 'Coinbase portfolio'}</p><p className="mt-1 text-xs text-zinc-400">{readOnly ? 'Read-only key' : 'View + Trade key'} · Transfers disabled</p></div></div><p className="text-xs leading-relaxed text-zinc-400">Reuse this connected portfolio across your Takes—no new portfolio or API key is needed for each Take.</p><div className="space-y-2"><button type="button" className={primary} onClick={onClose}>Done</button>{!existing && <button type="button" className={secondary} onClick={() => { setReadOnly(false); go('start'); }}>Connect another portfolio</button>}</div></>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {footer}
      {step === 'portfolio' && <button type="button" onClick={() => void open('portfolio-help')} className="-mt-3 text-xs text-zinc-500 hover:text-zinc-300">Coinbase’s portfolio guide</button>}
    </DialogContent>
  </Dialog>;
}
