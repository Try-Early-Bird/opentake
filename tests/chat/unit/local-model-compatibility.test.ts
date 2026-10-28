// Opt-in checks of the local-model path: the installed OpenCode CLI runs the app's
// local executor against a loopback OpenAI-compatible server. The scripted mode
// uses a synthetic server; the live mode uses a real local server (for example
// Ollama) given by OPENTAKE_TEST_LOCAL_MODEL_URL and OPENTAKE_TEST_LOCAL_MODEL.
// A recording proxy captures every attempt to reach the internet. No login,
// profile or credential is used.
import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { opencodeExecutor } from '../../../src/main/opencode-chat';
import type { TakeMessage } from '../../../src/shared/takes';

const executable = process.env.OPENTAKE_TEST_OPENCODE;
const liveUrl = process.env.OPENTAKE_TEST_LOCAL_MODEL_URL, liveModel = process.env.OPENTAKE_TEST_LOCAL_MODEL;
// OpenCode's background install of its plugin package; harmless when it fails.
const tolerated = ['CONNECT registry.npmjs.org:443'];
const chunk = (res: ServerResponse, data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
const listen = (server: Server) => new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server: Server) => (server.address() as { port: number }).port;

function scriptedModel(requests: unknown[]) {
  return createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw); requests.push(body);
    const toolTurn = !JSON.stringify(body.messages).includes('LOCAL-SYNTHETIC-RESULT');
    const name = (body.tools ?? []).map((t: any) => t.function?.name).find((n: string) => n?.includes('marker')) ?? 'opentake_marker';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'local-model' };
    // A reasoning chunk in Ollama's `reasoning` field; it must never become reply text.
    chunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'SYNTHETIC-REASONING ' }, finish_reason: null }] });
    chunk(res, { ...base, choices: [{ index: 0, delta: toolTurn
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name, arguments: '{}' } }] }
      : { role: 'assistant', content: 'Local model complete.' }, finish_reason: null }] });
    chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? 'tool_calls' : 'stop' }] });
    chunk(res, { ...base, choices: [], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } });
    res.end('data: [DONE]\n\n');
  });
}

