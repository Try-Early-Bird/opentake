import { useState, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, ChevronRight, RefreshCw, Search, Settings } from 'lucide-react';
import { featuredOpenRouterModels, featuredZenModels } from '../../../../shared/featured-models';
import { ThinkingEffort } from './ThinkingEffort';
import { ModelSearchDialog } from './ModelSearchDialog';
import { GrokMark, ClaudeMark, LocalModelMark, OpenaiMark, OpencodeMark, OpenrouterMark } from '../ai-provider-marks';
import type { AiConnectionState } from '../../../../shared/ai-connections';
import type { AiModel, ModelProvider, ModelResult, ReasoningEffort } from '../../../../shared/ai-models';

export const providerLabels = { grok: 'Grok', claude: 'Claude', chatgpt: 'ChatGPT', opencode: 'OpenCode Zen', openrouter: 'OpenRouter', local: 'Local model' };
const providerMarks = { grok: GrokMark, claude: ClaudeMark, chatgpt: OpenaiMark, opencode: OpencodeMark, openrouter: OpenrouterMark, local: LocalModelMark };
function ProviderLogo({ provider }: { provider: ModelProvider }) {
  const Mark = providerMarks[provider];
  return <Mark className={`size-4 shrink-0 ${provider === 'claude' ? 'text-[#D97757]' : ''}`} />;
}
const providers: ModelProvider[] = ['claude', 'chatgpt', 'grok', 'opencode', 'openrouter', 'local'];
// Long catalogs show a short featured list; the rest is a search away.
const featuredFor = (id: ModelProvider, models: AiModel[]) => id === 'opencode' ? featuredZenModels(models) : id === 'openrouter' ? featuredOpenRouterModels(models) : [];
// Collapsed provider sections are a per-viewer convenience; storage may be unavailable.
const collapsedKey = 'opentake.ai-picker.collapsed';
function readCollapsed(): ModelProvider[] {
  try { const value = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]'); return Array.isArray(value) ? value.filter((v): v is ModelProvider => providers.includes(v)) : []; }
  catch { return []; }
}
function writeCollapsed(value: ModelProvider[]) { try { localStorage.setItem(collapsedKey, JSON.stringify(value)); } catch { /* Keep the in-memory state. */ } }
const shortLabel = (label: string) => label.replace(/^Claude /, '').replace(/ \(Default\)$/i, '');

