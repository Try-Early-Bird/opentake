import type { AiModel } from './ai-models';

// Neither OpenCode Zen nor OpenRouter reports popularity, so the picker features
// one flagship per family, in priority order. New versions appear without code
// changes; flash/mini/code, :free and :batch variants stay in the full list.
// Claude and OpenAI models have their own providers, so they are not featured.
export const featuredLimit = 5;

// OpenRouter: the newest match by `created` (version numbers mislead: Grok 4.20
// is older than 4.7).
const openRouterFamilies: RegExp[] = [
  /^google\/gemini-\d+(?:\.\d+)*-pro(?:-preview)?$/,
  /^x-ai\/grok-\d+(?:\.\d+)*$/,
  /^deepseek\/deepseek-v\d+(?:\.\d+)*-pro(?:-\d{4})?$/,
  /^moonshotai\/kimi-k\d+(?:\.\d+)*$/,
  /^z-ai\/glm-\d+(?:\.\d+)*$/,
  /^qwen\/qwen\d+(?:\.\d+)*-max(?:-\d{4})?$/,
  /^minimax\/minimax-m\d+(?:\.\d+)*$/,
];
export function featuredOpenRouterModels(models: AiModel[]): AiModel[] {
  const featured: AiModel[] = [];
  for (const pattern of openRouterFamilies) {
    let best: AiModel | undefined;
    for (const model of models) if (pattern.test(model.value) && !model.disabled && (!best || (model.created ?? 0) > (best.created ?? 0))) best = model;
    if (best) featured.push(best);
    if (featured.length === featuredLimit) break;
  }
  return featured;
}

// OpenCode Zen gives every model the same `created`, so the highest version wins.
const zenFamilies: RegExp[] = [
  /^gemini-(\d+(?:\.\d+)*)-pro$/,
  /^grok-(\d+(?:\.\d+)*)$/,
  /^deepseek-v(\d+(?:\.\d+)*)-pro$/,
  /^kimi-k(\d+(?:\.\d+)*)$/,
  /^glm-(\d+(?:\.\d+)*)$/,
  /^qwen(\d+(?:\.\d+)*)-plus$/,
  /^minimax-m(\d+(?:\.\d+)*)$/,
];
const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
export function featuredZenModels(models: AiModel[]): AiModel[] {
  const featured: AiModel[] = [];
  for (const pattern of zenFamilies) {
    let best: { model: AiModel; version: string } | undefined;
    for (const model of models) {
      const version = pattern.exec(model.value)?.[1];
      if (version && !model.disabled && (!best || newer(version, best.version))) best = { model, version };
    }
    if (best) featured.push(best.model);
    if (featured.length === featuredLimit) break;
  }
  return featured;
}
