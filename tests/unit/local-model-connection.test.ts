import { test, expect } from 'vitest';
import { createLocalModelConnection, normalizeLocalBaseUrl } from '../../src/main/local-model-connection';
import type { SecretStore } from '../../src/main/secret-store';

function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, available: () => true, has: async key => values.has(key), get: async key => values.get(key), set: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } };
}
const installed = async () => ({ installed: true, version: '1.14.25' });
const models = (ids: string[]) => (async () => Response.json({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) })) as unknown as typeof fetch;

test('local base URLs are loopback-only and default to /v1', () => {
  expect(normalizeLocalBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1');
  expect(normalizeLocalBaseUrl(' http://localhost:1234/v1/ ')).toBe('http://localhost:1234/v1');
  expect(normalizeLocalBaseUrl('http://[::1]:8000/v1')).toBe('http://[::1]:8000/v1');
  for (const bad of ['http://192.168.1.5:11434/v1', 'https://api.openai.com/v1', 'file:///tmp/x', 'http://user:pw@127.0.0.1/v1', 'http://127.0.0.1/v1?x=1', 'not a url', 42])
    expect(normalizeLocalBaseUrl(bad)).toBeUndefined();
});

test('connecting checks the server, saves the URL and lists models without image claims', async () => {
  const store = memoryStore();
  const local = createLocalModelConnection(store, installed, models(['qwen3:8b', 'llama3.2']));
  expect((await local.status()).status).toBe('disconnected');
  expect(await local.connect('http://127.0.0.1:11434')).toEqual({ ok: true });
  expect(await local.baseUrl()).toBe('http://127.0.0.1:11434/v1');
  expect(await local.status()).toMatchObject({ provider: 'local', status: 'connected', installed: true });
  const listed = await local.models();
  expect(listed.map(m => m.value)).toEqual(['qwen3:8b', 'llama3.2']);
  expect(listed.every(m => m.imageInput === undefined)).toBe(true);
  await local.disconnect();
  expect((await local.status()).status).toBe('disconnected');
  await expect(local.baseUrl()).rejects.toThrow(/Connect a local model server/);
});

test('connection fails safely for remote URLs, missing OpenCode, unreachable or empty servers', async () => {
  const store = memoryStore();
  expect((await createLocalModelConnection(store, installed, models(['m'])).connect('https://example.com/v1')).ok).toBe(false);
  expect((await createLocalModelConnection(store, async () => ({ installed: false }), models(['m'])).connect('http://127.0.0.1:11434')).message).toMatch(/not installed/);
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  expect((await createLocalModelConnection(store, installed, down).connect('http://127.0.0.1:11434')).message).toMatch(/Could not reach/);
  expect((await createLocalModelConnection(store, installed, models([])).connect('http://127.0.0.1:11434')).message).toMatch(/no models/);
  expect(store.values.size).toBe(0);
});