for (const mode of ['scripted', 'live'] as const) for (const withHistory of [false, true])
test.skipIf(!executable || (mode === 'live' && !(liveUrl && liveModel)))(`${mode} local model through OpenCode (history=${withHistory})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-local-model-'));
  const run = randomUUID(), capability = 'c'.repeat(64);
  const requests: unknown[] = [], dispatches: unknown[] = [], outbound: string[] = [];
  const gateway = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${capability}`) { res.writeHead(403).end(); return; }
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw);
    if (body.method === 'gateway:call') dispatches.push(body);
    const value = body.method === 'gateway:instructions' ? 'Synthetic gateway guidance'
      : body.method === 'gateway:list' ? [{ name: 'marker', description: 'Return the synthetic marker string. Always call this when asked for the marker.', inputSchema: { type: 'object', properties: {} } }]
      : { content: [{ type: 'text', text: 'LOCAL-SYNTHETIC-RESULT' }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value }));
  });
  const model = mode === 'scripted' ? scriptedModel(requests) : undefined;
  const proxy = createServer((req, res) => { outbound.push(`${req.method} ${req.url}`); res.writeHead(502).end(); });
  proxy.on('connect', (req, socket) => { outbound.push(`CONNECT ${req.url}`); socket.on('error', () => {}); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  const servers = [gateway, proxy, ...(model ? [model] : [])];
  for (const server of servers) await listen(server);
  const baseUrl = model ? `http://127.0.0.1:${port(model)}/v1` : liveUrl!;
  const modelId = model ? 'local-model' : liveModel!;
  const launch = ((exe: string, argv: string[], options: any) => {
    const proxyUrl = `http://127.0.0.1:${port(proxy)}`;
    return spawn(exe, argv, { ...options, env: { ...options.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  }) as typeof spawn;
  const meta = { parentId: null, images: [], createdAt: new Date().toISOString(), selection: { provider: 'local' as const, model: modelId }, state: 'completed' as const, tools: [] };
  const ask = 'Call the marker tool, then reply with exactly the text it returned.';
  const messages: TakeMessage[] = withHistory
    ? [{ ...meta, id: randomUUID(), role: 'user', text: 'Remember the word PELICAN.' }, { ...meta, id: randomUUID(), role: 'assistant', text: 'Noted: PELICAN.' }, { ...meta, id: randomUUID(), role: 'user', text: ask }]
    : [{ ...meta, id: randomUUID(), role: 'user', text: ask }];
  const output: string[] = [], audit: any[] = [], tools: any[] = [];
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 170000);
  const started = Date.now();
  try {
    const execute = opencodeExecutor(async () => '', root, resolve(__dirname, '../../../out/main/earlybird-opentake-mcp.js'),
      { command: () => ({ executable: executable!, args: [] }), launch }, { kind: 'compatible', providerID: 'local', name: 'Local', baseUrl: async () => baseUrl, missing: 'Connect a local model server in Settings.' });
    await execute({ id: run, takeId: randomUUID(), gateway: { port: port(gateway), token: capability }, selection: { provider: 'local', model: modelId }, messages,
      instructions: 'You are a test assistant. Use the marker tool when asked.', signal: controller.signal, image: async () => '',
      text: (v: string, replace?: boolean) => { if (replace) output.length = 0; output.push(v); }, tool: (v: unknown) => tools.push(v), replay: () => {}, audit: async (v: unknown) => { audit.push(v); } } as any);
    const text = output.join('');
    if (mode === 'live') console.log(JSON.stringify({ model: modelId, history: withHistory, seconds: Math.round((Date.now() - started) / 1000), aborted: controller.signal.aborted,
      steps: audit.filter(e => e.kind === 'usage.recorded').map(e => e.payload?.reason), dispatches: dispatches.length, length: text.length, start: text.slice(0, 200), end: text.slice(-300), outbound }));
    expect(controller.signal.aborted).toBe(false);
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    expect(tools.at(-1)).toMatchObject({ name: 'marker', state: 'completed' });
    expect(audit.filter(e => e.kind === 'usage.recorded').length).toBeGreaterThanOrEqual(2);
    expect(outbound.every(o => tolerated.includes(o))).toBe(true);
    if (mode === 'scripted') {
      expect(text).toContain('Local model complete.');
      expect(text).not.toContain('SYNTHETIC-REASONING');
      const first = JSON.stringify(requests[0]);
      if (withHistory) expect(first).toContain('PELICAN');
      expect((requests[0] as any).tools.every((t: any) => t.function.name.includes('marker'))).toBe(true);
    } else {
      expect(text).toContain('LOCAL-SYNTHETIC-RESULT');
      // Reasoning is not shown as reply text (qwen3 reasons for over 1,000 characters).
      expect(text.length).toBeLessThan(300);
    }
  } finally {
    clearTimeout(timer); controller.abort();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

// OpenRouter runs use the same OpenAI-compatible path with a key, list prices and listed efforts.
test.skipIf(!executable)('scripted OpenRouter-style provider sends the key and effort, reports priced cost and redacts the key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-openrouter-'));
  const run = randomUUID(), capability = 'd'.repeat(64), key = 'sk-or-v1-' + 'f'.repeat(40);
  const requests: unknown[] = [], auth: string[] = [];
  const gateway = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw);
    const value = body.method === 'gateway:instructions' ? 'Synthetic gateway guidance'
      : body.method === 'gateway:list' ? [{ name: 'marker', description: 'Return a synthetic marker', inputSchema: { type: 'object', properties: {} } }]
      : { content: [{ type: 'text', text: 'LOCAL-SYNTHETIC-RESULT' }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value }));
  });
  const scripted = scriptedModel(requests);
  const model = createServer((req, res) => { auth.push(String(req.headers.authorization)); scripted.emit('request', req, res); });
  for (const server of [gateway, model]) await listen(server);
  const audit: any[] = [], output: string[] = [], replay: unknown[] = [];
  try {
    const execute = opencodeExecutor(async () => '', root, resolve(__dirname, '../../../out/main/earlybird-opentake-mcp.js'), { command: () => ({ executable: executable!, args: [] }) },
      { kind: 'compatible', providerID: 'openrouter', name: 'OpenRouter', baseUrl: async () => `http://127.0.0.1:${port(model)}/v1`, apiKey: async () => key,
        model: async () => ({ value: 'x-ai/grok-4.7', label: 'Grok 4.7', effortLevels: ['low', 'high'], pricing: { input: 2, output: 6 } }), missing: 'Connect OpenRouter in Settings.' });
    await execute({ id: run, takeId: randomUUID(), gateway: { port: port(gateway), token: capability }, selection: { provider: 'openrouter', model: 'x-ai/grok-4.7', effort: 'high' },
      messages: [{ id: randomUUID(), parentId: null, role: 'user', text: 'Check the marker.', images: [], tools: [], createdAt: new Date().toISOString(), selection: { provider: 'openrouter', model: 'x-ai/grok-4.7' }, state: 'completed' }],
      instructions: 'Synthetic instructions.', signal: AbortSignal.timeout(45000), image: async () => '', text: (v: string) => output.push(v), tool: () => {}, replay: (v: unknown) => replay.push(v), audit: async (v: unknown) => { audit.push(v); } } as any);
    expect(auth.length).toBe(2); expect(auth.every(a => a === `Bearer ${key}`)).toBe(true);
    expect(requests.map(r => (r as { reasoning_effort?: string }).reasoning_effort)).toEqual(['high', 'high']);
    const costs = audit.filter(e => e.kind === 'usage.recorded').map(e => e.payload.cost);
    // 40 input and 6 output tokens per step at $2 / $6 per million tokens.
    expect(costs).toEqual([0.000116, 0.000116]);
    expect(JSON.stringify({ audit, output, replay })).not.toContain(key);
    expect(output.join('')).toContain('Local model complete.');
  } finally {
    for (const server of [gateway, model]) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
