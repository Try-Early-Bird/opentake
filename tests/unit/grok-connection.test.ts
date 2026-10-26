import { test, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateGrokCredential, validGrokUrl, grokSecretRef, grokEnvironment } from '../../src/main/grok-runtime';
import { parseLoginOutput, createLocalAiLogin } from '../../src/main/ai-login';
import { createAiConnections } from '../../src/main/ai-connections';
import { createGrokAccess, grokAccessOutcome, grokAccessArgs } from '../../src/main/grok-access';
import { resolveAiCli } from '../../src/main/ai-runtime';

const scope = 'https://auth.x.ai::synthetic-client';
const auth = { auth_mode: 'oidc', key: 'synthetic-access', refresh_token: 'synthetic-refresh', oidc_issuer: 'https://auth.x.ai',
  oidc_client_id: 'synthetic-client', create_time: '2026-10-03T00:00:00Z', user_id: 'synthetic-user' };
const credential = JSON.stringify({ [scope]: auth });
function memory() {
  const values = new Map([[grokSecretRef, credential]]);
  return { values, available: () => true, get: async (key: string) => values.get(key) ?? null,
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    has: async (key: string) => values.has(key), delete: async (key: string) => { values.delete(key); },
    compareAndSet: vi.fn(async (key: string, expected: string, value: string) => {
      if (values.get(key) !== expected) return false; values.set(key, value); return true;
    }) };
}

test('Grok validates only the documented xAI OAuth credential envelope', () => {
  expect(() => validateGrokCredential(credential)).not.toThrow();
  // Public device flow can omit id_token and refresh_token.
  expect(() => validateGrokCredential(JSON.stringify({ [scope]: { ...auth, user_id: '', refresh_token: null } }))).not.toThrow();
  for (const value of ['null', '[]', '{}', JSON.stringify({ [scope]: { ...auth, oidc_issuer: 'https://attacker.test' } }),
    JSON.stringify({ [scope]: { ...auth, oidc_client_id: 'different' } }),
    JSON.stringify({ [scope]: { ...auth, refresh_token: 123 } }),
    JSON.stringify({ [scope]: { ...auth, auth_mode: 'api_key' } }), credential + ' '.repeat(17000)]) {
    expect(() => validateGrokCredential(value)).toThrow();
  }
});

test('Grok device codes may be unhyphenated; unsafe verification links and inherited keys are rejected', () => {
  const text = 'To sign in, open this URL in your browser:\nhttps://auth.x.ai/device\nThen enter this code:\nTEST2345\n';
  expect(parseLoginOutput('grok', text)).toEqual({ verificationUrl: 'https://auth.x.ai/device', userCode: 'TEST2345' });
  for (const url of ['https://auth.x.ai.evil.test/device', 'https://user:pw@auth.x.ai/device', 'https://auth.x.ai/device?access_token=synthetic', 'http://auth.x.ai/device']) expect(validGrokUrl(url)).toBe(false);
  expect(validGrokUrl('https://accounts.x.ai/device?user_code=TEST2345')).toBe(true);
  expect(grokEnvironment('/synthetic/home')).not.toHaveProperty('XAI_API_KEY');
  expect(grokEnvironment('/synthetic/home').GROK_HOME).toBe(join('/synthetic/home', '.grok'));
});

