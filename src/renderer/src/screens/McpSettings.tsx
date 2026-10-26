import { McpMetadataHistory } from '../components/McpMetadataHistory';
import { Select } from '../components/ui/select';
import { McpOAuthControls } from '../components/McpOAuthControls';
import { PlatformAccessSetting } from '../components/PlatformAccessSetting';
import { useEffect, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { ChevronRight, Plus } from 'lucide-react';
import type { ManagedServer, ManagedTool, ToolPolicy } from '../../../shared/mcp-management';
import { McpServerDialog } from '../components/McpServerDialog';
import { McpToolRow, toolGroup } from '../components/McpToolRow';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';

export function McpSettings() {
  const [metadataServer,setMetadataServer]=useState<ManagedServer>();
  const [servers, setServers] = useState<ManagedServer[]>([]);
  const [tools, setTools] = useState<ManagedTool[]>([]);
  const [editing, setEditing] = useState<ManagedServer | null | undefined>();
  const [removing, setRemoving] = useState<ManagedServer>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function refresh() {
    const result = await window.mcp.list(); setServers(result.servers); setTools(result.tools);
  }
  useEffect(() => { let active = true; void window.mcp.list().then(result => { if (active) { setServers(result.servers); setTools(result.tools); } }).catch(() => { if (active) setError('Could not load MCP servers.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function act(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); await refresh(); }
    catch { setError('MCP action failed. Check the server configuration and try again.'); }
    finally { setBusy(false); }
  }
  function toggle(id: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return <section className="space-y-7" aria-labelledby="mcp-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1"><h2 id="mcp-heading" className="text-2xl font-semibold tracking-tight">MCP servers & tools</h2><p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">Connect tools for your AI to use. Credentials are stored securely on this computer. Review each tool before allowing it to run.</p></div>
      <button disabled={busy} onClick={() => setEditing(null)} className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"><Plus size={16} />Add server</button>
    </div>
    <PlatformAccessSetting />
    <Dialog open={!!metadataServer} onOpenChange={open=>{if(!open)setMetadataServer(undefined);}}><DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl"><DialogTitle>{metadataServer?.config.name} guidance & changes</DialogTitle><DialogDescription>Instructions and tool metadata supplied by this MCP server.</DialogDescription>{metadataServer&&<McpMetadataHistory server={metadataServer.id}/>}</DialogContent></Dialog>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading servers…</p>}
    {!loading && servers.length === 0 && !error && <p className="text-sm text-muted-foreground">No MCP servers yet. Add a server to get started.</p>}
    {servers.map(server => {
      const builtin = server.config.command === 'built-in';
      const serverTools = tools.filter(tool => tool.server_id === server.id);
      const groups = ['Account', 'Portfolio', 'Market data', 'Watchlists', 'Tools'].map(name => ({ name, tools: serverTools.filter(tool => toolGroup(tool, builtin) === name) })).filter(group => group.tools.length);
      const open = !collapsed.has(server.id);
      return <section key={server.id} className="rounded-3xl border border-border/60 bg-card p-3 sm:p-5">
        <div className="flex items-center gap-3 px-1 py-2">
          <button aria-label={`${open ? 'Collapse' : 'Expand'} ${server.config.name}`} aria-expanded={open} aria-controls={`mcp-${server.id}`} onClick={() => toggle(server.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-ring">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold">{server.config.name.charAt(0).toUpperCase()}</span>
            <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="break-words row-title">{server.config.name}</span>{builtin && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Built-in</span>}<ChevronRight size={14} className={`text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} /></span><span className={`mt-0.5 flex items-center gap-1.5 text-xs ${server.enabled ? 'text-success' : 'text-muted-foreground'}`}><span className={`size-1.5 rounded-full ${server.enabled ? 'bg-success' : 'bg-muted-foreground'}`} />{server.enabled ? 'Enabled' : 'Disabled'}</span></span>
          </button>
          <Switch.Root aria-label={`Enable ${server.config.name}`} checked={server.enabled} disabled={busy} onCheckedChange={enabled => void act(() => window.mcp.enable(server.id, enabled))} className="inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-muted p-1 data-checked:bg-success disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"><Switch.Thumb className="size-5 rounded-full bg-foreground transition-transform data-checked:translate-x-5 data-checked:bg-background" /></Switch.Root>
        </div>
        {open && <div id={`mcp-${server.id}`}>
          {server.config.oauth&&<McpOAuthControls id={server.id} onConnected={refresh}/>}
          <label className="flex flex-wrap items-center justify-between gap-3 px-2 py-3 text-sm">Server policy<Select id={`server-policy-${server.id}`} ariaLabel={`${server.config.name} server policy`} value={server.policy} disabled={busy} onValueChange={value=>void act(()=>window.mcp.serverPolicy(server.id,value as ToolPolicy))} className="w-44" items={[{value:'allowed',label:'Allowed'},{value:'ask',label:'Ask each time'},{value:'blocked',label:'Blocked'}]}/></label>
          <p className="px-2 text-xs text-muted-foreground">Applies to every tool on this server. Restrictions on individual tools and Takes still apply. Review new tools before using them.</p>
          {!builtin && <label className="flex items-start justify-between gap-4 px-2 pt-4 text-sm"><span><span className="block">Keep my settings when this server updates its tools</span><span className="mt-0.5 block text-xs text-muted-foreground">For an MCP you build or fully trust. A changed tool stays as you set it instead of being blocked; Settings still shows what changed.</span></span>
            <Switch.Root aria-label={`Keep settings when ${server.config.name} updates its tools`} checked={!!server.trust_updates} disabled={busy} onCheckedChange={trusted => void act(() => window.mcp.trustUpdates(server.id, trusted))} className="inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-muted p-0.5 data-checked:bg-success disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"><Switch.Thumb className="size-5 rounded-full bg-foreground transition-transform data-checked:translate-x-4 data-checked:bg-background" /></Switch.Root></label>}
          {!builtin && <div className="space-y-3 px-2 py-3"><p className="break-all font-mono text-xs text-muted-foreground">{server.config.transport === 'http' ? server.config.url : server.config.command}</p><div className="flex flex-wrap gap-4 text-xs text-muted-foreground"><button disabled={busy} className="hover:text-foreground" onClick={() => void act(() => window.mcp.discover(server.id))}>Refresh tools</button><button disabled={busy} className="hover:text-foreground" onClick={()=>setMetadataServer(server)}>Guidance & changes</button><button disabled={busy} className="hover:text-foreground" onClick={() => setEditing(server)}>Configure</button><button disabled={busy} className="hover:text-destructive" onClick={() => setRemoving(server)}>Remove</button></div></div>}
          {groups.map(group => <div key={group.name} className="mt-5"><h4 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">{group.name}</h4>{group.tools.map(tool => <McpToolRow key={tool.name} tool={tool} busy={busy} onPolicy={policy => void act(() => window.mcp.policy(server.id, tool.name, policy))} />)}</div>)}
          {!serverTools.length && <p className="px-2 py-4 text-xs text-muted-foreground">Refresh tools to discover what this server provides. New tools are blocked until reviewed.</p>}
        </div>}
      </section>;
    })}
    {editing !== undefined && <McpServerDialog server={editing ?? undefined} onSaved={refresh} onClose={() => { setEditing(undefined); void refresh().catch(() => {}); }} />}
    {removing && <Dialog open onOpenChange={open => { if (!open && !busy) setRemoving(undefined); }}><DialogContent><DialogTitle>Remove {removing.config.name}?</DialogTitle><DialogDescription>{removing.config.oauth?'This server’s saved sign-in will be removed from this device.':'Saved credentials will remain in SecretStore.'}</DialogDescription><div className="flex justify-end gap-3"><button disabled={busy} onClick={() => setRemoving(undefined)}>Cancel</button><button disabled={busy} className="rounded-full bg-destructive px-4 py-2 text-destructive-foreground" onClick={() => void act(async () => { await window.mcp.remove(removing.id); setRemoving(undefined); })}>Remove server</button></div></DialogContent></Dialog>}
  </section>;
}
