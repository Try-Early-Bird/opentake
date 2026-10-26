import { test, expect } from 'vitest';
import { featuredOpenRouterModels, featuredZenModels } from '../../src/shared/featured-models';

const catalog = (entries: [string, number][]) => entries.map(([value, created]) => ({ value, label: value, created }));
test('features the newest flagship per family by creation date, excluding Claude, OpenAI and variants', () => {
  const models = catalog([['anthropic/claude-sonnet-5.5', 9], ['openai/gpt-6.1-sol', 9], ['google/gemini-3.8-flash', 9], ['google/gemini-3.1-pro-preview', 5],
    ['google/gemini-2.5-pro', 2], ['google/gemini-3.1-pro-preview:batch', 5], ['x-ai/grok-4.7', 8], ['x-ai/grok-4.20', 6], ['x-ai/grok-build-0.1', 9],
    ['deepseek/deepseek-v4-pro', 3], ['deepseek/deepseek-v4-pro-0813', 7], ['deepseek/deepseek-v4.1-flash', 9], ['moonshotai/kimi-k3', 8],
    ['moonshotai/kimi-k2.7-code', 9], ['z-ai/glm-5.3', 8], ['z-ai/glm-5.3-prime', 9], ['qwen/qwen3.8-max-0902', 8]]);
  // Grok 4.20 has the larger number but is older than 4.7.
  expect(featuredOpenRouterModels(models).map(m => m.value)).toEqual(['google/gemini-3.1-pro-preview', 'x-ai/grok-4.7', 'deepseek/deepseek-v4-pro-0813', 'moonshotai/kimi-k3', 'z-ai/glm-5.3']);
});
test('falls back to later families when one is missing, and skips disabled models', () => {
  const models = [...catalog([['x-ai/grok-4.7', 1], ['moonshotai/kimi-k3', 1], ['z-ai/glm-5.3', 1], ['qwen/qwen3.8-max-0902', 1], ['minimax/minimax-m3', 1]]),
    { value: 'google/gemini-3.1-pro-preview', label: 'g', created: 1, disabled: true }];
  expect(featuredOpenRouterModels(models).map(m => m.value)).toEqual(['x-ai/grok-4.7', 'moonshotai/kimi-k3', 'z-ai/glm-5.3', 'qwen/qwen3.8-max-0902', 'minimax/minimax-m3']);
});

test('Zen features the highest-version flagship per family', () => {
  const ids = ['claude-opus-5-5', 'gpt-6.1-sol', 'gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-3-pro', 'grok-4.7', 'grok-4.6', 'grok-build-0.1',
    'deepseek-v4.1-flash', 'deepseek-v4-pro', 'kimi-k2.7-code', 'kimi-k3', 'glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'qwen3.6-plus', 'minimax-m3'];
  expect(featuredZenModels(ids.map(value => ({ value, label: value }))).map(m => m.value)).toEqual(['gemini-3.1-pro', 'grok-4.7', 'deepseek-v4-pro', 'kimi-k3', 'glm-5.3']);
});
