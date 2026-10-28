import { useEffect, useState } from 'react';
import type { ToolAccessRequest } from '../../../../shared/mcp-management';
import { StatusDot } from './StatusDot';
import { builtinToolServer } from '../../../../shared/tool-approval-copy';

type Answer = 'allowed' | 'ask' | 'decline';
const platforms: Record<string, string> = { coinbase: 'Coinbase', robinhood: 'Robinhood' };
/** A tool's name as a member would say it: "coinbase_products_get" is "Coinbase products". */
export function friendlyToolName(name: string) {
  const words = name.split('_').filter(word => word && !['opentake', 'get', 'list', 'read'].includes(word)).map(word => platforms[word] ?? word);
  const label = (words.length ? words : name.split('_')).join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
/** Chat's reason as a clause after the other details. */
function clause(reason: string) {
  const text = reason.trim().replace(/\.$/, '');
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
function outcome(item: ToolAccessRequest) {
  if (item.status === 'declined') return 'Not now · nothing changed';
  if (item.granted === 'ask' && item.policy === 'allowed') return 'Kept asking before each use';
  return `${item.granted === 'ask' ? 'Allowed, asking before each use' : 'Allowed'} · applies from the next reply`;
}

/** Chat asked to use a tool. The member answers whenever they like; nothing
 *  changes until they do, and it applies from the next reply. */
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
  async function decide(item: ToolAccessRequest, answer: Answer) {
    setBusy(item.id); setError('');
    try {
      await window.mcp.decideToolAccess(item.id, answer);
      const granted = answer === 'decline' ? null : answer === 'ask' ? 'ask' : item.policy;
      setItems(rows => rows.map(row => row.id === item.id ? { ...row, status: granted ? 'approved' : 'declined', granted } : row));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your answer. Try again.'); }
    finally { setBusy(undefined); }
  }
  const shown = items.filter(item => item.status !== 'superseded');
  if (!shown.length) return null;
  return <>{shown.map(item => {
    const tool = friendlyToolName(item.toolName);
    const title = item.policy === 'allowed' ? `Chat wants to use ${tool} without asking` : `Chat wants to use ${tool}`;
    const details = [item.readOnly && 'Read only', item.policy === 'ask' && 'asks you before each use', item.serverId !== builtinToolServer && `from ${item.server}`, clause(item.reason)]
      .filter((part): part is string => !!part);
    const tone = item.status === 'pending' ? 'attention' : item.status === 'approved' ? 'success' : 'muted';
    return <aside key={item.id} aria-label={title} className="border-y border-border/60 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><StatusDot tone={tone} />{title}</p>
      <p className="mt-1 pl-3.5 text-xs text-muted-foreground">
        {details.map((part, index) => <span key={index}>{index ? ' · ' : ''}{index ? part : part.charAt(0).toUpperCase() + part.slice(1)}</span>)}
        {' · '}<code className="font-mono text-[11px] text-foreground/80">{item.toolName}</code>
      </p>
      {item.status === 'pending'
        ? <div className="mt-3 flex flex-wrap items-center gap-2 pl-3.5">
            <button type="button" disabled={!!busy} onClick={() => void decide(item, item.policy)} className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-40">Allow</button>
            {item.policy === 'allowed' && <button type="button" disabled={!!busy} onClick={() => void decide(item, 'ask')} className="rounded-full border border-border px-4 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40">Keep asking</button>}
            <button type="button" disabled={!!busy} onClick={() => void decide(item, 'decline')} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">Not now</button>
            <span className="ml-auto text-xs text-muted-foreground">Applies from the next reply</span>
          </div>
        : <p role="status" className="mt-2 pl-3.5 text-xs text-muted-foreground">{outcome(item)}</p>}
      {error && busy === undefined && <p role="alert" className="mt-2 pl-3.5 text-xs text-destructive">{error}</p>}
    </aside>;
  })}</>;
}
