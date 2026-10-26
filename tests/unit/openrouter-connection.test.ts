import { expect, test, vi } from 'vitest';
import { createCredentials } from '../../src/main/credentials';
import { createOpenRouterConnection, validateOpenRouterKey } from '../../src/main/openrouter-connection';
import type { SecretStore } from '../../src/main/secret-store';

function memory(): SecretStore & { records: Map<string, string> } {
  const records = new Map<string, string>();
  return { records, available: () => true, get: async id => records.get(id) ?? null, set: async (id, value) => { records.set(id, value); }, has: async id => records.has(id), delete: async id => { records.delete(id); } };
}
const keyValue = (apiKey: string, baseUrl = '') => JSON.stringify({ provider: 'OpenRouter', apiKey, baseUrl });

test('OpenRouter requires OpenCode and a validated OpenRouter key, and invalidates edited or deleted keys', async () => {
  const store = memory(); const credentials = createCredentials(store);
  let installed = false;
  const validate = vi.fn(async (_key: string): Promise<string | undefined> => 'Invalid key');
  const service = createOpenRouterConnection(store, async () => ({ installed, version: '1.14.25' }), validate);
  const [key] = await credentials.save({ name: 'OpenRouter', type: 'ai-provider', provider: 'OpenRouter', value: keyValue('sk-or-synthetic') });
  expect((await service.status())).toMatchObject({ provider: 'openrouter', installed: false });
  expect((await service.select(key.id)).ok).toBe(false); expect(validate).not.toHaveBeenCalled();
  installed = true;
  expect((await service.select(key.id)).ok).toBe(false);
  validate.mockResolvedValue(undefined);
  expect((await service.select(key.id)).ok).toBe(true);
  expect((await service.status()).status).toBe('connected');
  expect(await service.chatKey()).toBe('sk-or-synthetic');
  expect(store.records.get('ai:openrouter:credential:v1')).not.toContain('sk-or-synthetic');
  await credentials.save({ ...key, value: keyValue('replacement') });
  expect((await service.status()).status).toBe('disconnected');
  await expect(service.chatKey()).rejects.toThrow('Reconnect');
  await credentials.remove(key.id);
  expect((await service.status()).status).toBe('disconnected');
  const [zen] = await credentials.save({ name: 'Zen', type: 'ai-provider', provider: 'OpenCode Zen', value: JSON.stringify({ provider: 'OpenCode Zen', apiKey: 'synthetic' }) });
  const [custom] = await credentials.save({ name: 'Proxy', type: 'ai-provider', provider: 'OpenRouter', value: keyValue('sk-or-synthetic', 'https://proxy.example/v1') });
  expect((await service.select(zen.id)).ok).toBe(false);
  expect((await service.select(custom.id)).ok).toBe(false);
});

test('OpenRouter validation uses the free key endpoint and reports failures without provider output', async () => {
  for (const [status, message] of [[401, 'Invalid'], [402, 'credits'], [429, 'rate limiting'], [500, 'could not']] as const) {
    const request = vi.fn(async () => new Response('sensitive-provider-output', { status }));
    const result = await validateOpenRouterKey('sk-or-synthetic', request as typeof fetch);
    expect(result).toContain(message); expect(result).not.toContain('sensitive');
  }
  expect(await validateOpenRouterKey('k', (async () => { throw new Error('secret-output'); }) as typeof fetch)).toContain('network');
  expect(await validateOpenRouterKey('k', (async () => Response.json({})) as typeof fetch)).toContain('unexpected');
  const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ data: { label: 'synthetic', usage: 0 } }));
  expect(await validateOpenRouterKey('sk-or-synthetic', request as typeof fetch)).toBeUndefined();
  expect(request.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/key');
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer sk-or-synthetic' } });
  expect(request.mock.calls[0][1]?.method).toBeUndefined();
});