export function AiPicker({ provider, model, effort, connections, catalogs, disabled, anchor, onSelect, onRefresh, onConnect, iconOnly = false, onSettings }: {
  iconOnly?: boolean; onSettings?: () => void;
  provider: ModelProvider; model: string; effort?: ReasoningEffort; connections: AiConnectionState[];
  catalogs: Partial<Record<ModelProvider, ModelResult>>; disabled: boolean; anchor: RefObject<HTMLDivElement>;
  onSelect: (provider: ModelProvider, model: string, effort?: ReasoningEffort) => void; onRefresh: () => void; onConnect: (provider: ModelProvider) => void;
}) {
  const [searching, setSearching] = useState<ModelProvider>();
  const [collapsed, setCollapsed] = useState<ModelProvider[]>(readCollapsed);
  const toggle = (id: ModelProvider) => setCollapsed(current => { const next = current.includes(id) ? current.filter(c => c !== id) : [...current, id]; writeCollapsed(next); return next; });
  const connected = (id: ModelProvider) => connections.some(c => c.provider === id && c.status === 'connected');
  const shownModels = (id: ModelProvider, models: AiModel[]) => {
    const featured = featuredFor(id, models);
    if (!featured.length) return models;
    const chosen = provider === id && !featured.some(m => m.value === model) ? models.filter(m => m.value === model) : [];
    return [...featured, ...chosen];
  };
  const searchCatalog = searching ? catalogs[searching] : undefined;
  const catalog = catalogs[provider];
  const selected = catalog?.ok ? catalog.models.find(m => m.value === model) : undefined;
  const selectModel = (id: ModelProvider, value: string) => {
    const result = catalogs[id];
    const target = result?.ok ? result.models.find(m => m.value === value) : undefined;
    onSelect(id, value, effort && target?.effortLevels?.includes(effort) ? effort : undefined);
  };
  const label = selected ? shortLabel(selected.label) : connected(provider) ? (catalog ? 'Choose model' : 'Loading models…') : 'Choose AI';
  const ordered = [...providers.filter(connected), ...providers.filter(id => !connected(id))];
  return <><Menu.Root>
    <Menu.Trigger type="button" disabled={disabled} aria-label={iconOnly ? "Search AI models" : "Choose AI model"} title={selected ? `${providerLabels[provider]} · ${selected.label}` : label}
      className={iconOnly ? "rounded-md p-1.5 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" : "flex min-h-7 max-w-52 items-center justify-between gap-3 rounded-full border-0 bg-muted px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"}>
      {iconOnly ? <Settings size={14} aria-hidden="true" /> : <><span className="flex min-w-0 items-center gap-1.5"><ProviderLogo provider={provider} /><span className="truncate">{label}</span></span><ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" /></>}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner anchor={anchor} side="top" align="end" sideOffset={12} collisionPadding={12} className="z-[100]">
        <Menu.Popup aria-label="AI models" className="flex max-h-[min(28rem,var(--available-height))] w-72 flex-col max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          <div className="min-h-0 overflow-y-auto" data-testid="model-list">
          {onSettings && <Menu.Item onClick={onSettings} className="rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none data-[highlighted]:bg-muted">Search settings</Menu.Item>}
          {ordered.map(id => {
            const result = catalogs[id];
            const open = !collapsed.includes(id);
            return connected(id) ? <Menu.Group key={id} aria-label={providerLabels[id]} className="border-b border-border pb-1 last:border-0">
              <Menu.Item closeOnClick={false} onClick={() => toggle(id)} aria-expanded={open} aria-label={`${providerLabels[id]} models`}
                className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                <span className="flex items-center gap-2 text-muted-foreground">{open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}<ProviderLogo provider={id} />{providerLabels[id]}</span>
                <span className="flex items-center gap-1 text-emerald-500"><span className="size-1 rounded-full bg-current" />Connected</span>
              </Menu.Item>
              {!open ? null : !result ? <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Loading models…</p> : !result.ok ? <p className="px-2 py-2 text-xs text-muted-foreground">{result.message}</p> : !result.models.length ? <p className="px-2 py-3 text-xs text-muted-foreground">No models available. Refresh to retry.</p> :
                <Menu.RadioGroup value={provider === id ? model : ''} onValueChange={value => selectModel(id, String(value))}>
                  {shownModels(id, result.models).map(item => <Menu.RadioItem closeOnClick key={item.value} value={item.value} disabled={item.disabled}
                    label={shortLabel(item.label)} title={[item.resolvedModel, item.description].filter(Boolean).join(' · ')}
                    className="relative flex cursor-default items-center rounded-sm py-2 pr-8 pl-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-40">
                    <span className="min-w-0"><span className="block break-words">{shortLabel(item.label)}</span>{(item.value === 'default' || /\(Default\)$/i.test(item.label)) && <span className="mt-0.5 block text-xs text-muted-foreground">Default</span>}</span>
                    <Menu.RadioItemIndicator className="absolute right-2"><Check size={14} aria-hidden="true" /></Menu.RadioItemIndicator>
                  </Menu.RadioItem>)}
                </Menu.RadioGroup>}
              {open && result?.ok && shownModels(id, result.models).length < result.models.length && <Menu.Item onClick={() => setSearching(id)}
                className="flex items-center gap-2 rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                <Search size={14} aria-hidden="true" />More {providerLabels[id]} models ({result.models.length})
              </Menu.Item>}
            </Menu.Group> : <Menu.Item key={id} onClick={() => onConnect(id)} aria-label={`${id === 'opencode' || id === 'openrouter' ? 'Add key for' : 'Connect'} ${providerLabels[id]}`}
              className="flex items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
              <span className="flex items-center gap-2"><ProviderLogo provider={id} />{providerLabels[id]}</span><span className="text-xs text-muted-foreground">{id === 'opencode' || id === 'openrouter' ? 'Add key' : 'Connect'}</span>
            </Menu.Item>;
          })}
          {providers.some(connected) && <Menu.Item closeOnClick={false} onClick={onRefresh} disabled={providers.some(id => connected(id) && !catalogs[id])}
            className="mt-1 flex w-full items-center gap-2 rounded-sm px-2 py-2 text-xs text-muted-foreground outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-40">
            <RefreshCw size={14} aria-hidden="true" />Refresh models
          </Menu.Item>}
          </div>
          {selected?.effortLevels?.length && !selected.disabled && connected(provider) ? <ThinkingEffort levels={selected.effortLevels} value={effort} disabled={disabled} onChange={value => onSelect(provider, model, value)} /> : null}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
  <ModelSearchDialog open={!!searching && !!searchCatalog?.ok} title={searching ? `${providerLabels[searching]} models` : ''}
    models={searchCatalog?.ok ? searchCatalog.models : []} selected={searching && provider === searching ? model : ''}
    onSelect={value => { if (searching) selectModel(searching, value); }} onClose={() => setSearching(undefined)} /></>;
}
