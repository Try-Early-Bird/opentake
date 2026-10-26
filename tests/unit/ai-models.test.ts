vi.mock('../../src/main/ai-runtime', () => ({ resolveAiCli: () => ({ executable: '/synthetic/cli', args: [] }) }));
import { test, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelDiscovery, discoverRuntimeModels, parseModels } from '../../src/main/ai-models';
import type { SecretStore } from '../../src/main/secret-store';

const store: SecretStore = { available: () => true, has: async () => true, get: async () => '{"token":"synthetic"}', set: async () => {}, delete: async () => {} };
test('normalizes runtime and catalog models without hidden, duplicate or invalid entries', () => {
  expect(parseModels([{ value: 'a', displayName: 'A' }, { id: 'b', display_name: 'B' }, { id: 'a', name: 'A' }, { id: 'hidden', hidden: true }, { id: '--flag' }])).toEqual([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
});
test('discovery uses connection status, caches results, refreshes and reports safe errors', async () => {
  let connected = false;
  const runtime = vi.fn(async () => [{ value: 'discovered', label: 'Discovered' }]);
  const models = createModelDiscovery(store, '/unused', async () => connected ? [{ provider: 'claude', status: 'connected' }] : [], runtime);
  expect((await models('claude')).ok).toBe(false); expect(runtime).not.toHaveBeenCalled();
  connected = true;
  expect((await models('claude')).ok).toBe(true); await models('claude'); expect(runtime).toHaveBeenCalledTimes(1);
  await models('claude', true); expect(runtime).toHaveBeenCalledTimes(2);
  runtime.mockRejectedValueOnce(new Error('private provider detail'));
  expect(await models('claude', true)).toEqual({ ok: false, message: 'Could not load models. Check your connection and retry.' });
});
test('Zen models come from its catalog without sending credentials', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'zen-model', name: 'Zen model' }] })));
  const models = createModelDiscovery(store, '/unused', async () => [{ provider: 'opencode', status: 'connected' }], undefined, request as typeof fetch);
  expect(await models('opencode')).toEqual({ ok: true, source: 'catalog', models: [{ value: 'zen-model', label: 'Zen model' }] });
  expect(request.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/models');
});
test.each(['claude', 'chatgpt'] as const)('%s discovery only initializes and lists models in an isolated home', async provider => {
  const root = await mkdtemp(join(tmpdir(), 'model-discovery-test-'));
  const script = `const rl = require('readline').createInterface({input:process.stdin});
    rl.on('line', line => { const m = JSON.parse(line);
      if (m.type === 'control_request') console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,response:{models:[{value:'claude-test',displayName:'Claude test'}]}}}));
      else if (m.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
      else if (m.method === 'model/list') console.log(JSON.stringify({id:2,result:{data:[{id:m.params.cursor?'second':'first',displayName:'Model'}],nextCursor:m.params.cursor?null:'next'}}));
      else if (m.method !== 'initialized') process.exit(2);
    });`;
  const launch = ((_exe, _args, options) => {
    expect(options.env.HOME).toContain(root);
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    return spawn(process.execPath, ['-e', script], options);
  }) as typeof spawn;
  try {
    const models = await discoverRuntimeModels(provider, '{"token":"synthetic"}', root, launch);
    expect(models.map(model => model.value)).toEqual(provider === 'claude' ? ['claude-test'] : ['first', 'second']);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude aliases retain resolved names, descriptions and availability', () => {
  expect(parseModels([{ value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-4-6', description: 'Balanced performance' }, { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-4-6', disabled: true }])).toEqual([
    { value: 'sonnet', label: 'Claude Sonnet 4.6', resolvedModel: 'claude-sonnet-4-6', description: 'Balanced performance' },
    { value: 'default', label: 'Claude Opus 4.6 (Default)', resolvedModel: 'claude-opus-4-6', disabled: true },
  ]);
});

test('image capability uses explicit metadata or exact verified IDs, never provider or family guesses',()=>{
 expect(parseModels([{id:'future-model'},{id:'text-model',capabilities:{image_input:{supported:false}}},{id:'vision-model',capabilities:{image_input:{supported:true}}},{value:'opus',resolvedModel:'claude-opus-5-5'},{id:'claude-opus-99'},{id:'claude-opus-5-5',capabilities:{image_input:{supported:false}}}]).map(m=>m.imageInput)).toEqual([undefined,false,true,true,undefined,false]);
});

 test('Codex input modalities explicitly control image support',()=>{
  expect(parseModels([{id:'vision',inputModalities:['text','image']},{id:'text',inputModalities:['text']},{id:'unknown'}]).map(m=>m.imageInput)).toEqual([true,false,undefined]);
 });

test('OpenRouter catalog keeps tool-capable text models with names, dates and per-million prices', async () => {
  const { parseOpenRouterModels } = await import('../../src/main/ai-models');
  const models = parseOpenRouterModels([
    { id: 'x-ai/grok-4.7', name: 'SpaceXAI: Grok 4.7', created: 1790007541, description: 'd', supported_parameters: ['tools', 'temperature'], architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000002', completion: '0.000006' } },
    { id: 'google/gemini-3.1-flash-image', name: 'Image only', supported_parameters: ['temperature'], pricing: { prompt: '0', completion: '0' } },
    { id: 'image/generator', name: 'Images out', supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
    { id: 'qwen/qwen3.8-27b:free', name: 'Qwen free', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
    { id: 'bad id with spaces', supported_parameters: ['tools'] }, null,
  ]);
  expect(models).toEqual([
    { value: 'x-ai/grok-4.7', label: 'SpaceXAI: Grok 4.7', description: 'd', created: 1790007541, pricing: { input: 2, output: 6 } },
    { value: 'qwen/qwen3.8-27b:free', label: 'Qwen free', pricing: { input: 0, output: 0 } },
  ]);
  expect(models.every(m => m.imageInput === undefined)).toBe(true);
});


test('effort discovery preserves only advertised levels in slider order', () => {
  expect(parseModels([
    { id: 'claude', supportedEffortLevels: ['max', 'low', 'high', 'low', 'future'] },
    { id: 'codex', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'medium' }, null] },
    { id: 'disabled', supportsEffort: false, supportedEffortLevels: ['high'] },
    { id: 'unknown' }, { id: 'bad', supportedReasoningEfforts: {} },
  ]).map(m => m.effortLevels)).toEqual([['low', 'high', 'max'], ['medium', 'xhigh'], undefined, undefined, undefined]);
});