test.runIf(process.platform === 'darwin')('Grok login uses an isolated PTY and persists only synthetic credentials on successful exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-login-test-'));
  try {
    const script = join(root, 'fixture.cjs');
    await writeFile(script, `const fs=require('node:fs');
      if(process.env.XAI_API_KEY) process.exit(2);
      console.log('To sign in, open this URL in your browser:\\nhttps://auth.x.ai/device\\nThen enter this code:\\nTEST2345\\n');
      fs.writeFileSync(process.env.GROK_HOME+'/auth.json',${JSON.stringify(credential)});
      setTimeout(()=>process.exit(0),100);`);
    const progress = vi.fn();
    const login = await createLocalAiLogin(join(root, 'logins'), () => ({ executable: process.execPath, args: [script] }))('grok', progress);
    expect(await login.done).toBe(credential);
    expect(progress).toHaveBeenCalledWith({ verificationUrl: 'https://auth.x.ai/device', userCode: 'TEST2345' });
    expect(await readdir(join(root, 'logins'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.runIf(process.platform === 'darwin')('failed Grok exit does not import even a well-shaped synthetic auth file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-login-fail-'));
  try {
    const script = join(root, 'fixture.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(process.env.GROK_HOME+'/auth.json',${JSON.stringify(credential)});process.exit(1);`);
    const login = await createLocalAiLogin(join(root, 'logins'), () => ({ executable: process.execPath, args: [script] }))('grok', () => {});
    await expect(login.done).rejects.toThrow();
    expect(await readdir(join(root, 'logins'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Grok connection stores credentials behind SecretStore and survives service recreation', async () => {
  const store = memory(); store.values.clear();
  const factory = async () => ({ done: Promise.resolve(credential), submit() {}, cancel: async () => {} });
  const service = createAiConnections(store, factory, async () => {});
  await service.start('grok');
  await vi.waitFor(async () => expect((await service.status()).find(s => s.provider === 'grok')?.status).toBe('connected'));
  expect(store.set).toHaveBeenCalledWith(grokSecretRef, credential);
  expect(JSON.stringify(await service.status())).not.toContain('synthetic');
  expect((await createAiConnections(store, factory, async () => {}).status()).find(s => s.provider === 'grok')?.status).toBe('connected');
  await service.disconnect('grok'); expect(store.values.has(grokSecretRef)).toBe(false);
});

test('Grok resolver finds the official bin directory without reading a profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-binary-test-'));
  try {
    await mkdir(join(root, '.grok/bin'), { recursive: true });
    const binary = join(root, '.grok/bin/grok'); await writeFile(binary, 'synthetic executable'); await chmod(binary, 0o700);
    if (process.platform === 'darwin') expect(resolveAiCli('grok', { PATH: '' }, root).executable).toBe(binary);
    else expect(() => resolveAiCli('grok', { PATH: '' }, root)).toThrow('requires macOS');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model access only passes exact output and reduces provider errors to safe categories', () => {
  expect(grokAccessOutcome(0, 'EARLYBIRD_GROK_OK\n', '').ok).toBe(true);
  expect(grokAccessOutcome(0, grokAccessArgs.at(-1)!, '').ok).toBe(false);
  expect(grokAccessOutcome(1, 'EARLYBIRD_GROK_OK', '').ok).toBe(false);
  for (const status of [401, 402, 403, 429, 500]) {
    const result = grokAccessOutcome(1, '', `HTTP ${status} synthetic-private-value`);
    expect(result.ok).toBe(false); expect(result.message).not.toContain('synthetic-private');
  }
});

async function accessFixture(code: string, run: (service: ReturnType<typeof createGrokAccess>, store: ReturnType<typeof memory>, root: string) => Promise<void>, deadlineMs = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'grok-access-test-'));
  const store = memory(); let service: ReturnType<typeof createGrokAccess> | undefined;
  try {
    const script = join(root, 'fixture.cjs'); await writeFile(script, code);
    service = createGrokAccess(store, join(root, 'runs'), { command: () => ({ executable: process.execPath, args: [script] }),
      confine: command => command, version: async () => {}, deadlineMs });
    await run(service, store, root);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
}

test('user-triggered test persists CLI refresh with CAS and cleans its private run home', async () => {
  await accessFixture(`const fs=require('node:fs');const p=process.env.GROK_HOME+'/auth.json';const auth=JSON.parse(fs.readFileSync(p));
    if(process.env.XAI_API_KEY || !process.argv.includes('--no-subagents'))process.exit(1);
    auth[${JSON.stringify(scope)}].refresh_token='synthetic-rotated';fs.writeFileSync(p,JSON.stringify(auth));
    console.log('EARLYBIRD_GROK_OK');`, async (service, store, root) => {
    expect(store.compareAndSet).not.toHaveBeenCalled();
    expect((await service.test()).ok).toBe(true);
    expect(store.compareAndSet).toHaveBeenCalledOnce();
    expect(store.values.get(grokSecretRef)).toContain('synthetic-rotated');
    expect(await readdir(join(root, 'runs'))).toEqual([]);
  });
});

test('refresh cannot overwrite a disconnected or replaced credential', async () => {
  await accessFixture(`const fs=require('node:fs');const p=process.env.GROK_HOME+'/auth.json';const auth=JSON.parse(fs.readFileSync(p));auth[${JSON.stringify(scope)}].key='synthetic-rotated';fs.writeFileSync(p,JSON.stringify(auth));console.log('EARLYBIRD_GROK_OK');`, async (service, store) => {
    store.compareAndSet.mockImplementation(async () => false);
    expect((await service.test()).message).toContain('connection changed');
    expect(store.values.get(grokSecretRef)).toBe(credential);
  });
});

test('no connection means no CLI execution; test deadline kills the synthetic process', async () => {
  await accessFixture('setInterval(()=>{},1000);', async (service, store, root) => {
    store.values.clear(); expect((await service.test()).message).toBe('Connect Grok first.');
    store.values.set(grokSecretRef, credential);
    const run = service.test();
    expect((await service.test()).message).toContain('already running');
    expect((await run).message).toContain('stopped or timed out');
    expect(await readdir(join(root, 'runs'))).toEqual([]);
  }, 40);
});
