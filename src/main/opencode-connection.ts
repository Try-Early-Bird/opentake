import { createHash } from 'node:crypto';
import { createCredentials } from './credentials';
import { detectOpenCode } from './opencode-runtime';
import type { SecretStore } from './secret-store';
import type { AiConnectionState } from '../shared/ai-connections';

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const reference = 'ai:opencode:credential:v1';
export async function validateZenKey(key: string, request: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await request('https://opencode.ai/zen/v1/messages', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] }),
    });
    if (response.status === 401) return 'Invalid OpenCode Zen API key.';
    if (response.status === 403) return 'This key cannot access the validation model. Check your Zen workspace permissions.';
    if (response.status === 402) return 'Check your OpenCode Zen billing or credits.';
    if (response.status === 429) return 'OpenCode Zen is rate limited or out of quota. Check your limits and retry.';
    if (!response.ok) return 'OpenCode Zen could not complete validation. Please retry.';
    const data = await response.json();
    if (data.type !== 'message' || !Array.isArray(data.content) || !data.content.some((part: { type?: string; text?: string }) => part?.type === 'text' && typeof part.text === 'string' && part.text.length)) return 'OpenCode Zen returned an unexpected response. Please retry.';
  } catch { return 'Could not reach OpenCode Zen. Check your network and retry.'; }
}
export function createOpenCodeConnection(store: SecretStore, detect = detectOpenCode, validate = validateZenKey) {
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
  async function readZen(id: unknown) {
    const item = await credentials.aiCredential(id);
    const data = JSON.parse(item.value);
    if (data.provider !== 'OpenCode Zen' || (data.baseUrl && data.baseUrl.replace(/\/$/, '') !== 'https://opencode.ai/zen/v1') || typeof data.apiKey !== 'string' || !data.apiKey.trim() || /[\r\n]/.test(data.apiKey)) throw new Error('Not a Zen key');
    return { item, key: data.apiKey.trim() };
  }
  return {
    // Main-process execution only; never exposed through IPC.
    async chatKey(): Promise<string> {
      const raw = await store.get(reference);
      if (!raw) throw new Error('Connect OpenCode in Settings.');
      const saved = JSON.parse(raw);
      const { item, key } = await readZen(saved.credentialId);
      if (!saved.validatedAt || saved.fingerprint !== fingerprint(item.value)) throw new Error('Reconnect the changed OpenCode credential in Settings.');
      return key;
    },
    checkInstallation: () => checkInstallation(true),
    async disconnect() {
      if (validating) throw new Error('Validation is in progress. Please retry.');
      if (!store.available()) throw new Error('Unlock OS secret storage before disconnecting AI.');
      // Unlink the provider while retaining the key in Credentials.
      await store.delete(reference);
    },
    async select(id: unknown): Promise<{ ok: boolean; message?: string }> {
      if (validating) return { ok: false, message: 'Validation is already in progress.' };
      validating = true;
      try {
        if (!(await checkInstallation(true)).installed) return { ok: false, message: 'OpenCode is not installed. Install it and check again.' };
        const { item, key } = await readZen(id);
        const previous = await store.get(reference);
        if (previous && JSON.parse(previous).credentialId === id) await store.delete(reference);
        const error = await validate(key);
        if (error) return { ok: false, message: error };
        const current = await readZen(id);
        if (current.item.updatedAt !== item.updatedAt || current.item.value !== item.value) return { ok: false, message: 'Credential changed during validation. Please retry.' };
        await store.set(reference, JSON.stringify({ credentialId: id, fingerprint: fingerprint(item.value), validatedAt: new Date().toISOString() }));
        return { ok: true };
      } catch { return { ok: false, message: 'Choose an OpenCode Zen credential and check OS secret storage.' }; }
      finally { validating = false; }
    },
    async status(): Promise<AiConnectionState> {
      const runtime = await checkInstallation();
      if (!runtime.installed) return { provider: 'opencode', status: 'disconnected', ...runtime, message: 'Not installed' };
      try {
        const raw = await store.get(reference);
        if (!raw) return { provider: 'opencode', status: 'disconnected', ...runtime };
        const saved = JSON.parse(raw);
        let connected = false;
        try { const { item } = await readZen(saved.credentialId); connected = !!saved.validatedAt && saved.fingerprint === fingerprint(item.value); } catch { /* Deleted or no longer a Zen credential. */ }
        return { provider: 'opencode', status: connected ? 'connected' : 'disconnected', ...runtime };
      } catch { return { provider: 'opencode', status: 'error', ...runtime, message: 'Could not check your saved API key. Check OS secret storage.' }; }
    },
  };
}
