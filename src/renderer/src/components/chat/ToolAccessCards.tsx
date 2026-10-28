import { useEffect, useState } from 'react';
import type { ToolAccessRequest } from '../../../../shared/mcp-management';
import { toolLabel } from '../McpToolRow';
import { StatusDot } from './StatusDot';
import { builtinToolServer } from '../../../../shared/tool-approval-copy';

/** Chat asked to turn on a tool. The member answers whenever they like; nothing
 *  changes until they approve, and it applies from the next reply. */
export function ToolAccessCards({ messageId, running }: { messageId: string; running: boolean }) {
  const [items, setItems] = useState<ToolAccessRequest[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const pending = items.some(item => item.status === 'pending');
  useEffect(() => {
    let live = true;
    const load = () => void window.mcp.toolAccessRequests(messageId).then(rows => { if (live) setItems(rows); }).catch(() => {});
    load();
    // Only while the reply may still file one, or one is open for an answer made elsewhere.
    const timer = running || pending ? setInterval(load, running ? 1000 : 3000) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [messageId, running, pending]);
  async function decide(item: ToolAccessRequest, approved: boolean) {
    setBusy(item.id); setError('');
    try {
      await window.mcp.decideToolAccess(item.id, approved);
      setItems(rows => rows.map(row => row.id === item.id ? { ...row, status: approved ? 'approved' : 'declined' } : row));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your answer. Try again.'); }
    finally { setBusy(undefined); }
  }
  const shown = items.filter(item => item.status !== 'superseded');
  if (!shown.length) return null;
  return <>{shown.map(item => {
    const tool = toolLabel(item.toolName);
    const setting = item.policy === 'allowed' ? 'Chat can use it without asking' : 'Chat asks you before each use';
    return <aside key={item.id} aria-label={`Turn on ${tool}`} className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
      <p className="font-medium">Turn on {tool}?</p>
      <p className="mt-1 text-xs text-muted-foreground">{setting}, from the next reply.{item.serverId !== builtinToolServer ? ` From ${item.server}.` : ''} Chat’s reason: {item.reason}</p>
      {item.status === 'pending'
        ? <div className="mt-2 flex gap-2">
            <button type="button" disabled={!!busy} onClick={() => void decide(item, true)} className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background disabled:opacity-40">Turn on</button>
            <button type="button" disabled={!!busy} onClick={() => void decide(item, false)} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">Not now</button>
          </div>
        : <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><StatusDot tone={item.status === 'approved' ? 'success' : 'muted'} />{item.status === 'approved' ? 'Turned on. Available from the next reply.' : 'Left off.'}</p>}
      {error && busy === undefined && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </aside>;
  })}</>;
}
