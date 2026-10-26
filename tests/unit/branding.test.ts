import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { LocalRobinhoodProvider } from '../../src/main/robinhood-client';

test('Opentake branding preserves existing application identity', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  expect(manifest.build.productName).toBe('Opentake');
  expect(manifest.build.appId).toBe('local.earlybird.oss');
  expect(manifest.name).toBe('opentake');
  const provider = new LocalRobinhoodProvider({ version: 1, ownerId: 'synthetic-owner', connectionId: 'synthetic-connection' }, async () => {});
  expect(provider.clientMetadata.client_name).toBe('Earlybird-Opentake');
  const source = readFileSync(new URL('../../src/main/robinhood-client.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/new Client\(\{\s*name:\s*'Earlybird-Opentake'/);
});
