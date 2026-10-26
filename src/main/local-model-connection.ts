import { detectOpenCode } from './opencode-runtime';
import { parseModels } from './ai-models';
import type { SecretStore } from './secret-store';
import type { AiConnectionState } from '../shared/ai-connections';
import type { AiModel } from '../shared/ai-models';

// A local OpenAI-compatible server (Ollama, LM Studio, vLLM) run through OpenCode.
// Loopback only: a run's history and tool results are sent to this endpoint.
const reference = 'ai:local:connection:v1';
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function normalizeLocalBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 300) return;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || !loopback.has(url.hostname) || url.username || url.password || url.search || url.hash) return;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path || '/v1'}`;
}
export async function listLocalModels(baseUrl: string, request: typeof fetch = fetch): Promise<AiModel[]> {
  const response = await request(baseUrl + '/models', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Model list unavailable');
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('Model list too large');
  // Local servers report no image capability here, so images stay unverified.
  return parseModels(JSON.parse(text).data).map(({ imageInput: _, ...model }) => model);
}
export function createLocalModelConnection(store: SecretStore, detect = detectOpenCode, request: typeof fetch = fetch) {
  let installation: ReturnType<typeof detect> | undefined;
  let checkedAt = 0;
  function checkInstallation(force = false) {
    if (force || !installation || Date.now() - checkedAt > 30000) {
      checkedAt = Date.now(); installation = detect().catch(() => ({ installed: false }));
    }
    return installation;
  }
  async function saved(): Promise<string | undefined> {
    const raw = await store.get(reference);
    return raw ? normalizeLocalBaseUrl(JSON.parse(raw).baseUrl) : undefined;
  }
  return {
    // Main-process execution only; never exposed through IPC.
    async baseUrl(): Promise<string> {
      const value = await saved();
      if (!value) throw new Error('Connect a local model server in Settings.');
      return value;
    },
    async models(): Promise<AiModel[]> {
      const value = await saved();
      if (!value) throw new Error('Connect a local model server in Settings.');
      return listLocalModels(value, request);
    },
    checkInstallation: () => checkInstallation(true),
    async connect(raw: unknown): Promise<{ ok: boolean; message?: string }> {
      const baseUrl = normalizeLocalBaseUrl(raw);
      if (!baseUrl) return { ok: false, message: 'Enter a loopback URL such as http://127.0.0.1:11434/v1.' };
      if (!(await checkInstallation(true)).installed) return { ok: false, message: 'OpenCode is not installed. Install it and check again.' };
      let models: AiModel[];
      try { models = await listLocalModels(baseUrl, request); }
      catch { return { ok: false, message: 'Could not reach a model server at that URL. Start it and retry.' }; }
      if (!models.length) return { ok: false, message: 'The server has no models. Pull or load a model and retry.' };
      try { await store.set(reference, JSON.stringify({ baseUrl, validatedAt: new Date().toISOString() })); }
      catch { return { ok: false, message: 'Could not save the connection. Check OS secret storage.' }; }
      return { ok: true };
    },
    async disconnect() {
      if (!store.available()) throw new Error('Unlock OS secret storage before disconnecting AI.');
      await store.delete(reference);
    },
    async status(): Promise<AiConnectionState> {
      const runtime = await checkInstallation();
      if (!runtime.installed) return { provider: 'local', status: 'disconnected', ...runtime, message: 'Not installed' };
      try { return { provider: 'local', status: (await saved()) ? 'connected' : 'disconnected', ...runtime }; }
      catch { return { provider: 'local', status: 'error', ...runtime, message: 'Could not check the saved connection. Check OS secret storage.' }; }
    },
  };
}
