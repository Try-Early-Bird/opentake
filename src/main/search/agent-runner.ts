import type { SavedScreen } from './saved-screens';
import type { ChatBudgets } from '../../shared/chat-usage';
import type { SearchSettings } from '../../shared/search-settings';
import type { createAiAudit } from '../ai-audit';
import { executeAgentRun } from '../agent-run';
import type { RunBudget } from '../run-budget';
import { createSearchAgentContext, searchAgentInstructions, searchToolPermission, type SearchAgentContext, type SearchToolPolicy } from './agent-context';

import { searchScreeningSchema, type SearchAgentSnapshot } from '../../shared/search-agent';
import { marketHitSchema, marketKey } from '../../shared/search';
// Host-only runner. Tool wiring must supply the shared approval and platform
// verification gates before this can be exposed through renderer RPC.
export function createSearchAgentRunner(deps: {
  settings(): Promise<SearchSettings>;
  tools(): Promise<SearchToolPolicy[]>;
  available(context: SearchAgentContext): Promise<boolean>;
  budgets(): Promise<ChatBudgets>;
  audit: ReturnType<typeof createAiAudit>;
  adapter(context: SearchAgentContext): string;
  authorize(context: SearchAgentContext, signal: AbortSignal): Promise<void>;
  approve(context: SearchAgentContext, tool: string, signal: AbortSignal): Promise<boolean>;
  dispatch(context: SearchAgentContext, tool: string, input: unknown, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown>;
  accepted?(context: SearchAgentContext, tool: string, result: unknown): void;
  execute(input: { budgets: ChatBudgets; context: SearchAgentContext; instructions: string; signal: AbortSignal;
    audit: Parameters<Parameters<typeof executeAgentRun>[1]['execute']>[0]['audit'];
    text(value: string): void; call(name: string, input: unknown): Promise<unknown> }): Promise<void>;
}) {
  let closed = false;
  const budgets = new Map<string, RunBudget>();
  const clients = new Set<string>();
  const runs = new Map<string, { owner: string; controller: AbortController; snapshot: SearchAgentSnapshot; work: Promise<void> }>();
  function owned(id: string, owner: string) {
    const run = runs.get(id);
    if (!run || run.owner !== owner) throw new Error('Search run unavailable.');
    return run;
  }
  return {
    async start(request: unknown, owner: string, replay?: SavedScreen) {
      if (closed) throw new Error('Search is stopped.');
      if (clients.has(owner)) throw new Error('Stop the current search first.');
      if (clients.size >= 4) throw new Error('Search is busy. Try again shortly.');
      clients.add(owner);
      try {
        const settings = await deps.settings();
        const context = createSearchAgentContext(request, replay ? { ...settings, selection: replay.selection } : settings, await deps.tools());
        if (replay) context.replay = structuredClone(replay);
        if (!context.tools.length) throw new Error('No permitted search tools for the selected venues.');
        if (!await deps.available(structuredClone(context))) throw new Error('The selected search AI or venue is unavailable.');
        const limits = await deps.budgets();
        if (closed) throw new Error('Search is stopped.');
        const controller = new AbortController();
        const snapshot: SearchAgentSnapshot = { id: context.id, question: context.question, sources: [...context.sources],
          ...(replay ? { replay: { id: replay.id, title: replay.title } } : {}), selection: { ...context.selection }, state: 'running', text: '', markets: [] };
        // Keep a bounded, transient result list; durable lifecycle lives in AI audit.
        for (const [id, run] of runs) if (runs.size >= 32 && run.snapshot.state !== 'running') runs.delete(id);
        const work = executeAgentRun({ id: context.id, context: replay ? { feature: 'search', operation: 'replay', sourceRef: replay.id } : { feature: 'search', operation: 'search' },
          selection: context.selection, adapter: deps.adapter(context), configuration: { ...context, instructions: searchAgentInstructions },
          signal: controller.signal, budgets: limits }, {
          audit: deps.audit, budgets,
          authorize: async budget => { const resume = budget.pause(); try { await deps.authorize(structuredClone(context), budget.signal); } finally { resume(); } },
          execute: runtime => deps.execute({ budgets: limits, context: structuredClone(context), instructions: searchAgentInstructions, ...runtime,
            text: value => { runtime.signal.throwIfAborted(); snapshot.text = value.slice(0, 32000); },
            call: async (name, input) => {
              const budget = budgets.get(context.id)!;
              const permission = async () => searchToolPermission(context, name, await deps.tools(), await deps.settings());
              budget.signal.throwIfAborted(); budget.toolDispatch();
              let policy = await permission();
              if (policy === 'blocked') throw new Error('Search tool is blocked or its configuration changed.');
              let approved = false;
              if (policy === 'ask') {
                const resume = budget.pause();
                try { approved = await deps.approve(structuredClone(context), name, budget.signal); }
                finally { resume(); }
                if (!approved) throw new Error('Search tool approval declined.');
              }
              const resume = budget.pause();
              try { await deps.authorize(structuredClone(context), budget.signal); } finally { resume(); }
              policy = await permission();
              if (policy === 'blocked' || (policy === 'ask' && !approved)) throw new Error('Search permission changed.');
              budget.signal.throwIfAborted();
              await deps.audit.record(context.id, { kind: 'tool.dispatch_intent', payload: { tool: name } });
              try {
                if (name === 'robinhood_search_screen') { snapshot.screening = undefined; snapshot.markets = []; }
                const result = await deps.dispatch(structuredClone(context), name, input, budget.signal, async () => {
                  budget.signal.throwIfAborted();
                  const current = await permission();
                  if (current === 'blocked' || (current === 'ask' && !approved)) throw new Error('Search permission revoked.');
                  await deps.authorize(structuredClone(context), budget.signal);
                  const latest = await permission();
                  if (latest === 'blocked' || (latest === 'ask' && !approved)) throw new Error('Search permission revoked.');
                  budget.signal.throwIfAborted();
                });
                budget.signal.throwIfAborted();
                const after = await permission();
                if (after === 'blocked' || (after === 'ask' && !approved)) throw new Error('Search permission revoked.');
                await deps.audit.record(context.id, { kind: 'tool.result', payload: { tool: name, result } });
                await deps.audit.record(context.id, { kind: 'tool.finished', payload: { tool: name, state: 'succeeded' } });
                const found = marketHitSchema.array().max(20).safeParse((result as { markets?: unknown })?.markets);
                if (found.success) {
                  const screening = searchScreeningSchema.safeParse((result as { screening?: unknown })?.screening);
                  if (screening.success) { snapshot.screening = screening.data; snapshot.markets = []; }
                  const rows = new Map(snapshot.markets.map(hit => [marketKey(hit), hit]));
                  for (const hit of found.data) if (context.sources.includes(hit.identity.venue)) rows.set(marketKey(hit), hit);
                  snapshot.markets = [...rows.values()].slice(0, 60);
                }
                deps.accepted?.(structuredClone(context), name, result);
                return result;
              } catch (error) {
                await deps.audit.record(context.id, { kind: 'tool.finished', payload: { tool: name, state: 'failed', outcomeKnown: false } });
                throw error;
              }
            },
          }),
          cleanup: async () => {},
        }).then(() => { snapshot.state = 'completed'; }, () => {
          snapshot.state = controller.signal.aborted ? 'cancelled' : 'failed';
          if (snapshot.state === 'failed') snapshot.error = replay ? 'Saved screen could not run. Check its original venue/account, search permissions, and supported filters.' : 'Search could not finish. Check AI, venue, and permission settings.';
        }).finally(() => { clients.delete(owner); });
        runs.set(context.id, { owner, controller, snapshot, work });
        return context.id;
      } catch (error) { clients.delete(owner); throw error; }
    },
    snapshot(id: string, owner: string) { return structuredClone(owned(id, owner).snapshot); },
    async stop(id: string, owner: string) { const run = owned(id, owner); run.controller.abort(new Error('Search cancelled.')); await run.work; },
    async settled(id: string, owner: string) { await owned(id, owner).work; },
    async cancelAll() { for (const run of runs.values()) run.controller.abort(new Error('Search stopped.')); await Promise.all([...runs.values()].map(run => run.work)); },
    async close() { closed = true; for (const run of runs.values()) run.controller.abort(new Error('Host stopped.')); await Promise.all([...runs.values()].map(run => run.work)); runs.clear(); },
  };
}
