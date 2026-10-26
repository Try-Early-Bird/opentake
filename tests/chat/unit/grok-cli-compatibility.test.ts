import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { grokExecutor, discoverGrokModels } from '../../../src/main/grok-chat';
import { confinedGrok } from '../../../src/main/grok-runtime';
import type { SecretStore } from '../../../src/main/secret-store';

// Explicit opt-in: real CLI, synthetic auth, network restricted to this mock only.
const executable = process.env.GROK_COMPAT_BINARY;
for (const mode of ['discovery', 'inline', 'file-input']) test.skipIf(!executable || process.platform !== 'darwin')('installed Grok ACP gateway confinement: ' + mode, { timeout: 55000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-cli-compat-'));
  const paths: string[] = [], requests: any[] = [], output: string[] = [], dispatches: string[] = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    paths.push(req.url ?? '');
    if(req.url==='/models'){if(mode==='discovery')await new Promise(resolve=>setTimeout(resolve,400));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{model:mode==='discovery'?'grok-discovery-fixture':'grok-4.6',id:mode==='discovery'?'grok-discovery-fixture':'grok-4.6',name:'Grok fixture',context_window:131072}]}));return;}
    if (!req.url?.match(/(?:responses|chat\/completions)$/)) { res.writeHead(404).end('{}'); return; }
    const body = JSON.parse(raw); requests.push(body);
    const main = (body.tools ?? []).some((t:any)=>(t.name ?? t.function?.name)==='use_tool');
    const first = main && !requests.slice(0,-1).some(r=>(r.tools??[]).some((t:any)=>(t.name??t.function?.name)==='use_tool'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let sequence = 0;
    const send = (name: string, data: any) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: ++sequence, ...data })}\n\n`);
    const args = JSON.stringify(mode === 'inline' ? { tool_name: 'opentake__marker', tool_input: {} } : { tool_name: 'opentake__marker', tool_input_file: '.grok/auth.json' });
    if (req.url.endsWith('responses')) {
      const item = first ? { id: 'fc_fixture', type: 'function_call', call_id: 'fixture-call', name: 'use_tool', arguments: args, status: 'completed' }
        : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Grok compatibility complete.', annotations: [] }] };
      send('response.created', { response: { id: 'resp_fixture', created_at: 1, model: 'grok-4.6', object: 'response', status: 'in_progress', output: [] } });
      send('response.output_item.added', { output_index: 0, item: first ? item : {...item, content: []} });
      if(!first) { send('response.content_part.added', { item_id:'msg_fixture',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]} }); send('response.output_text.delta', { item_id:'msg_fixture',output_index:0,content_index:0,delta:'Grok compatibility complete.',logprobs:[] }); }
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', { response: { id: 'resp_fixture', created_at: 1, model: 'grok-4.6', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    } else {
      const chunk = (delta: any, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      chunk(first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'use_tool', arguments: args } }] } : { role: 'assistant', content: 'Grok compatibility complete.' });
      chunk({}, first ? 'tool_calls' : 'stop'); res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as any).port, endpoint = `http://127.0.0.1:${port}`;
  const credential = JSON.stringify({ 'https://auth.x.ai::fixture': { auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'fixture', key: 'synthetic-access', user_id: 'synthetic', create_time: new Date().toISOString(), expires_at: '2099-01-01T00:00:00Z' } });
  const store: SecretStore = { available: () => true, has: async () => true, get: async () => credential, set: async () => {}, delete: async () => {}, compareAndSet: async () => true };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
  const launch: typeof spawn = ((exe, args, opts) => { const child = spawn(exe, args, { ...opts, env: { ...opts.env,
    GROK_OAUTH2_ISSUER: 'https://auth.x.ai', GROK_OAUTH2_CLIENT_ID: 'fixture', GROK_CLI_CHAT_PROXY_BASE_URL: endpoint } }); return child; }) as typeof spawn;
  try {
    const deps = { command: () => ({ executable: executable!, args: [] }), launch,
      confine: (command: Parameters<typeof confinedGrok>[0], home: string) => { const result = confinedGrok(command, home, true); result.args[1] += `\n(deny network*)\n(allow network-outbound (remote ip "localhost:${port}"))`; return result; },
      gatewayCall: (async (_host, method, args) => {
        if (method === 'gateway:list') return [{ name: 'marker', description: 'Synthetic marker', inputSchema: { type: 'object', properties: {} } }];
        if (method === 'gateway:instructions') return 'Synthetic test gateway';
        dispatches.push(String(args[1])); return { content: [{ type: 'text', text: 'SYNTHETIC-TOOL-RESULT' }] };
      }) as any,
    };
    if (mode === 'discovery') {
      const choices = await discoverGrokModels(store, root, deps);
      expect(choices.some(m => m.value === 'grok-discovery-fixture')).toBe(true);
      expect(requests).toEqual([]);
      return;
    }
    await grokExecutor(store, root, deps)({ id: randomUUID(), takeId: randomUUID(), gateway: { port: 12345, token: 'a'.repeat(64) }, selection: { provider: 'grok', model: 'grok-4.6' }, instructions: 'Synthetic test. Use the marker tool.',
      messages: [{ id: randomUUID(), parentId: null, role: 'user', text: 'Call marker then reply.', images: [], createdAt: new Date().toISOString(), selection: { provider: 'grok', model: 'grok-4.6' }, state: 'completed', tools: [] }],
      signal: controller.signal, image: async () => '', text: v => output.push(v), tool: () => {} });
    expect(output.join('')).toContain('Grok compatibility complete.'); expect(dispatches).toEqual(mode === 'inline' ? ['marker'] : []);
    expect(JSON.stringify(requests)).not.toContain('synthetic-access');
    if(mode === 'inline') expect(JSON.stringify(requests)).toContain('SYNTHETIC-TOOL-RESULT');
    else expect(JSON.stringify(requests)).toContain('Read denied');
    const tools = requests.find(r=>r.tools?.some((t:any)=>t.name==='use_tool')).tools.map((t: any) => t.function?.name ?? t.name);
    expect(tools).toContain('use_tool'); expect(tools.every((name: string) => ['search_tool', 'use_tool', 'opentake__marker'].includes(name))).toBe(true);
  } catch (error) { throw new Error(String(error) + '\nMock paths: ' + paths.join(',') + '\nModel requests: ' + requests.length); }
  finally { clearTimeout(timer); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
