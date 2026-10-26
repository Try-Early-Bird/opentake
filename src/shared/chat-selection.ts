import type { AiConnectionState } from './ai-connections';
import type { ModelProvider, ModelResult } from './ai-models';
import type { ChatSelection } from './chat';

/** Keep a usable choice; otherwise prefer the current provider, then connected providers. */
export function availableChatSelection(current: ChatSelection, connections: AiConnectionState[], catalogs: Partial<Record<ModelProvider, ModelResult>>): ChatSelection | undefined {
  const connected = connections.filter(connection => connection.status === 'connected').map(connection => connection.provider);
  // A refresh must not replace an intentional choice while its catalog is loading.
  if (connected.includes(current.provider) && !catalogs[current.provider]) return;
  for (const provider of [current.provider, ...connected.filter(provider => provider !== current.provider)]) {
    if (!connected.includes(provider)) continue;
    const catalog = catalogs[provider];
    if (!catalog?.ok) continue;
    const model = catalog.models.find(model => provider === current.provider && model.value === current.model && !model.disabled)
      ?? catalog.models.find(model => !model.disabled);
    if (model) return { provider, model: model.value, ...(current.effort && model.effortLevels?.includes(current.effort) ? { effort: current.effort } : {}) };
  }
}
