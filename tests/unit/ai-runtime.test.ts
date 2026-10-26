import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAiCli } from '../../src/main/ai-runtime';
import { createAiConnections } from '../../src/main/ai-connections';

test('local CLI resolution uses PATH executables without running them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-cli-test-'));
  try {
    for (const name of ['claude', 'codex']) {
      const file = join(root, name + (process.platform === 'win32' ? '.exe' : ''));
      await writeFile(file, 'synthetic fixture, never execute'); await chmod(file, 0o700);
    }
    expect(resolveAiCli('claude', { PATH: root }, root).executable).toBe(join(root, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    expect(resolveAiCli('chatgpt', { PATH: root }, root).args).toEqual([]);
    await mkdir(join(root, '.local', 'bin'), { recursive: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing installations block sign-in and retain saved connections', async () => {
  let touched = false;
  const store = { available: () => true, has: async () => true, get: async () => null, set: async () => { touched = true; }, delete: async () => { touched = true; } };
  const service = createAiConnections(store, async () => { throw new Error('must not launch'); }, async () => {}, () => false);
  expect((await service.status()).every(item => item.installed === false && item.message === 'Not installed')).toBe(true);
  expect((await service.start('claude')).status).toBe('error');
  expect(touched).toBe(false);
});
