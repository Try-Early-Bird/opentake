import { expect, test } from 'vitest';
import { createCredentials } from '../../src/main/credentials';
import type { SecretStore } from '../../src/main/secret-store';
import { validateCredentialPayload, type CredentialType } from '../../src/shared/credentials';

test('category forms validate structured payloads without exposing them in metadata', () => {
  const fixtures: [CredentialType, object][] = [
    ['ai-provider', { provider: 'OpenAI', baseUrl: '', apiKey: 'fixture' }],
    ['http-api', { url: 'https://example.com', auth: 'Custom header', header: 'X-API-Key', secret: 'fixture' }],
    ['database', { engine: 'PostgreSQL', host: 'localhost', port: '5432', database: 'test', username: 'test', tls: 'Verify certificate', password: 'fixture' }],
    ['key-value', { key: 'TEST', value: 'fixture' }],
  ];
  for (const [type, fields] of fixtures) {
    expect(() => validateCredentialPayload(type, JSON.stringify(fields))).not.toThrow();
    expect(() => validateCredentialPayload(type, '{}')).toThrow();
  }
  expect(() => validateCredentialPayload('http-api', JSON.stringify({ url: 'file:///private', auth: 'Bearer token', secret: 'x' }))).toThrow();
  expect(() => validateCredentialPayload('database', JSON.stringify({ ...fixtures[2][1], port: '99999' }))).toThrow();
});

test('AI fields cover Zen, Grok, OpenAI scoping and custom providers without breaking legacy records', () => {
  for (const provider of ['OpenCode Zen', 'xAI (Grok)', 'OpenAI', 'Anthropic', 'Google']) {
    expect(() => validateCredentialPayload('ai-provider', JSON.stringify({ provider, baseUrl: '', apiKey: 'test-only-key' }), true)).not.toThrow();
  }
  expect(() => validateCredentialPayload('ai-provider', JSON.stringify({ provider: 'OpenAI', baseUrl: '', apiKey: 'test', organization: 'org-test', project: 'proj-test' }), true)).not.toThrow();
  const custom = { provider: 'Other', baseUrl: '', apiKey: 'test' };
  expect(() => validateCredentialPayload('ai-provider', JSON.stringify(custom))).not.toThrow();
  expect(() => validateCredentialPayload('ai-provider', JSON.stringify(custom), true)).toThrow();
  const valid = { ...custom, baseUrl: 'http://localhost:8080/v1', apiFormat: 'OpenAI-compatible' };
  expect(() => validateCredentialPayload('ai-provider', JSON.stringify(valid), true)).not.toThrow();
  for (const baseUrl of ['http://example.com/v1', 'https://example.com/v1?key=test', 'https://user:pass@example.com']) {
    expect(() => validateCredentialPayload('ai-provider', JSON.stringify({ ...valid, baseUrl }), true)).toThrow();
  }
});

test('credential inventory persists edits, omits values, serializes updates and rejects bad input', async () => {
  const records = new Map<string, string>();
  const store: SecretStore = { available: () => true, get: async id => records.get(id) ?? null, set: async (id, value) => { records.set(id, value); }, has: async id => records.has(id), delete: async id => { records.delete(id); } };
  const service = createCredentials(store);
  await expect(service.save({ name: 'Disabled database', provider: 'PostgreSQL', type: 'database', value: JSON.stringify({ engine: 'PostgreSQL', host: 'localhost', port: '5432', database: 'test', username: 'test', tls: 'Verify certificate', password: 'fixture' }) })).rejects.toThrow(/disabled/);
  const [first] = await service.save({ name: 'Test data', provider: 'Test provider', type: 'api-key', value: 'secret-fixture' });
  expect(first).not.toHaveProperty('value');
  expect(JSON.stringify(await service.list())).not.toContain('secret-fixture');
  await service.save({ ...first, name: 'Renamed' });
  expect(records.get('credentials:v1')).toContain('secret-fixture');
  await service.save({ ...first, name: 'Renamed', value: 'replacement-fixture' });
  expect(records.get('credentials:v1')).not.toContain('secret-fixture');
  expect((await createCredentials(store).list())[0].name).toBe('Renamed');
  await expect(service.save({ name: 'Bad', provider: 'Test', type: 'seed-phrase', value: 'no' })).rejects.toThrow();
  await expect(service.save({ name: 'Bad', provider: 'Test', type: 'api-key', value: 'x'.repeat(4097) })).rejects.toThrow();
  await expect(service.save({ name: 'Renamed', provider: 'Test', type: 'api-key', value: 'duplicate' })).rejects.toThrow();
  await Promise.all([service.save({ name: 'A', provider: 'Test', type: 'bearer-token', value: 'a' }), service.save({ name: 'B', provider: 'Test', type: 'api-key', value: 'b' })]);
  expect(await service.list()).toHaveLength(3);
  await service.remove(first.id);
  expect(await service.list()).toHaveLength(2);
  const before = records.get('credentials:v1');
  await expect(service.remove('../unsafe')).rejects.toThrow();
  expect(records.get('credentials:v1')).toBe(before);
  records.set('credentials:v1', 'corrupt');
  await expect(service.list()).rejects.toThrow();
  await expect(service.save({ name: 'C', provider: 'Test', type: 'api-key', value: 'c' })).rejects.toThrow();
  expect(records.get('credentials:v1')).toBe('corrupt');
  await service.flush();
});
