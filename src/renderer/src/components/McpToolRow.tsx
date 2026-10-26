import { useId, useState } from 'react';
import { ChangedNotice, blockedReasonLabel, shortDate } from './ToolChanges';
import { ChevronRight } from 'lucide-react';
import type { ManagedTool, ToolPolicy } from '../../../shared/mcp-management';
import { Select } from './ui/select';

export function toolLabel(name: string) {
  const label = name.replace(/^(opentake_|robinhood_)/, '').replace(/^get_/, '').replaceAll('_', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
export function toolGroup(tool: ManagedTool, builtin: boolean) {
  if (!builtin) return 'Tools';
  if (/connection_status|list_accounts/.test(tool.name)) return 'Account';
  if (/portfolio|positions|orders|tax_lots|buying_power|balances/.test(tool.name)) return 'Portfolio';
  if (/watchlist/.test(tool.name)) return 'Watchlists';
  return 'Market data';
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function fieldKind(field:Record<string,unknown>){return typeof field.format==='string'?field.format:typeof field.type==='string'?field.type:Array.isArray(field.type)?field.type.join(' | '):Array.isArray(field.enum)?'choice':'value';}

export function McpToolRow({ tool, busy, onPolicy }: { tool: ManagedTool; busy: boolean; onPolicy: (policy: ToolPolicy) => void }) {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState(false);
  const id = useId();
  const schema = tool.definition.inputSchema;
  const properties = object(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const previous = object(tool.previous_definition?.inputSchema.properties);
  const changed = tool.policy === 'blocked' && tool.blocked_reason === 'changed';
  const caption = tool.policy === 'blocked' ? (tool.blocked_reason ? blockedReasonLabel[tool.blocked_reason] : 'Blocked') : '';
  return <div className={`rounded-2xl ${open ? 'bg-muted/40' : ''}`}>
    <div className="flex items-start gap-2 p-3">
      <button aria-expanded={open} aria-controls={`${id}-details`} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-start gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-ring">
        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0"><span className="flex flex-wrap items-baseline gap-x-2"><span className="text-sm font-medium">{toolLabel(tool.name)}</span><code className="break-all text-xs text-muted-foreground/70">{tool.name}</code>{tool.previous_definition && !open && <span className="size-1.5 self-center rounded-full bg-attention" aria-label="Changed since you allowed it" />}</span>
          {tool.definition.description && <span className={`mt-0.5 block text-xs text-muted-foreground ${open ? '' : 'line-clamp-1'}`}>{tool.definition.description}</span>}</span>
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Select id={`${id}-policy`} value={tool.policy} disabled={busy} onValueChange={value => onPolicy(value as ToolPolicy)} className="w-44" items={[{ value: 'allowed', label: 'Allowed' }, { value: 'ask', label: 'Ask each time' }, { value: 'blocked', label: 'Blocked' }]} renderValue={value => <span aria-label={`Permission for ${tool.name}: ${value}`} className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${value === 'allowed' ? 'bg-success' : value === 'ask' ? 'bg-attention' : 'bg-muted-foreground'}`} />{value === 'allowed' ? 'Allowed' : value === 'ask' ? 'Ask each time' : 'Blocked'}</span>} />
        {caption && <span className={`text-[11px] ${changed ? 'text-attention' : 'text-muted-foreground'}`}>{caption}</span>}
      </div>
    </div>
    {open && <div id={`${id}-details`} className="space-y-4 px-4 pb-4 sm:pl-11">
      {changed && <ChangedNotice tool={tool} title={`Changed since you allowed it${tool.changed_at ? ` · ${shortDate(tool.changed_at)}` : ''}`} />}
      {/* A trusted server's tool changed but kept its setting: show the change until it is marked reviewed. */}
      {!changed && tool.previous_definition && <div className="space-y-2"><ChangedNotice tool={tool} title={`Updated since you reviewed it${tool.changed_at ? ` · ${shortDate(tool.changed_at)}` : ''}`} />
        <button type="button" disabled={busy} onClick={() => onPolicy(tool.policy)} className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">Mark reviewed</button></div>}
      <div className="flex items-center justify-between"><h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Inputs</h5><button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setJson(!json)}>{json ? 'Hide definition' : 'Full definition'}</button></div>
      {json ? (tool.previous_definition ? <div className="grid gap-2 sm:grid-cols-2">{[['Before', tool.previous_definition], ['Now', tool.definition]].map(([label, value]) => <div key={label as string}><p className="mb-1 text-xs text-muted-foreground">{label as string}</p><pre className="max-h-64 overflow-auto rounded-xl bg-background/70 p-3 text-xs">{JSON.stringify(value, null, 2)}</pre></div>)}</div>
        : <pre className="max-h-64 overflow-auto rounded-xl bg-background/70 p-3 text-xs">{JSON.stringify(tool.definition, null, 2)}</pre>)
      : Object.keys(properties).length ? <div className="divide-y divide-border border-y border-border">
        {Object.entries(properties).map(([name, raw]) => {
          const field = object(raw);
          const added = !!tool.previous_definition && !(name in previous);
          return <div key={name} className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)_auto] items-baseline gap-3 py-2 text-xs">
            <code className="font-mono">{name}</code>
            <span className="min-w-0 text-muted-foreground">{typeof field.description === 'string' ? field.description : ''}{added && <span className="ml-2 font-medium text-attention">New</span>}</span>
            <span className="text-right text-muted-foreground">{fieldKind(field)}{required.includes(name) ? ' · required' : ''}</span>
          </div>;
        })}
      </div> : <p className="text-xs text-muted-foreground">No inputs.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {tool.policy === 'blocked' ? <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => onPolicy('allowed')} className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background disabled:opacity-50">{tool.blocked_reason === 'changed' ? 'Allow again' : 'Allow'}</button>
          <button type="button" disabled={busy} onClick={() => onPolicy('ask')} className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">Ask each time</button>
        </div> : <span />}
        <span className="text-[11px] text-muted-foreground">{tool.last_used_at ? `Last used ${shortDate(tool.last_used_at)} · ${tool.runs} ${tool.runs === 1 ? 'run' : 'runs'}` : 'Not used yet'}</span>
      </div>
    </div>}
  </div>;
}
