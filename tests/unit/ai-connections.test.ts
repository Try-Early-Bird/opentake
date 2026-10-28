vi.mock('../../src/main/ai-runtime', () => ({ resolveAiCli: () => ({ executable: '/synthetic/cli', args: [] }) }));
import { expect, test, vi } from 'vitest';
import { createAiConnections, type AiLoginFactory } from '../../src/main/ai-connections';
import { parseLoginOutput, createLocalAiLogin, loginCommand } from '../../src/main/ai-login';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const claude = JSON.stringify({ version: 1, kind: 'oauth_token', token: `sk-ant-oat01-${'synthetic'.repeat(8)}` });
const chatgpt = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } });
function memory() {
  const values = new Map<string, string>();
  return { values, available: () => true, get: async (key: string) => values.get(key) ?? null,
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }), has: async (key: string) => values.has(key), delete: async (key: string) => { values.delete(key); } };
}
const waitFor = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out'); };

test('provider login persists validated credentials, exposes only status and reuses connections after restart', async () => {
  const store = memory(); const browser = vi.fn(async () => {}); let resolve!: (value: string) => void;
  const submit = vi.fn();
  const factory: AiLoginFactory = async (_provider, progress) => {
    progress({ verificationUrl: 'https://claude.com/oauth/authorize?state=synthetic' });
    return { done: new Promise(yes => { resolve = yes; }), submit, cancel: async () => resolve(claude) };
  };
  const service = createAiConnections(store, factory, browser);
  expect((await service.status()).every(s => s.status === 'disconnected')).toBe(true);
  await service.start('claude'); await waitFor(async () => (await service.status())[1].status === 'pending');
  await service.reopen(); expect(browser).toHaveBeenCalledWith('https://claude.com/oauth/authorize?state=synthetic');
  service.submitCode('claude', 'synthetic-code#state'); expect(submit).toHaveBeenCalledWith('synthetic-code#state');
  resolve(claude); await waitFor(async () => (await service.status())[1].status === 'connected');
  expect(store.set).toHaveBeenCalledWith('ai:subscription:v1:claude', claude);
  expect(JSON.stringify(await service.status())).not.toMatch(/sk-ant|verificationUrl/);
  expect((await createAiConnections(store, factory, browser).status())[1].status).toBe('connected');
});

test('cancel prevents late credential writes; invalid providers and unlocked storage are enforced', async () => {
  const store = memory(); let resolve!: (value: string) => void;
  const factory: AiLoginFactory = async () => ({ done: new Promise(yes => { resolve = yes; }), submit() {}, cancel: async () => resolve(chatgpt) });
  const service = createAiConnections(store, factory, async () => {});
  await expect(service.start('unknown')).rejects.toThrow();
  await service.start('chatgpt'); await waitFor(async () => !!resolve);
  await expect(service.start('claude')).rejects.toThrow('in progress');
  expect(() => service.submitCode('chatgpt', 'synthetic-code')).toThrow();
  await service.cancel(); expect(store.set).not.toHaveBeenCalled();
  expect((await service.status())[0].status).toBe('disconnected');
  store.available = () => false;
  expect((await service.start('claude')).status).toBe('error');
});

test('provider failures and credential validation never leak output; retry succeeds', async () => {
  const store = memory(); let attempt = 0;
  const service = createAiConnections(store, async (_provider, progress) => {
    progress({ verificationUrl: 'https://attacker.test/oauth' });
    return { done: Promise.resolve(++attempt === 1 ? '{"token":"synthetic-invalid"}' : chatgpt), submit() {}, cancel: async () => {} };
  }, async () => {});
  await service.start('chatgpt'); await waitFor(async () => (await service.status())[0].status === 'error');
  expect(store.set).not.toHaveBeenCalled();
  expect(JSON.stringify(await service.status())).not.toMatch(/attacker|synthetic-invalid/);
  await service.start('chatgpt'); await waitFor(async () => (await service.status())[0].status === 'connected');
});

test('output parsers distinguish browser code direction and only accept provider URLs', () => {
  expect(parseLoginOutput('chatgpt', '\u001b[32mhttps://auth.openai.com/codex/device\nABCD-12345\n')).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' });
  const value = parseLoginOutput('claude', `https://claude.com/oauth/authorize?state=synthetic\n${JSON.parse(claude).token}\n`);
  expect(value.credential).toBe(claude);
  expect(parseLoginOutput('claude', 'https://claude.com.attacker.test/oauth').verificationUrl).toBeUndefined();
  // Resolve injected local runtime paths without executing either real CLI.
  expect(loginCommand('claude').args).toEqual(['setup-token']);
  expect(loginCommand('chatgpt').args.slice(-2)).toEqual(['login', '--device-auth']);
});

