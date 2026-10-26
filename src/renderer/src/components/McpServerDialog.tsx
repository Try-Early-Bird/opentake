import { useEffect, useState } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Plus, X, KeyRound, ChevronDown } from 'lucide-react';
import type { ManagedServer, McpConfig } from '../../../shared/mcp-management';
import type { CredentialMetadata } from '../../../shared/credentials';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Menu } from '@base-ui/react/menu';

interface SecretRow { id: string; name: string; credentialId: string; prefix: string; value: string }
const newRow = (name = ''): SecretRow => ({ id: crypto.randomUUID(), name, credentialId: '', prefix: '', value: '' });
const empty: McpConfig = { name: '', transport: 'http', command: '', args: [], url: '', env: {}, bindings: [], oauth: false };
const input = 'mt-2 w-full rounded-2xl border border-input bg-background/40 px-4 py-3 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring';
const pill = 'rounded-full px-4 py-2 text-sm font-medium text-muted-foreground data-active:bg-muted data-active:text-foreground disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring';
export function McpServerDialog({ server, onClose, onSaved }: { server?: ManagedServer; onClose: () => void; onSaved: () => Promise<void> }) {
  const [config, setConfig] = useState<McpConfig>(server?.config ?? empty);
  const [id, setId] = useState<string | null>(server?.id ?? null);
  const [args, setArgs] = useState(JSON.stringify(server?.config.args ?? []));
  const [env, setEnv] = useState(JSON.stringify(server?.config.env ?? {}, null, 2));
  const [auth, setAuth] = useState(server?.config.oauth?'oauth':server?.config.bindings.length ? 'key' : 'none');
  const [rows, setRows] = useState<SecretRow[]>(() => (server?.config.bindings ?? []).map(binding => ({ ...binding, id: crypto.randomUUID(), value: '' })));
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.settings.listCredentials().then(result => {
      if (active && result.ok) setCredentials(result.items.filter(item => ['api-key', 'bearer-token', 'key-value'].includes(item.type)));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  function authentication(next: string) {
    setAuth(next);
    setRows(next === 'key' ? [newRow(config.transport === 'http' ? 'X-API-Key' : 'API_KEY')] : []);
  }
  function updateRow(id: string, patch: Partial<SecretRow>) {
    setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row));
  }
  async function connect() {
    setBusy(true); setError('');
    try {
      const parsedArgs = config.transport === 'stdio' ? JSON.parse(args) : [];
      const parsedEnv = config.transport === 'stdio' ? JSON.parse(env) : {};
      const resolved = auth === 'key' ? rows.map(row => ({ ...row })) : [];
      const keys = resolved.map(row => config.transport === 'http' ? row.name.toLowerCase() : row.name);
      if (new Set(keys).size !== keys.length || resolved.some(row => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(row.name) || (!row.credentialId && !row.value))) {
        setError('Give each row a unique key and a value or saved credential.'); return;
      }
      for (const row of resolved) {
        if (row.credentialId) continue;
        const name = `${config.name.slice(0, 32)} ${row.name.slice(0, 24)} ${crypto.randomUUID().slice(0, 8)}`;
        const result = await window.settings.saveCredential({ name, provider: 'MCP', type: 'api-key', value: row.value });
        if (!result.ok) throw new Error('Credential save failed');
        const credential = result.items.find(item => item.name === name);
        if (!credential) throw new Error('Saved credential unavailable');
        row.credentialId = credential.id; row.value = '';
        updateRow(row.id, { credentialId: credential.id, value: '' });
        setCredentials(result.items.filter(item => ['api-key', 'bearer-token', 'key-value'].includes(item.type)));
      }
      const next = { ...config, oauth: auth==='oauth', args: parsedArgs, env: parsedEnv,
        bindings: resolved.map(({ name, credentialId, prefix }) => ({ name, credentialId, prefix })) };
      const savedId = await window.mcp.save(id, next);
      setId(savedId);
      if(auth==='oauth'){await window.mcp.oauthStart(savedId);await onSaved();onClose();return;}
      await window.mcp.discover(savedId);
      await window.mcp.enable(savedId, true);
      await onSaved(); onClose();
    } catch { setError('Could not connect. Check the configuration and credentials, then try again. Any saved configuration remains available.'); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="flex max-w-xl flex-col overflow-hidden rounded-[28px] bg-popover p-6 sm:p-8" showCloseButton={!busy}>
      <DialogTitle className="text-xl">{server ? 'Configure MCP server' : 'Add MCP server'}</DialogTitle>
      <DialogDescription>Connect a local or remote server. You’ll review each tool before it can run.</DialogDescription>
      <form className="mt-2 flex min-h-0 flex-col gap-5 overflow-hidden" onSubmit={event => { event.preventDefault(); void connect(); }}>
        <div className="min-h-0 overflow-y-auto"><fieldset disabled={busy} className="min-w-0 space-y-5 px-1 disabled:opacity-60">
          <label className="block text-sm font-medium">Name<input required maxLength={80} className={input} placeholder="Market research tools" value={config.name} onChange={event => setConfig({ ...config, name: event.target.value })} /></label>
          <div><p className="mb-2 text-sm font-medium">Connection</p><Tabs.Root value={config.transport} onValueChange={value => {
            setConfig({ ...config, transport: value as McpConfig['transport'], bindings: [], oauth: false }); setAuth('none'); setRows([]); setReviewed(false);
          }}><Tabs.List aria-label="Connection type" className="flex gap-1"><Tabs.Tab className={pill} value="http">Remote URL</Tabs.Tab><Tabs.Tab className={pill} value="stdio">Local command</Tabs.Tab></Tabs.List></Tabs.Root></div>
          {config.transport === 'http' ? <label className="block text-sm font-medium">Server URL<input required type="url" className={`${input} font-mono`} placeholder="https://mcp.example.com/mcp" value={config.url} onChange={event => setConfig({ ...config, url: event.target.value })} /></label> : <>
            <label className="block text-sm font-medium">Executable (absolute path)<input required className={`${input} font-mono`} placeholder="/usr/local/bin/mcp-server" value={config.command} onChange={event => setConfig({ ...config, command: event.target.value })} /></label>
            <label className="block text-sm font-medium">Arguments (JSON array)<textarea className={`${input} font-mono`} value={args} onChange={event => setArgs(event.target.value)} /></label>
            <label className="block text-sm font-medium">Environment (JSON object, no secrets)<textarea className={`${input} font-mono`} value={env} onChange={event => setEnv(event.target.value)} /></label>
          </>}
          <div><p className="mb-2 text-sm font-medium">Authentication</p><Tabs.Root value={auth} onValueChange={value => authentication(String(value))}><Tabs.List aria-label="Authentication" className="flex gap-1"><Tabs.Tab className={pill} value="none">None</Tabs.Tab><Tabs.Tab className={pill} value="key">API key</Tabs.Tab>{config.transport==='http'&&<Tabs.Tab className={pill} value="oauth">Browser sign-in</Tabs.Tab>}</Tabs.List></Tabs.Root></div>
          {auth==='oauth'&&<div className="space-y-3"><p className="text-xs text-muted-foreground">Sign in through your browser. Tokens are stored securely and refreshed when supported by the server.</p><details><summary className="cursor-pointer text-sm">Advanced OAuth settings</summary><label className="mt-3 block text-sm">Client ID (optional)<input className={input} value={config.oauthClientId??''} onChange={e=>setConfig({...config,oauthClientId:e.target.value})}/></label><label className="mt-3 block text-sm">Client metadata URL (optional)<input className={input} type="url" value={config.oauthMetadataUrl??''} onChange={e=>setConfig({...config,oauthMetadataUrl:e.target.value})}/></label><label className="mt-3 block text-sm">Callback port (optional)<input className={input} type="number" min={1024} max={65535} value={config.oauthRedirectPort??''} onChange={e=>setConfig({...config,oauthRedirectPort:e.target.value?Number(e.target.value):undefined})}/></label><p className="mt-2 text-xs text-muted-foreground">Defaults to automatic client registration and an available port. For a registered client, use http://127.0.0.1:PORT/oauth/callback with your chosen port.</p></details></div>}
          {auth === 'key' && <div className="space-y-3">
            <div><h3 className="text-sm font-medium">{config.transport === 'http' ? 'Request headers' : 'Environment variables'}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Enter a new credential or choose one you saved. New credentials are stored securely; saved values stay hidden.</p></div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)_28px] gap-2 px-1 text-xs text-muted-foreground" aria-hidden="true"><span>{config.transport === 'http' ? 'Header' : 'Variable'}</span><span>Value</span></div>
            {rows.map((row, index) => <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)_28px] items-center gap-2">
              <input aria-label={`Key ${index + 1}`} required className={`${input} mt-0 min-w-0 font-mono`} placeholder={config.transport === 'http' ? 'X-API-Key' : 'API_KEY'} value={row.name} onChange={event => updateRow(row.id, { name: event.target.value })} />
              <div className="flex min-h-11 min-w-0 items-center gap-1 rounded-2xl border border-input bg-background/40 p-1.5 focus-within:ring-2 focus-within:ring-ring">
                {row.credentialId ? <>
                  {row.prefix && <input aria-label={`Value prefix ${index + 1}`} className="min-w-0 bg-transparent pl-1 font-mono text-xs outline-none" style={{ width: `${Math.max(3, row.prefix.length)}ch` }} value={row.prefix} onChange={event => updateRow(row.id, { prefix: event.target.value })} />}
                  <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-2 text-xs font-medium text-success" title={credentials.find(item => item.id === row.credentialId)?.name ?? 'Saved credential'}><KeyRound size={13} className="shrink-0" /><span className="truncate">{credentials.find(item => item.id === row.credentialId)?.name ?? 'Saved credential'}</span></span>
                  <button type="button" aria-label={`Clear saved credential ${index + 1}`} title="Clear saved credential" className="ml-auto shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => updateRow(row.id, { credentialId: '', value: '', prefix: '' })}><X size={13} /></button>
                </> : <>
                  <input aria-label={`Value ${index + 1}`} required type="password" autoComplete="new-password" className="min-w-0 flex-1 bg-transparent py-1.5 pl-2 font-mono text-sm outline-none placeholder:text-muted-foreground/60" placeholder="Paste a value" value={row.value} onChange={event => updateRow(row.id, { value: event.target.value })} />
                  <Menu.Root><Menu.Trigger aria-label={`Saved credentials for row ${index + 1}`} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><KeyRound size={12} />Saved<ChevronDown size={12} /></Menu.Trigger><Menu.Portal><Menu.Positioner sideOffset={5} align="end" collisionPadding={8} className="z-[60]"><Menu.Popup className="max-h-64 min-w-44 max-w-xs overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none">
                    {credentials.length ? credentials.map(item => <Menu.Item key={item.id} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-2 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground" onClick={() => updateRow(row.id, { credentialId: item.id, value: '', prefix: '' })}><KeyRound size={13} className="shrink-0 text-muted-foreground" /><span className="break-words">{item.name}</span></Menu.Item>) : <Menu.Item disabled className="px-2 py-2 text-xs text-muted-foreground">No saved credentials. Add one in Settings → Credentials.</Menu.Item>}
                  </Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>
                </>}
              </div>
              <button type="button" aria-label={`Remove row ${index + 1}`} title="Remove" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setRows(current => current.filter(item => item.id !== row.id))}><X size={15} /></button>
            </div>)}
            <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-muted-foreground hover:bg-muted" onClick={() => setRows(current => [...current, newRow()])}><Plus size={14} />{config.transport === 'http' ? 'Add header' : 'Add variable'}</button>
          </div>}
          {config.transport === 'stdio' && <label className="flex items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed this command and its credential access. Connecting runs this program on my machine without a sandbox.</label>}
        </fieldset></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex shrink-0 justify-end gap-3 pt-4"><button type="button" disabled={busy} className="rounded-full px-4 py-3 text-sm text-muted-foreground" onClick={onClose}>Cancel</button><button disabled={busy || (config.transport === 'stdio' && !reviewed)} className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? 'Connecting…' : 'Connect server'}</button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
