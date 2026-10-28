import { discoverGrokModels, GrokModelDiscoveryError } from './grok-chat';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { resolveAiCli } from './ai-runtime';
import { resolveOpenCode } from './opencode-runtime';
import type { SecretStore } from './secret-store';
import { reasoningEfforts } from '../shared/ai-models';
import type { AiModel, ModelProvider, ModelResult, ReasoningEffort } from '../shared/ai-models';

// Exact IDs verified 2026-10-01: https://platform.claude.com/docs/en/models/overview
// Unknown future models stay unknown; this registry never supplies model choices.
const verifiedImageModels = new Set(['claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-4-5','claude-haiku-4-5-20251001']);
export function parseModels(raw: unknown): AiModel[] {
  if (!Array.isArray(raw)) return [];
  const result = new Map<string, AiModel>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || entry.visibility === 'hide' || entry.hidden === true) continue;
    const value = entry.value ?? entry.id ?? entry.slug ?? entry.model;
    let label = entry.displayName ?? entry.display_name ?? entry.name ?? value;
    const resolvedModel = typeof entry.resolvedModel === 'string' ? entry.resolvedModel.slice(0, 200) : undefined;
    const fullName = resolvedModel?.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(.*)$/i);
    if (fullName) {
      const [, family, major, minor, suffix] = fullName;
      const name = `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? '.' + minor : ''}${suffix}`;
      label = value === 'default' ? `${name} (Default)` : name + (typeof label === 'string' && /1m|1M|1 m|1 M/.test(label) && !suffix ? ' (1M context)' : '');
    }
    // Native CLI discovery advertises exact supported levels; never infer them from model names.
    const advertised = entry.supportsEffort === false ? [] : entry.supportedEffortLevels ?? (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.map((item: { reasoningEffort?: unknown } | null) => item?.reasoningEffort) : []);
    const effortLevels = reasoningEfforts.filter(level => Array.isArray(advertised) && advertised.includes(level));
    const defaultEffort = effortLevels.find(level => level === entry.defaultReasoningEffort);
    const imageInput = typeof entry.capabilities?.image_input?.supported === 'boolean' ? entry.capabilities.image_input.supported : Array.isArray(entry.inputModalities) ? entry.inputModalities.includes('image') : verifiedImageModels.has(resolvedModel ?? value) ? true : undefined;
    if (typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:[\]-]{0,199}$/.test(value) && typeof label === 'string') result.set(value, { value, label: label.slice(0, 160), ...(effortLevels.length ? { effortLevels } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(imageInput !== undefined ? { imageInput } : {}), ...(resolvedModel ? { resolvedModel } : {}), ...(typeof entry.description === 'string' ? { description: entry.description.slice(0, 600) } : {}), ...(entry.disabled === true ? { disabled: true } : {}) });
  }
  return [...result.values()];
}
// OpenRouter lists every model; keep text models that accept tools, since every
// run offers the gateway tools. Images stay unverified through OpenCode.
export function parseOpenRouterModels(raw: unknown): AiModel[] {
  if (!Array.isArray(raw)) return [];
  const perMillion = (v: unknown) => { const n = Number(v); return typeof v === 'string' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined; };
  const result: AiModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:[\]-]{0,199}$/.test(entry.id)) continue;
    if (!Array.isArray(entry.supported_parameters) || !entry.supported_parameters.includes('tools')) continue;
    if (Array.isArray(entry.architecture?.output_modalities) && !entry.architecture.output_modalities.includes('text')) continue;
    const input = perMillion(entry.pricing?.prompt), output = perMillion(entry.pricing?.completion);
    // OpenRouter lists each model's accepted efforts; OpenCode sends the chosen one as reasoning_effort.
    const advertised = entry.reasoning?.supported_efforts;
    const effortLevels = reasoningEfforts.filter(level => Array.isArray(advertised) && advertised.includes(level));
    const defaultEffort = effortLevels.find(level => level === entry.reasoning?.default_effort);
    result.push({ value: entry.id, label: (typeof entry.name === 'string' ? entry.name : entry.id).slice(0, 160),
      ...(effortLevels.length ? { effortLevels } : {}), ...(defaultEffort ? { defaultEffort } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description.slice(0, 600) } : {}),
      ...(Number.isSafeInteger(entry.created) ? { created: entry.created } : {}),
      ...(input !== undefined && output !== undefined ? { pricing: { input, output } } : {}) });
  }
  return result;
}
// OpenCode drops a variant it does not define for a model, so Zen levels come from
// the installed CLI's own model list rather than the Zen catalog, which has none.
export function parseOpenCodeVariants(output: string): Map<string, ReasoningEffort[]> {
  const result = new Map<string, ReasoningEffort[]>();
  for (const block of output.split(/^opencode\/\S+\r?\n/m).slice(1)) {
    let model; try { model = JSON.parse(block); } catch { continue; }
    if (typeof model?.id !== 'string' || !model.variants || typeof model.variants !== 'object') continue;
    const levels = reasoningEfforts.filter(level => Object.hasOwn(model.variants, level));
    if (levels.length) result.set(model.id, levels);
  }
  return result;
}
export async function discoverZenEfforts(root: string, launch: typeof spawn = spawn, command = resolveOpenCode): Promise<Map<string, ReasoningEffort[]>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, 'opencode-'));
  try {
    const cli = command();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    // Listing reads OpenCode's bundled catalog; the placeholder key only keeps paid models listed.
    Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, DISABLE_AUTOUPDATER: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled', plugin: [], enabled_providers: ['opencode'], provider: { opencode: { options: { apiKey: 'opentake-discovery' } } } }) });
    return await new Promise((resolve, reject) => {
      const child = launch(cli.executable, [...cli.args, 'models', 'opencode', '--verbose'], { cwd: home, env, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = ''; let failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 15000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', data => { output += data; if (output.length > 4 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); } });
      child.on('error', () => { clearTimeout(timer); reject(new Error('OpenCode models unavailable')); });
      child.on('close', code => { clearTimeout(timer); failed || code !== 0 ? reject(new Error('OpenCode models unavailable')) : resolve(parseOpenCodeVariants(output)); });
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}
export async function discoverRuntimeModels(provider: 'claude' | 'chatgpt', credential: string, root: string, launch: typeof spawn = spawn, commandFor = resolveAiCli): Promise<AiModel[]> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, 'models-'));
  try {
    const parsed = JSON.parse(credential);
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' });
    const command = commandFor(provider);
    env.PATH = dirname(command.executable) + delimiter + (env.PATH ?? '');
    env.ELECTRON_RUN_AS_NODE = '1';
    let executable = command.executable;
    let args: string[];
    if (provider === 'claude') {
      env.CLAUDE_CODE_OAUTH_TOKEN = parsed.token;
      args = [...command.args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];
    } else {
      await mkdir(env.CODEX_HOME!, { mode: 0o700 });
      await writeFile(join(env.CODEX_HOME!, 'auth.json'), credential, { mode: 0o600 });
      env.ELECTRON_RUN_AS_NODE = '1';
      args = [...command.args, '-c', 'cli_auth_credentials_store="file"', 'app-server'];
    }
    return await new Promise<AiModel[]>((resolve, reject) => {
      const child = launch(executable, args, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = ''; let bytes = 0; let result: AiModel[] | undefined; let failed = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const finish = (models?: AiModel[]) => {
        if (result || failed) return;
        if (models?.length) result = models; else failed = true;
        child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      const timer = setTimeout(() => finish(), 15000);
      const send = (value: unknown) => child.stdin!.write(JSON.stringify(value) + '\n');
      child.stdin!.on('error', () => {}); child.stderr!.on('data', () => {}); child.stdout!.setEncoding('utf8');
      const all: AiModel[] = [];
      let pages = 0;
      child.stdout!.on('data', data => {
        bytes += data.length; if (bytes > 1024 * 1024) { finish(); return; }
        buffer += data; let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (provider === 'claude' && event.type === 'control_response' && event.response?.request_id === 'models') finish(parseModels(event.response.response?.models));
          if (provider === 'chatgpt' && event.id === 1) {
            if (event.error) { finish(); continue; }
            send({ method: 'initialized', params: {} }); send({ id: 2, method: 'model/list', params: { limit: 100 } });
          }
          if (provider === 'chatgpt' && event.id === 2) {
            if (event.error) { finish(); continue; }
            all.push(...parseModels(event.result?.data));
            if (event.result?.nextCursor && ++pages < 20) send({ id: 2, method: 'model/list', params: { limit: 100, cursor: event.result.nextCursor } });
            else finish(all);
          }
        }
      });
      child.on('error', () => { clearTimeout(timer); clearTimeout(force); reject(new Error('Model discovery unavailable')); });
      child.on('close', () => { clearTimeout(timer); clearTimeout(force); result ? resolve(result) : reject(new Error('Model discovery unavailable')); });
      if (provider === 'claude') send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
      else send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'opentake', version: '0.1.0' } } });
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}
export function createModelDiscovery(store: SecretStore, root: string, status: () => Promise<{ provider: string; status: string }[]>, runtime = discoverRuntimeModels, request: typeof fetch = fetch, local: () => Promise<AiModel[]> = async () => [], grok = discoverGrokModels, zenEfforts = discoverZenEfforts) {
  const cache = new Map<ModelProvider, { at: number; value: ModelResult }>();
  const pending = new Map<ModelProvider, Promise<ModelResult>>();
  return async function models(value: unknown, refresh = false): Promise<ModelResult> {
    if (!['grok', 'claude', 'chatgpt', 'opencode', 'openrouter', 'local'].includes(String(value))) return { ok: false, message: 'Unknown AI provider.' };
    const provider = value as ModelProvider;
    try {
      if (!(await status()).some(item => item.provider === provider && item.status === 'connected')) { cache.delete(provider); return { ok: false, message: 'Connect this AI provider first.' }; }
      const cached = cache.get(provider);
      if (!refresh && cached && Date.now() - cached.at < 60000) return cached.value;
      if (pending.has(provider)) return pending.get(provider)!;
      const work = (async (): Promise<ModelResult> => {
        try {
          let choices: AiModel[];
          if (provider === 'grok') choices = await grok(store, root);
          else if (provider === 'local') choices = await local();
          else if (provider === 'openrouter') {
            const response = await request('https://openrouter.ai/api/v1/models', { redirect: 'error', signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error('Catalog unavailable');
            choices = parseOpenRouterModels((await response.json()).data);
          }
          else if (provider === 'opencode') {
            // Effort is optional: without the CLI's variants the models still load, just without the slider.
            const [response, efforts] = await Promise.all([request('https://opencode.ai/zen/v1/models', { redirect: 'error', signal: AbortSignal.timeout(10000) }),
              zenEfforts(root).catch(() => new Map<string, ReasoningEffort[]>())]);
            if (!response.ok) throw new Error('Catalog unavailable');
            choices = parseModels((await response.json()).data).map(({ effortLevels: _, defaultEffort: __, ...model }) => efforts.get(model.value) ? { ...model, effortLevels: efforts.get(model.value) } : model);
          } else {
            const credential = await store.get(`ai:subscription:v1:${provider}`);
            if (!credential) throw new Error('Missing connection');
            choices = await runtime(provider, credential, root);
          }
          if (!choices.length) throw new Error('Empty catalog');
          const result: ModelResult = { ok: true, models: choices, source: provider === 'grok' || provider === 'claude' || provider === 'local' ? 'runtime' : 'catalog' };
          cache.set(provider, { at: Date.now(), value: result }); return result;
        } catch (error) { return { ok: false, message: provider === 'grok' && error instanceof GrokModelDiscoveryError ? error.message : 'Could not load models. Check your connection and retry.' }; }
        finally { pending.delete(provider); }
      })();
      pending.set(provider, work); return work;
    } catch { return { ok: false, message: 'Could not check this AI connection.' }; }
  };
}
