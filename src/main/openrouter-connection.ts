import { createHash } from 'node:crypto';
import { createCredentials } from './credentials';
import { detectOpenCode } from './opencode-runtime';
import type { SecretStore } from './secret-store';
import type { AiConnectionState } from '../shared/ai-connections';

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const reference = 'ai:openrouter:credential:v1';
export const openRouterBaseUrl = 'https://openrouter.ai/api/v1';
// GET /key reports the key's limits and usage; it makes no inference request and costs nothing.
export async function validateOpenRouterKey(key: string, request: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await request(openRouterBaseUrl + '/key', { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${key}` } });
    if (response.status === 401) return 'Invalid OpenRouter API key.';
    if (response.status === 402) return 'Check your OpenRouter credits.';
    if (response.status === 429) return 'OpenRouter is rate limiting this key. Retry shortly.';
    if (!response.ok) return 'OpenRouter could not validate the key. Please retry.';
    const data = await response.json();
    if (!data || typeof data.data !== 'object' || data.data === null) return 'OpenRouter returned an unexpected response. Please retry.';
  } catch { return 'Could not reach OpenRouter. Check your network and retry.'; }
}
// Runs execute through the installed OpenCode CLI, so it must be installed.
export function createOpenRouterConnection(store: SecretStore, detect = detectOpenCode, validate = validateOpenRouterKey) {
  const credentials = createCredentials(store);
  let installation: ReturnType<typeof detect> | undefined;
  let checkedAt = 0;
  let validating = false;
  function checkInstallation(force = false) {
    if (force || !installation || Date.now() - checkedAt > 30000) {
      checkedAt = Date.now(); installation = detect().catch(() => ({ installed: false }));
    }
    return installation;
  }
  async function readKey(id: unknown) {
    const item = await credentials.aiCredential(id);
    const data = JSON.parse(item.value);
    if (data.provider !== 'OpenRouter' || (data.baseUrl && data.baseUrl.replace(/\/$/, '') !== openRouterBaseUrl) || typeof data.apiKey !== 'string' || !data.apiKey.trim() || /[\r\n]/.test(data.apiKey)) throw new Error('Not an OpenRouter key');
    return { item, key: data.apiKey.trim() };
  }
  return {
    // Main-process execution only; never exposed through IPC.
    async chatKey(): Promise<string> {
      const raw = await store.get(reference);
      if (!raw) throw new Error('Connect OpenRouter in Settings.');
      const saved = JSON.parse(raw);
      const { item, key } = await readKey(saved.credentialId);
      if (!saved.validatedAt || saved.fingerprint !== fingerprint(item.value)) throw new Error('Reconnect the changed OpenRouter credential in Settings.');
      return key;
    },
    checkInstallation: () => checkInstallation(true),
    async disconnect() {
      if (validating) throw new Error('Validation is in progress. Please retry.');
      if (!store.available()) throw new Error('Could not disconnect right now. Try again.');
      // Unlink the provider while retaining the key in Credentials.
      await store.delete(reference);
    },
    async select(id: unknown): Promise<{ ok: boolean; message?: string }> {
      if (validating) return { ok: false, message: 'Validation is already in progress.' };
      validating = true;
      try {
        if (!(await checkInstallation(true)).installed) return { ok: false, message: 'OpenRouter runs through OpenCode, which is not installed. Install it and check again.' };
        const { item, key } = await readKey(id);
        const previous = await store.get(reference);
        if (previous && JSON.parse(previous).credentialId === id) await store.delete(reference);
        const error = await validate(key);
        if (error) return { ok: false, message: error };
        const current = await readKey(id);
        if (current.item.updatedAt !== item.updatedAt || current.item.value !== item.value) return { ok: false, message: 'Credential changed during validation. Please retry.' };
        await store.set(reference, JSON.stringify({ credentialId: id, fingerprint: fingerprint(item.value), validatedAt: new Date().toISOString() }));
        return { ok: true };
      } catch { return { ok: false, message: 'Could not use that saved key. Add your OpenRouter API key again.' }; }
      finally { validating = false; }
    },
    async status(): Promise<AiConnectionState> {
      const runtime = await checkInstallation();
      if (!runtime.installed) return { provider: 'openrouter', status: 'disconnected', ...runtime, message: 'Not installed' };
      try {
        const raw = await store.get(reference);
        if (!raw) return { provider: 'openrouter', status: 'disconnected', ...runtime };
        const saved = JSON.parse(raw);
        let connected = false;
        try { const { item } = await readKey(saved.credentialId); connected = !!saved.validatedAt && saved.fingerprint === fingerprint(item.value); } catch { /* Deleted or no longer an OpenRouter credential. */ }
        return { provider: 'openrouter', status: connected ? 'connected' : 'disconnected', ...runtime };
      } catch { return { provider: 'openrouter', status: 'error', ...runtime, message: 'Add your OpenRouter API key again to keep using it.' }; }
    },
  };
}
