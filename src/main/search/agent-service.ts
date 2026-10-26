import { SearchMaintenanceError, createSearchPreviews } from './previews';
import { savedSearchSourceSchema, type SavedSearchSource } from '../../shared/saved-search';
import type { createSavedScreens } from './saved-screens';
import { managedScreenerTool, screenerSpecsTool, ScreenerError } from './screener-tools';
import type { createRobinhoodScreening } from './robinhood-screening';
import { restrictPolicies } from '../tool-governance';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentExecutor } from '../take-runtime';
import type { ModelProvider, ModelResult } from '../../shared/ai-models';
import type { ChatBudgets } from '../../shared/chat-usage';
import type { SearchAgentApproval } from '../../shared/search-agent';
import type { createAiAudit } from '../ai-audit';
import type { SearchSettings } from '../../shared/search-settings';
import type { SearchAdapter } from './service';
import { bounded } from './service';
import { createRunCapabilities } from '../run-capabilities';
import { chatAdapterIds } from '../chat-executors';
import { createSearchAgentRunner } from './agent-runner';
import { searchAgentInstructions, type SearchAgentContext, type SearchToolPolicy } from './agent-context';

const builtin = '00000000-0000-4000-8000-000000000001';
const querySchema = z.object({ query: z.string().trim().min(1).max(64) }).strict();
const definition = { name: 'robinhood_search', description: 'Look up Robinhood equities and crypto currency pairs by ticker or name. Returns at most 20 of each. Discovery does not establish account trading eligibility. This is not a full-universe screener.',
  inputSchema: { type: 'object' as const, properties: { query: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['query'], additionalProperties: false } };
type Policy = { server: string; name: string; fingerprint: string; revision: number; policy: 'allowed' | 'ask' | 'blocked' };
export function createSearchAgentService(deps: {
  settings(): Promise<SearchSettings>; models(provider: ModelProvider): Promise<ModelResult>;
  policies(): Promise<Policy[]>; budgets(): Promise<ChatBudgets>; audit: ReturnType<typeof createAiAudit>;
  sharing(): Promise<{ verify: boolean; revision: number; scope: string }>;
  savedScreens?: ReturnType<typeof createSavedScreens>;
  screening?: ReturnType<typeof createRobinhoodScreening>;
  adapter: SearchAdapter; execute: AgentExecutor; port(): number;
}) {
  const imports = createSearchPreviews<unknown>();
  const recoveries = createSearchPreviews<{ candidate: { scope: import('./managed-scans').ManagedScanScope; id: string; title: string }; policy: string }>();
  let generation = 0;
  async function recoveryPolicy() {
    const settings = await deps.settings();
    const entries = await deps.policies();
    const required = [managedScreenerTool.name, 'robinhood_get_scans'].map(name => entries.find(p => p.server === builtin && p.name === name));
    if (required.some(p => !p) || restrictPolicies(settings.permissions.marketData, settings.permissions.managedScreeners, ...required.map(p => p!.policy)) === 'blocked') throw new SearchMaintenanceError('Screener recovery is blocked by current search or server permissions.');
    // The Settings buttons explicitly consent to read/check and then local adoption.
    // Recovery never sends data to an AI provider or modifies a remote screener.
    return JSON.stringify({ generation, permissions: settings.permissions, entries: required, sharing: await deps.sharing() });
  }
  const completedDefinitions = new Map<string, SavedSearchSource>();
  const live = new Map<string, { signal: AbortSignal; call(name: string, input: unknown): Promise<unknown>; context: SearchAgentContext }>();
  const capabilities = createRunCapabilities(id => !!live.get(id) && !live.get(id)!.signal.aborted);
  const approvals = new Map<string, { run: string; value: SearchAgentApproval; decide(value: boolean): void }>();
  const sharing = new Map<string, { revision: number; scope: string; verified: boolean }>();
  async function approval(context: SearchAgentContext, title: string, detail: string, signal: AbortSignal) {
    signal.throwIfAborted(); const id = randomUUID();
    await deps.audit.record(context.id, { kind: 'approval.requested', spanId: id, payload: { title, detail } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    let decision = false;
    try {
      decision = await new Promise<boolean>(resolve => {
        abort = () => resolve(false);
        approvals.set(id, { run: context.id, value: { id, title, detail }, decide: resolve });
        timer = setTimeout(abort, 120_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted(); return decision;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); approvals.delete(id);
      await deps.audit.record(context.id, { kind: 'approval.decided', spanId: id, payload: { approved: decision && !signal.aborted } });
    }
  }
  const definitions = [definition, ...(deps.screening ? [screenerSpecsTool, managedScreenerTool] : [])];
  const policies = async (): Promise<SearchToolPolicy[]> => {
    const all = (await deps.policies()).filter(p => p.server === builtin);
    const settings = await deps.settings();
    return definitions.flatMap(tool => {
      const required = tool.name === managedScreenerTool.name ? [tool.name, screenerSpecsTool.name, 'robinhood_get_scans', 'robinhood_run_scan'] : [tool.name];
      const entries = required.map(name => all.find(p => p.name === name));
      if (entries.some(p => !p)) return [];
      return [{ name: tool.name, source: 'robinhood', scope: tool.name === managedScreenerTool.name ? 'managedScreeners' as const : 'marketData' as const,
        fingerprint: JSON.stringify(entries.map(p => [p!.name, p!.revision, p!.fingerprint])),
        policy: restrictPolicies(...entries.map(p => p!.policy), settings.permissions.marketData) }];
    });
  };
  const runner = createSearchAgentRunner({
    settings: deps.settings, tools: policies, budgets: deps.budgets, audit: deps.audit,
    adapter: context => context.replay ? 'saved-screen' : chatAdapterIds[context.selection.provider],
    available: async context => {
      if (context.sources.some(source => source !== deps.adapter.id)) return false;
      if (context.replay) return !!deps.screening && context.replay.sources.length === 1 && context.replay.sources[0].scope.venue === deps.adapter.id && (await deps.adapter.status()).connected;
      const catalog = await deps.models(context.selection.provider);
      return catalog.ok && catalog.models.some(model => model.value === context.selection.model && !model.disabled && (!context.selection.effort || model.effortLevels?.includes(context.selection.effort)))
        && (await deps.adapter.status()).connected;
    },
    authorize: async (context, signal) => {
      signal.throwIfAborted();
      if (!(await deps.adapter.status()).connected) throw new SearchMaintenanceError('Search venue disconnected.');
      const current = await deps.sharing(); const previous = sharing.get(context.id);
      if (previous && (previous.scope !== current.scope || previous.revision !== current.revision)) throw new SearchMaintenanceError('Platform-sharing scope changed.');
      if (!context.replay && current.verify && !previous?.verified) {
        const allowed = await approval(context, 'Share market data with search AI?', `Allow ${context.selection.provider} to receive market lookup data from ${deps.adapter.label} for this search.`, signal);
        if (!allowed) throw new SearchMaintenanceError('Platform sharing declined.');
        const latest = await deps.sharing();
        if (latest.scope !== current.scope || latest.revision !== current.revision) throw new SearchMaintenanceError('Platform-sharing scope changed.');
      }
      sharing.set(context.id, { revision: current.revision, scope: current.scope, verified: current.verify });
      await deps.audit.record(context.id, { kind: 'platform.authorized', payload: { ...current, provider: context.replay ? 'none' : context.selection.provider } });
    },
    approve: (context, tool, signal) => approval(context, tool === managedScreenerTool.name ? 'Allow search to manage a Robinhood screener?' : 'Allow market lookup?', tool === managedScreenerTool.name ? 'Create or update the saved Robinhood screener owned by Opentake search, then run it. This permission applies to this request only.' : `Allow ${tool} for this search request.`, signal),
    dispatch: async (context, name, input, signal, authorize) => {
      if (name === managedScreenerTool.name && deps.screening) {
        completedDefinitions.delete(context.id);
        return deps.screening.screen(input, signal, authorize, context.replay?.sources[0]);
      }
      if (name === screenerSpecsTool.name && deps.screening) { z.object({}).strict().parse(input); return deps.screening.specs(signal, authorize); }
      if (name !== definition.name) throw new SearchMaintenanceError('Search tool unavailable.');
      const { query } = querySchema.parse(input);
      const result = await bounded(child => deps.adapter.lookup(query, child), signal, 15_000);
      const current = await deps.sharing(); const previous = sharing.get(context.id);
      if (!previous || previous.scope !== current.scope || previous.revision !== current.revision || !(await deps.adapter.status()).connected) throw new SearchMaintenanceError('Platform-sharing scope changed.');
      return result;
    },
    accepted: (context, name, result) => {
      if (name !== managedScreenerTool.name) return;
      const parsed = savedSearchSourceSchema.safeParse((result as { validated?: unknown })?.validated);
      if (!parsed.success || context.sources.length !== 1 || context.sources[0] !== parsed.data.scope.venue) return;
      completedDefinitions.set(context.id, parsed.data);
      while (completedDefinitions.size > 32) completedDefinitions.delete(completedDefinitions.keys().next().value!);
    },
    execute: async runtime => {
      if (runtime.context.replay) {
        await runtime.call(managedScreenerTool.name, runtime.context.replay.sources[0].definition);
        runtime.text('Saved filters rerun against current market data. No AI call was made.');
        return;
      }
      const context = runtime.context;
      live.set(context.id, runtime);
      const grant = capabilities.issue(context.id, 'search');
      let text = '';
      try {
        await deps.execute({ id: context.id, selection: context.selection, instructions: runtime.instructions + (deps.screening ? '\nFor screening, fetch current filter specs, then call robinhood_search_screen with the complete filter set and explicit sorting. Never omit an unsupported condition or substitute ticker lookup for a full screen. PERCENTAGE values use percent numbers (5 means 5%). Respect total/omitted/truncated counts and report venue coverage. A failed or cancelled write may already have changed the search-owned saved screener. Do not retry an unresolved create.' : '\nOnly ticker/company lookup is currently supported. Explain that broad screens and filtering metrics are not available; do not claim completeness.'),
          signal: runtime.signal, audit: runtime.audit, managedBudget: true, budgets: runtime.budgets,
          gateway: { port: deps.port(), token: grant.token },
          messages: [{ id: randomUUID(), parentId: null, role: 'user', text: context.question, images: [], createdAt: new Date().toISOString(), selection: context.selection, state: 'completed', tools: [] }],
          image: async () => { throw new SearchMaintenanceError('Search images unavailable.'); }, tool: () => {},
          text: (value, replace) => { text = replace ? value : text + value; runtime.text(text); },
        });
      } finally { grant.revoke(); live.delete(context.id); sharing.delete(context.id); }
    },
  });
  return {
    authorize: capabilities.authorize,
    has: (id: string) => live.has(id),
    async gateway(method: string, id: string, name?: string, input?: unknown) {
      const runtime = live.get(id); if (!runtime || runtime.signal.aborted) throw new SearchMaintenanceError('Search run stopped.');
      if (method === 'gateway:instructions') return searchAgentInstructions;
      if (method === 'gateway:list') return definitions.filter(tool => runtime.context.tools.some(t => t.name === tool.name));
      if (method !== 'gateway:call') throw new SearchMaintenanceError('Search operation unavailable.');
      try {
        const result = await runtime.call(String(name), input);
        // Local account IDs and replay metadata are host-only, not model context.
        const { validated: _validated, ...visible } = result as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(visible) }] };
      }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof ScreenerError ? error.message : 'Search tool unavailable, not approved, cancelled, or its saved screener needs attention. Do not claim results or retry an uncertain creation.' }] }; }
    },
    async exportBackup() { if (!deps.savedScreens) throw new SearchMaintenanceError('Saved screens unavailable.'); return deps.savedScreens.exportBackup(); },
    async previewBackup(value: unknown, owner: string) {
      if (!deps.savedScreens) throw new SearchMaintenanceError('Saved screens unavailable.');
      const result = await deps.savedScreens.previewBackup(value);
      return { token: imports.issue(owner, result.backup), screens: result.screens, skipped: result.skipped };
    },
    async importBackup(token: unknown, owner: string) {
      if (!deps.savedScreens) throw new SearchMaintenanceError('Saved screens unavailable.');
      return deps.savedScreens.importBackup(imports.take(token, owner));
    },
    async previewRecovery(owner: string) {
      if (!deps.screening) throw new SearchMaintenanceError('Screener recovery unavailable.');
      const policy = await recoveryPolicy();
      const authorize = async () => { if (await recoveryPolicy() !== policy) throw new SearchMaintenanceError('Search permissions or account changed. Check recovery again.'); };
      const result = await deps.screening.recover(authorize);
      await authorize();
      if (result.status !== 'ready') return { status: result.status };
      const candidate = { scope: result.scope, id: result.id, title: result.title };
      return { status: 'ready' as const, id: result.id, title: result.title, token: recoveries.issue(owner, { candidate, policy }) };
    },
    async confirmRecovery(token: unknown, owner: string) {
      if (!deps.screening) throw new SearchMaintenanceError('Screener recovery unavailable.');
      const { candidate, policy } = recoveries.take(token, owner);
      const authorize = async () => { if (await recoveryPolicy() !== policy) throw new SearchMaintenanceError('Search permissions or account changed. Check recovery again.'); };
      await deps.screening.recover(authorize, candidate);
    },
    async saved() { if (!deps.savedScreens) throw new SearchMaintenanceError('Saved screens unavailable.'); return deps.savedScreens.list(); },
    async save(id: unknown, title: unknown, owner: string, venues?: unknown) {
      if (!deps.savedScreens) throw new SearchMaintenanceError('Saved screens unavailable.');
      const run = z.uuid().parse(id), snapshot = runner.snapshot(run, owner);
      const source = completedDefinitions.get(run);
      if (snapshot.state !== 'completed' || !snapshot.screening || !source || snapshot.replay) throw new SearchMaintenanceError('Complete a new screen before saving it.');
      const selected = z.array(z.string().min(1).max(100)).length(1).parse(venues ?? snapshot.sources);
      if (selected[0] !== source.scope.venue) throw new SearchMaintenanceError('Run a new screen for the selected venue before saving it.');
      return deps.savedScreens.save({ originRunId: run, title: z.string().trim().min(1).max(120).parse(title),
        question: snapshot.question, selection: snapshot.selection, sources: [source] });
    },
    async removeSaved(id: unknown) { if (!deps.savedScreens) throw new SearchMaintenanceError('Saved screens unavailable.'); await deps.savedScreens.remove(id); },
    async replay(id: unknown, owner: string) {
      if (!deps.savedScreens || !deps.screening) throw new SearchMaintenanceError('Saved screens unavailable.');
      const saved = await deps.savedScreens.get(id);
      const run = await runner.start({ question: saved.question, sources: [...new Set(saved.sources.map(source => source.scope.venue))] }, owner, saved);
      void runner.settled(run, owner).finally(() => sharing.delete(run));
      return run;
    },
    async start(request: unknown, owner: string) {
      const id = await runner.start(request, owner);
      void runner.settled(id, owner).finally(() => sharing.delete(id));
      return id;
    },
    snapshot(id: unknown, owner: string) {
      const key = z.uuid().parse(id); const snapshot = runner.snapshot(key, owner);
      return { ...snapshot, canSave: !!deps.savedScreens && snapshot.state === 'completed' && !!snapshot.screening && !snapshot.replay && completedDefinitions.has(key), approvals: [...approvals.values()].filter(a => a.run === key).map(a => a.value) };
    },
    stop(id: unknown, owner: string) { return runner.stop(z.uuid().parse(id), owner); },
    async decide(id: unknown, key: unknown, value: unknown, owner: string) {
      const run = z.uuid().parse(id); runner.snapshot(run, owner);
      const item = approvals.get(z.uuid().parse(key)); if (!item || item.run !== run) throw new SearchMaintenanceError('Search approval expired.');
      item.decide(z.boolean().parse(value)); approvals.delete(item.value.id);
    },
    cancelAll: async () => { generation++; imports.clear(); recoveries.clear(); await runner.cancelAll(); completedDefinitions.clear(); }, close: async () => { generation++; imports.clear(); recoveries.clear(); await runner.close(); completedDefinitions.clear(); },
  };
}
