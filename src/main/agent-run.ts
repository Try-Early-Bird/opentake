import type { ChatSelection } from '../shared/chat';
import type { ChatBudgets, ChatUsage } from '../shared/chat-usage';
import { createAiAudit, type AuditSink } from './ai-audit';
import { createRunBudget, type RunBudget, type RunLimits } from './run-budget';
import { createUsageCollector } from './chat-usage';
import { usageBudgetError } from './usage-budget';

export type AgentRunContext =
  | { feature: 'chat'; operation: 'respond'; sourceRef: string }
  | { feature: 'search'; operation: 'search' }
  | { feature: 'search'; operation: 'replay'; sourceRef: string }
  | { feature: 'rule'; operation: 'respond'; sourceRef: string };

// Shared lifecycle only. The caller supplies mandatory authorization and cleanup;
// neither a feature nor a provider adapter can skip authorization here.
export async function executeAgentRun(input: {
  id: string; context: AgentRunContext; selection: ChatSelection;
  adapter: string; configuration: Record<string, unknown>; signal: AbortSignal;
  budgets?: ChatBudgets; usage?: (value: ChatUsage) => void; limits?: RunLimits;
}, dependencies: {
  audit: ReturnType<typeof createAiAudit>;
  budgets: Map<string, RunBudget>;
  authorize: (budget: RunBudget) => Promise<void>;
  execute: (runtime: { signal: AbortSignal; audit: AuditSink }) => Promise<void>;
  cleanup: () => Promise<void>;
}) {
  input.signal.throwIfAborted();
  const replay = input.context.operation === 'replay';
  await dependencies.audit.start({ runId: input.id, ...input.context,
    provider: replay ? 'none' : input.selection.provider, model: replay ? 'none' : input.selection.model, adapter: input.adapter,
    adapterVersion: '1', context: input.configuration });
  const usage = replay ? null : createUsageCollector(input.selection.provider);
  const budget = createRunBudget(input.signal, input.limits);
  dependencies.budgets.set(input.id, budget);
  let state: 'completed' | 'failed' = 'failed';
  let stage = 'platform_verification';
  try {
    await dependencies.authorize(budget);
    budget.signal.throwIfAborted();
    stage = replay ? 'saved_screen_replay' : 'provider_execution';
    await dependencies.execute({ signal: budget.signal, audit: async event => {
      await dependencies.audit.record(input.id, event);
      const value = usage?.observe(event);
      if (value) {
        input.usage?.(value);
        const exceeded = usageBudgetError(input.selection.provider, input.budgets, value);
        if (exceeded) budget.cancel(exceeded);
      }
    } });
    budget.signal.throwIfAborted();
    state = 'completed';
  } catch (error) {
    await dependencies.audit.record(input.id, { kind: 'execution.error', status: 'omitted',
      note: 'Raw exceptions are not retained.', payload: { stage, cancelled: input.signal.aborted } });
    throw budget.signal.aborted ? budget.signal.reason : error;
  } finally {
    budget.cancel(); budget.finish(); dependencies.budgets.delete(input.id);
    try { if (usage) input.usage?.(usage.finish(state === 'completed')); }
    finally {
      try { await dependencies.cleanup(); }
      finally { await dependencies.audit.finish(input.id, input.signal.aborted ? 'cancelled' : state); }
    }
  }
}
