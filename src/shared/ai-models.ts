// 'opencode' is OpenCode Zen. OpenRouter and local models also run through OpenCode.
export type ModelProvider = 'grok' | 'claude' | 'chatgpt' | 'opencode' | 'openrouter' | 'local';
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
// pricing: OpenRouter list prices in USD per million tokens. created: Unix seconds.
export interface AiModel { value: string; label: string; effortLevels?: ReasoningEffort[]; description?: string; resolvedModel?: string; disabled?: boolean; imageInput?: boolean; created?: number; pricing?: { input: number; output: number } }
export type ModelResult = { ok: true; models: AiModel[]; source: 'runtime' | 'catalog' } | { ok: false; message: string };
