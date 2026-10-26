import { expect, test, vi } from 'vitest';
import { createCredentials } from '../../src/main/credentials';
import { createOpenCodeConnection, validateZenKey } from '../../src/main/opencode-connection';
import type { SecretStore } from '../../src/main/secret-store';

test('OpenCode requires installation and successful validation, invalidates edited and deleted credentials', async () => {
  const records = new Map<string, string>();
  const store: SecretStore = { available: () => true, get: async id => records.get(id) ?? null, set: async (id, value) => { records.set(id, value); }, has: async id => records.has(id), delete: async id => { records.delete(id); } };
  const credentials = createCredentials(store);
  let installed = false;
  const validate = vi.fn(async (_key: string): Promise<string | undefined> => 'Invalid key');
  const service = createOpenCodeConnection(store, async () => ({ installed, version: '1.18.4' }), validate);
  const [key] = await credentials.save({ name: 'Zen', type: 'ai-provider', provider: 'OpenCode Zen', value: JSON.stringify({ provider: 'OpenCode Zen', apiKey: 'synthetic-test-key', baseUrl: '' }) });
  expect((await service.status()).installed).toBe(false);
  expect((await service.select(key.id)).ok).toBe(false); expect(validate).not.toHaveBeenCalled();
  installed = true;
  expect((await service.select(key.id)).ok).toBe(false);
  expect((await service.status()).status).toBe('disconnected');
  validate.mockResolvedValue(undefined);
  expect((await service.select(key.id)).ok).toBe(true);
  expect((await service.status()).status).toBe('connected');
  expect(await service.chatKey()).toBe('synthetic-test-key');
  expect(records.get('ai:opencode:credential:v1')).not.toContain('synthetic-test-key');
  await credentials.save({ ...key, value: JSON.stringify({ provider: 'OpenCode Zen', apiKey: 'replacement', baseUrl: '' }) });
  expect((await service.status()).status).toBe('disconnected');
  await expect(service.chatKey()).rejects.toThrow('Reconnect');
  expect((await service.select(key.id)).ok).toBe(true);
  await credentials.remove(key.id);
  expect((await service.status()).status).toBe('disconnected');
  const [other] = await credentials.save({ name: 'Other', type: 'ai-provider', provider: 'OpenAI', value: JSON.stringify({ provider: 'OpenAI', apiKey: 'synthetic' }) });
  expect((await service.select(other.id)).ok).toBe(false);
});

test('Zen validation distinguishes auth, billing, rate limit, malformed success and network errors without leaking output', async () => {
  for (const [status, message] of [[401, 'Invalid'], [402, 'billing'], [403, 'permissions'], [429, 'quota'], [500, 'could not']] as const) {
    const request = vi.fn(async () => new Response('sensitive-provider-output', { status }));
    expect(await validateZenKey('synthetic-key', request as typeof fetch)).toContain(message);
    expect(request.mock.calls).toHaveLength(1);
  }
  expect(await validateZenKey('synthetic-key', (async () => { throw new Error('secret-output'); }) as typeof fetch)).toContain('network');
  expect(await validateZenKey('synthetic-key', (async () => Response.json({})) as typeof fetch)).toContain('unexpected');
  const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ type: 'message', content: [{ type: 'text', text: 'OK' }] }));
  expect(await validateZenKey('synthetic-key', request as typeof fetch)).toBeUndefined();
  expect(request.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/messages');
  expect(request.mock.calls[0][1]?.redirect).toBe('error');
});

test('disconnect unlinks OpenCode without deleting its saved credential', async () => {
  const records = new Map<string, string>();
  const store: SecretStore = { available: () => true, get: async id => records.get(id) ?? null, set: async (id, value) => { records.set(id, value); }, has: async id => records.has(id), delete: async id => { records.delete(id); } };
  const credentials = createCredentials(store);
  const [key] = await credentials.save({ name: 'Zen', type: 'ai-provider', provider: 'OpenCode Zen', value: JSON.stringify({ provider: 'OpenCode Zen', apiKey: 'synthetic-test-key' }) });
  const service = createOpenCodeConnection(store, async () => ({ installed: true }), async () => undefined);
  await service.select(key.id);
  await service.disconnect();
  await expect(service.chatKey()).rejects.toThrow('Connect OpenCode');
  expect((await service.status()).status).toBe('disconnected');
  expect((await credentials.aiCredential(key.id)).name).toBe('Zen');
});
