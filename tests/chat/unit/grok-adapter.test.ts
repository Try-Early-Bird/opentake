import { test, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { grokExecutor, discoverGrokModels, grokModels, grokPrompt } from '../../../src/main/grok-chat';
import { createModelDiscovery } from '../../../src/main/ai-models';
import { createUsageCollector } from '../../../src/main/chat-usage';
import { grokAgentProfile, grokChatConfig } from '../../../src/main/grok-acp';
import type { RunInput } from '../../../src/main/take-runtime';
import type { TakeMessage } from '../../../src/shared/takes';
import type { SecretStore } from '../../../src/main/secret-store';
const credential = JSON.stringify({ 'https://auth.x.ai::fixture': { auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'fixture', key: 'synthetic-access', refresh_token: 'synthetic-refresh', user_id: 'fake-user', create_time: '2026-10-01T00:00:00Z' } });
const store: SecretStore = { available: () => true, has: async () => true, get: async () => credential, set: async () => {}, delete: async () => {}, compareAndSet: async () => true };
function message(role: 'user' | 'assistant', text: string): TakeMessage { return { id: randomUUID(), parentId: null, role, text, images: [], createdAt: new Date().toISOString(), selection: { provider: 'grok', model: 'grok-fixture' }, state: 'completed', tools: [] }; }
function input(signal = new AbortController().signal) {
  const text: string[] = [], replay: unknown[] = [], tools: unknown[] = [], audit: any[] = [];
  const run: RunInput = { id: randomUUID(), takeId: randomUUID(), gateway: { port: 12345, token: 'a'.repeat(64) }, selection: { provider: 'grok', model: 'grok-fixture' }, messages: [message('user', 'Hello')], instructions: 'App instructions', signal, maxTurns: 37,
    image: async () => { throw new Error('No image reads'); }, text: v => text.push(v), replay: v => replay.push(v), tool: v => tools.push(v), audit: async e => { audit.push(e); } };
  return { run, text, replay, tools, audit };
}
const fixture = String.raw`
const emit = v => console.log(JSON.stringify({jsonrpc:'2.0',...v}));
const mode=process.argv[1],fs=require('node:fs');let promptId,serverId,modelSet,effort;
const models={availableModels:[{modelId:'grok-fixture',name:'Grok fixture',_meta:{supportsReasoningEffort:true,reasoningEfforts:['low',{value:'high'}]}}]};
const update=text=>emit({method:'session/update',params:{sessionId:mode==='wrong-session'?'other':'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const e=JSON.parse(line);fs.appendFileSync('requests.jsonl',line+'\n');
 if(e.method==='initialize'){emit({id:e.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'}],_meta:{agentVersion:mode==='newer-cli'?'9.9.9':'1.0.46','x.ai/mcp/sdk':mode!=='no-sdk',modelState:{availableModels:[]}}}});return;}
 if(e.method==='_x.ai/models/list'){emit({id:e.id,result:mode==='catalog-error'?{result:null,error:'private-provider-diagnostic'}:{result:{availableModels:[{modelId:'grok-fixture',name:'Grok fixture',description:null}]}}});return;}
 if(e.method==='authenticate'){emit({id:e.id,result:{}});return;}
 if(e.method==='session/new'){if(e.params._meta.agentProfile.tools.join(',')!=='search_tool,use_tool'||e.params._meta.agentProfile.maxTurns!==37)process.exit(4);serverId=e.params._meta['x.ai/mcp/servers'][0].serverId;emit({id:'discover',method:'_x.ai/mcp/sdk_call',params:{serverId,message:{jsonrpc:'2.0',id:1,method:'server/discover'}}});emit({id:e.id,result:{sessionId:'session',models}});return;}
 if(e.id==='discover'){if(e.result?.error?.code!==-32601)process.exit(4);return;}
 if(e.method==='session/set_model'){modelSet=true;emit({id:e.id,result:{}});return;}
 if(e.method==='session/set_config_option'){if(!modelSet||e.params.configId!=='reasoning_effort')process.exit(5);effort=e.params.value;emit({id:e.id,result:{configOptions:[]}});return;}
 if(e.method==='session/prompt'){
  promptId=e.id;
  if(mode==='hang')return;
  if(mode==='exit')process.exit(0);
  if(mode==='malformed'){console.log('{bad');return;}
  if(mode==='native'){emit({id:'native',method:'terminal/create',params:{command:'touch forbidden'}});return;}
  if(mode==='limit'){emit({id:e.id,result:{stopReason:'max_turn_requests'}});return;}
  if(mode==='billing'){emit({id:e.id,error:{code:-32000,data:{statusCode:429},message:'private-provider-diagnostic'}});return;}
  if(effort)update('Effort '+effort+'. ');
  update('Before synthetic-');update('access. ');
  const params={serverId,message:{jsonrpc:'2.0',id:17,method:'tools/call',params:{name:mode==='unknown-tool'?'shell':'marker',arguments:{q:'synthetic'}}}};
  emit({id:99,method:'_x.ai/mcp/sdk_call',params:{method:'x.ai/mcp/sdk_call',params}});
  if(mode==='duplicate')emit({id:99,method:'_x.ai/mcp/sdk_call',params});
  return;
 }
 if(e.id===99&&e.result){
  if(e.result.result.content[0].text.includes('synthetic-access'))process.exit(3);
  update('After tool.');
  if(mode==='refresh'){const p='.grok/auth.json';let a=JSON.parse(fs.readFileSync(p));Object.values(a)[0].key='synthetic-rotated';fs.writeFileSync(p,JSON.stringify(a));}
  emit({id:promptId,result:{stopReason:'end_turn',_meta:{usage:{inputTokens:100,outputTokens:20,cachedReadTokens:0,cacheCreationTokens:0,reasoningTokens:2}}}});
 }
});`;
async function setup(mode: string, signal?: AbortSignal) {
  const root = await mkdtemp(join(tmpdir(), 'grok-adapter-')); const result = input(signal); let requests: any[] = [];
  const gatewayCall = vi.fn(async (_host, method: string, _args, _client, _timeout, signal?: AbortSignal) => {
    if (method === 'gateway:list') return [{ name: 'marker', inputSchema: { type: 'object' } }];
    if (method === 'gateway:instructions') return 'Gateway guidance';
    if (mode === 'cancel-tool') return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return { isError: mode === 'denied', content: [{ type: 'text', text: 'result synthetic-access' }] };
  });
  const deps = { command: () => ({ executable: process.execPath, args: [] }), version: async () => {}, confine: (c: any) => c, gatewayCall: gatewayCall as any,
    launch: ((_exe, args, options) => {
      expect(options.env.HOME).toContain(root); expect(options.env.XAI_API_KEY).toBeUndefined(); expect(options.env.OPENTAKE_GATEWAY_TOKEN).toBeUndefined();
      expect(args).toContain('--no-auto-update'); expect(JSON.stringify(args)).not.toContain('synthetic-access');
      const child = spawn(process.execPath, ['-e', fixture, mode], options);
      child.once('close', async () => { try { requests = (await readFile(join(options.cwd as string, 'requests.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)); } catch {} });
      return child;
    }) as typeof spawn };
  return { root, result, deps, gatewayCall, requests: () => requests, cleanup: () => rm(root, { recursive: true, force: true }) };
}
for (const mode of ['success','denied','refresh','newer-cli','no-sdk','malformed','native','unknown-tool','duplicate','wrong-session','exit','limit','billing']) test('Grok ACP '+mode, async () => {
  const f = await setup(mode); const cas = vi.fn(async () => true);
  try {
    const run = grokExecutor({ ...store, compareAndSet: cas }, f.root, f.deps)(f.result.run);
    // A newer self-updated CLI runs as long as it offers the capabilities used.
    if (['success','denied','refresh','newer-cli'].includes(mode)) {
      await run;
      expect(f.result.text.join('')).toBe('Before [redacted]. After tool.');
      expect(f.result.replay).toHaveLength(4); expect(f.result.tools).toHaveLength(2);
      expect(JSON.stringify(f.result.audit)).not.toContain('synthetic-access');
      expect(f.result.tools.at(-1)).toMatchObject({ state: mode === 'denied' ? 'failed' : 'completed' });
      expect(cas).toHaveBeenCalledTimes(mode === 'refresh' ? 1 : 0);
      const collector = createUsageCollector('grok'); for (const event of f.result.audit) collector.observe(event);
      expect(collector.finish(true)).toMatchObject({ source: 'Grok ACP', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, partial: false });
    } else await expect(run).rejects.toThrow(mode === 'billing' ? 'usage or billing' : mode === 'limit' ? 'model-turn limit' : mode === 'exit' ? 'exited' : mode === 'no-sdk' ? 'could not complete' : 'unsupported chat protocol');
    expect(await readdir(join(f.root, 'grok-temporary'))).toEqual([]);
    if (mode === 'unknown-tool' || mode === 'native') expect(f.gatewayCall.mock.calls.filter(c => c[1] === 'gateway:call')).toHaveLength(0);
  } finally { await f.cleanup(); }
});
for (const mode of ['hang','cancel-tool']) test('Grok cancellation '+mode, async () => {
  const controller = new AbortController(), f = await setup(mode, controller.signal);
  const timer = setTimeout(() => controller.abort(), 150);
  try { await expect(grokExecutor(store, f.root, f.deps)(f.result.run)).rejects.toThrow('stopped'); expect(await readdir(join(f.root, 'grok-temporary'))).toEqual([]); }
  finally { clearTimeout(timer); await f.cleanup(); }
});
test('Grok history carries prior roles and unknown tool outcomes without invoking tools', async () => {
  const { run } = input(); const assistant = message('assistant', 'Earlier answer');
  assistant.replay = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'prior', name: 'mcp__opentake__marker', input: { q: 'earlier' } }] }];
  run.messages = [message('user', 'Remember this'), assistant, ...run.messages];
  const prompt = await grokPrompt(run);
  expect(prompt[0].text).toContain('Remember this'); expect(prompt[0].text).toContain('outcome is unknown'); expect(prompt[0].text).toContain('"role":"assistant"');
  expect(prompt.at(-1)?.text).toBe('Current user message:\nHello');
  run.messages[0].images = [{ id: 'fake', name: 'fake.png', mime: 'image/png', width: 1, height: 1, bytes: 1 }];
  await expect(grokPrompt(run)).rejects.toThrow('does not support image');
});
test('Grok effort is set after the model and only when the model lists it', async () => {
  const f = await setup('success');
  try {
    f.result.run.selection = { provider: 'grok', model: 'grok-fixture', effort: 'high' };
    await grokExecutor(store, f.root, f.deps)(f.result.run);
    expect(f.result.text.join('')).toBe('Effort high. Before [redacted]. After tool.');
    const g = await setup('success'); g.result.run.selection = { provider: 'grok', model: 'grok-fixture', effort: 'xhigh' };
    try { await expect(grokExecutor(store, g.root, g.deps)(g.result.run)).rejects.toThrow('thinking effort is unavailable'); } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});
test('Grok effort levels come from model meta, skipping custom option ids', () => {
  expect(grokModels({ availableModels: [
    { modelId: 'listed', name: 'Listed', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: ['high', { value: 'low', label: 'Fast' }, { id: 'deep', value: 'xhigh' }, 'future', null] } },
    { modelId: 'marked', name: 'Marked', _meta: { supportsReasoningEffort: true, reasoningEfforts: ['low', { value: 'medium', default: true }] } },
    { modelId: 'unlisted', name: 'Unlisted', _meta: { supportsReasoningEffort: true } },
    { modelId: 'unsupported', name: 'Unsupported', _meta: { supportsReasoningEffort: false, reasoningEfforts: ['high'] } },
    { modelId: 'plain', name: 'Plain' },
  ] }).map(m => [m.effortLevels, m.defaultEffort])).toEqual([[['low', 'high'], 'high'], [['low', 'medium'], 'medium'], [['minimal', 'low', 'medium', 'high', 'xhigh'], undefined], [undefined, undefined], [undefined, undefined]]);
});
test('Grok model discovery requests the catalog after an empty handshake, cleans up and caches runtime choices', async () => {
  const f = await setup('success');
  try {
    const discover = vi.fn(() => discoverGrokModels(store, f.root, f.deps));
    const models = createModelDiscovery(store, f.root, async () => [{ provider: 'grok', status: 'connected' }], undefined, undefined, undefined, discover);
    expect(await models('grok')).toMatchObject({ ok: true, source: 'runtime', models: [{ value: 'grok-fixture', imageInput: false }] });
    await models('grok'); expect(discover).toHaveBeenCalledTimes(1);
    expect(f.gatewayCall).not.toHaveBeenCalled(); expect(await readdir(join(f.root, 'grok-temporary'))).toEqual([]);
  } finally { await f.cleanup(); }
});
test('Grok refuses a concurrent credential change after rotation', async () => {
  const f = await setup('refresh');
  try { await expect(grokExecutor({ ...store, compareAndSet: async () => false }, f.root, f.deps)(f.result.run)).rejects.toThrow('Could not save Grok'); expect(await readdir(join(f.root, 'grok-temporary'))).toEqual([]); }
  finally { await f.cleanup(); }
});
test('Grok ACP profile and config restrict tools and file-backed MCP inputs', () => {
  expect(grokAgentProfile).toMatchObject({tools:['search_tool','use_tool'],maxTurns:100,permissionMode:'dontAsk',agentsMd:false,discoverSkills:false});
  expect(grokChatConfig).toContain('{ action = "deny", tool = "read" }');
});

for (const mode of ['catalog-error', 'no-sdk']) test('Grok model discovery reports a safe failure stage: ' + mode, async () => {
  const f = await setup(mode);
  try {
    const models = createModelDiscovery(store, f.root, async () => [{ provider: 'grok', status: 'connected' }], undefined, undefined, undefined, () => discoverGrokModels(store, f.root, f.deps));
    const result = await models('grok');
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(mode === 'catalog-error' ? 'loading the Grok model catalog' : 'checking Grok sign-in and CLI compatibility') });
    expect(JSON.stringify(result)).not.toMatch(/private-provider-diagnostic|synthetic-access/);
    expect(await readdir(join(f.root, 'grok-temporary'))).toEqual([]);
  } finally { await f.cleanup(); }
});