test('real PTY with synthetic login programs isolates homes and cleans credentials on success and cancel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-ai-fixture-'));
  const script = join(root, 'fixture.cjs');
  await writeFile(script, `const fs = require('node:fs');
    if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) process.exit(1);
    if (process.argv[2] === 'chatgpt') {
      console.log('https://auth.openai.com/codex/device\\nABCD-12345');
      fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', ${JSON.stringify(chatgpt)});
    } else {
      console.log('https://claude.com/oauth/authorize?state=synthetic');
      process.stdin.on('data', () => { console.log(${JSON.stringify(JSON.parse(claude).token)}); });
    }
    setInterval(() => {}, 1000);`);
  const tempRoot = join(root, 'logins');
  const factory = createLocalAiLogin(tempRoot, provider => ({ executable: process.execPath, args: [script, provider] }));
  try {
    const first = await factory('chatgpt', () => {}); expect(await first.done).toBe(chatgpt);
    expect(await readdir(tempRoot)).toEqual([]);
    let ready = false;
    const second = await factory('claude', () => { ready = true; });
    await waitFor(async () => ready); second.submit('synthetic-code'); expect(await second.done).toBe(claude);
    const third = await factory('claude', () => {}); await third.cancel(); await expect(third.done).rejects.toThrow();
    expect(await readdir(tempRoot)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('Claude paste requires a delayed standalone Enter and cancellation stops submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-claude-submit-'));
  const script = join(root, 'fixture.cjs');
  await writeFile(script, `
    process.stdin.setRawMode(true);
    let pastedAt;
    console.log('https://claude.com/oauth/authorize?state=synthetic');
    process.stdin.on('data', data => {
      if (pastedAt === undefined) { pastedAt = Date.now(); return; }
      if (Date.now() - pastedAt >= 500 && data.toString() === String.fromCharCode(13)) {
        console.log(${JSON.stringify(JSON.parse(claude).token)});
      }
    });
    setInterval(() => {}, 1000);
  `);
  const tempRoot = join(root, 'logins');
  const factory = createLocalAiLogin(tempRoot, () => ({ executable: process.execPath, args: [script] }));
  let login: Awaited<ReturnType<typeof factory>> | undefined;
  try {
    let ready = false;
    login = await factory('claude', () => { ready = true; });
    await waitFor(async () => ready);
    login.submit('synthetic-code#state');
    expect(await login.done).toBe(claude);
    expect(await readdir(tempRoot)).toEqual([]);
    ready = false;
    login = await factory('claude', () => { ready = true; });
    await waitFor(async () => ready);
    login.submit('synthetic-code#state');
    await login.cancel();
    await expect(login.done).rejects.toThrow();
    expect(await readdir(tempRoot)).toEqual([]);
  } finally { await login?.cancel(); await rm(root, { recursive: true, force: true }); }
});

test('a saved sign-in that can no longer be read asks to sign in again', async () => {
  const store = memory();
  store.values.set('ai:subscription:v1:claude', claude);
  // Mirrors SecretStore.has(), which decrypts the record and throws when it cannot.
  store.has = async (key: string) => { if (key === 'ai:subscription:v1:claude') throw new Error('Secret could not be read'); return store.values.has(key); };
  const service = createAiConnections(store, vi.fn(), async () => {});
  const claudeState = (await service.status()).find(item => item.provider === 'claude');
  expect(claudeState).toMatchObject({ status: 'error', message: 'Sign in to Claude again to keep using it.' });
  expect(claudeState?.message).not.toMatch(/storage|unlock/i);
});

test('disconnect removes only the selected subscription and rejects invalid providers or locked storage', async () => {
  const store = memory();
  store.values.set('ai:subscription:v1:claude', claude);
  store.values.set('ai:subscription:v1:chatgpt', chatgpt);
  const service = createAiConnections(store, vi.fn(), async () => {});
  await expect(service.disconnect('unknown')).rejects.toThrow('Unknown AI provider');
  store.available = () => false;
  await expect(service.disconnect('claude')).rejects.toThrow('Could not disconnect right now');
  expect(store.values.size).toBe(2);
  store.available = () => true;
  await service.disconnect('claude');
  expect((await service.status()).map(item => item.status)).toEqual(['connected', 'disconnected', 'disconnected']);
  await service.disconnect('claude');
  expect(store.values.size).toBe(1);
});
