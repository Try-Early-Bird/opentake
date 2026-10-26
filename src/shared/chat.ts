import type { ModelProvider, ModelResult, ReasoningEffort } from './ai-models';
export interface ChatSelection { provider: ModelProvider; model: string; effort?: ReasoningEffort }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; tools?: string[] }
export interface ChatThread { id: string; title: string; messages: ChatMessage[]; running: boolean; selection?: ChatSelection; error?: string }
export interface ChatAPI {
  models(provider: ModelProvider, refresh?: boolean): Promise<ModelResult>;
}
