import type { ChatBudgets, ChatUsage } from '../shared/chat-usage';
import type { ModelProvider } from '../shared/ai-models';
import { RunLimitError } from './run-budget';
/** A stop at a threshold the member set in Settings → AI settings, so the chat can offer to raise it. */
export class BudgetLimitError extends RunLimitError {}
// Reported usage boundaries only: these are stopping thresholds, not billing
// caps or provider max_tokens. Never infer missing counters or prices.
export function usageBudgetError(provider:ModelProvider,settings:ChatBudgets|undefined,usage:ChatUsage):Error|undefined {
 if(settings?.requireCompleteUsage&&usage.incomplete)
  return new BudgetLimitError('The provider reported incomplete usage, so the token limit could not be checked. The run was stopped.');
 if(settings?.outputTokens!=null&&usage.outputTokens!=null&&usage.outputTokens>=settings.outputTokens)
  return new BudgetLimitError('Response reached its reported output-token threshold. The last model call may have exceeded it.');
 // The stored OpenCode cost threshold covers every paid OpenCode-run provider.
 if((provider==='opencode'||provider==='openrouter')&&settings?.opencodeCostUsd!=null&&usage.costKind==='provider-reported'&&usage.costUsd!=null&&usage.costUsd>=settings.opencodeCostUsd)
  return new BudgetLimitError('Response reached its OpenCode reported-cost threshold. The last model call may have exceeded it.');
}
