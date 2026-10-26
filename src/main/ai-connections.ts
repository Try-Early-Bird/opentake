import { validGrokUrl, validateGrokCredential } from './grok-runtime';
import type { SecretStore } from './secret-store';
import type { AiConnectionState, AiProvider } from '../shared/ai-connections';

export interface AiLogin {
  done: Promise<string>;
  submit(code: string): void;
  cancel(): Promise<void>;
}
export type AiLoginFactory = (provider: AiProvider, progress: (state: Pick<AiConnectionState, 'verificationUrl' | 'userCode'>) => void) => Promise<AiLogin>;
export function parseAiProvider(value: unknown): AiProvider {
  if (value !== 'chatgpt' && value !== 'claude' && value !== 'grok') throw new Error('Unknown AI provider');
  return value;
}
export function validLoginUrl(provider: AiProvider, value: string): boolean {
  if (provider === 'grok') return validGrokUrl(value);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (provider === 'chatgpt' ? url.hostname === 'auth.openai.com' && url.pathname === '/codex/device'
        : url.hostname === 'claude.com' && url.pathname.includes('oauth'));
  } catch { return false; }
}
export function validateAiCredential(provider: AiProvider, credential: string): void {
  if (provider === 'grok') { validateGrokCredential(credential); return; }
  if (Buffer.byteLength(credential) > 16 * 1024) throw new Error('Credential too large');
  const parsed = JSON.parse(credential);
  if (provider === 'claude') {
    if (parsed.version !== 1 || parsed.kind !== 'oauth_token' || !/^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/.test(parsed.token)) throw new Error('Invalid Claude credential');
  } else if (parsed.auth_mode !== 'chatgpt' || typeof parsed.tokens?.access_token !== 'string' || !parsed.tokens.access_token ||
    typeof parsed.tokens?.refresh_token !== 'string' || !parsed.tokens.refresh_token) throw new Error('Invalid ChatGPT credential');
}
const providers: AiProvider[] = ['chatgpt', 'claude', 'grok'];
const ref = (provider: AiProvider) => `ai:subscription:v1:${provider}`;
export function createAiConnections(store: SecretStore, factory: AiLoginFactory, openBrowser: (url: string) => Promise<void>, installed: (provider: AiProvider) => boolean = () => true) {
  const states = new Map<AiProvider, AiConnectionState>();
  let active: { provider: AiProvider; cancelled: boolean; login?: AiLogin; work: Promise<void> } | undefined;
  async function cancel() {
    const previous = active;
    if (!previous) return;
    previous.cancelled = true;
    await previous.login?.cancel();
    await previous.work;
    if (active === previous) active = undefined;
    states.delete(previous.provider);
  }
  async function status(): Promise<AiConnectionState[]> {
    return Promise.all(providers.map(async provider => {
      if (!installed(provider)) return { provider, installed: false, status: 'disconnected' as const, message: 'Not installed' };
      const state = states.get(provider);
      if (state && state.status !== 'connected') return { ...state };
      try {
        if (!store.available()) return { provider, status: 'error' as const, message: 'Unlock OS secret storage to check AI connections.' };
        const connected = await store.has(ref(provider));
        return { provider, installed: true, status: connected ? 'connected' as const : 'disconnected' as const };
      } catch { return { provider, status: 'error' as const, message: 'Could not read this AI connection. Unlock OS secret storage or reconnect.' }; }
    }));
  }
  return {
    status,
    async disconnect(value: unknown) {
      const provider = parseAiProvider(value);
      if (!store.available()) throw new Error('Unlock OS secret storage before disconnecting AI.');
      if (active?.provider === provider) await cancel();
      await store.delete(ref(provider));
      states.delete(provider);
    },
    async start(value: unknown): Promise<AiConnectionState> {
      const provider = parseAiProvider(value);
      if (!installed(provider)) return { provider, installed: false, status: 'error', message: 'Not installed. Install the CLI and check again.' };
      if (active) throw new Error('Another AI sign-in is in progress');
      if (!store.available()) return { provider, status: 'error', message: 'Unlock OS secret storage before connecting AI.' };
      const entry = { provider, cancelled: false, login: undefined as AiLogin | undefined, work: Promise.resolve() };
      active = entry;
      states.set(provider, { provider, status: 'starting' });
      entry.work = Promise.resolve().then(async () => {
        try {
          entry.login = await factory(provider, progress => {
            if (entry.cancelled || active !== entry) return;
            if (progress.verificationUrl && !validLoginUrl(provider, progress.verificationUrl)) return;
            states.set(provider, { provider, status: 'pending', ...progress });
          });
          if (entry.cancelled) { await entry.login.cancel(); return; }
          const credential = await entry.login.done;
          if (entry.cancelled) return;
          validateAiCredential(provider, credential);
          await store.set(ref(provider), credential);
          states.set(provider, { provider, status: 'connected' });
        } catch {
          if (!entry.cancelled) states.set(provider, { provider, status: 'error', message: 'AI sign-in could not finish. Retry and complete the browser sign-in before it expires.' });
        } finally { if (active === entry) active = undefined; }
      });
      return { provider, status: 'starting' };
    },
    submitCode(provider: unknown, code: unknown) {
      const selected = parseAiProvider(provider);
      if (selected !== 'claude' || active?.provider !== selected || active.cancelled || !active.login ||
        typeof code !== 'string' || !/^[A-Za-z0-9#_-]{8,512}$/.test(code)) throw new Error('Invalid sign-in code or inactive sign-in');
      active.login.submit(code);
    },
    async reopen() {
      const url = active && !active.cancelled ? states.get(active.provider)?.verificationUrl : undefined;
      if (!url || !active || !validLoginUrl(active.provider, url)) throw new Error('Sign-in URL unavailable');
      await openBrowser(url);
    },
    cancel,
    close: cancel,
  };
}
