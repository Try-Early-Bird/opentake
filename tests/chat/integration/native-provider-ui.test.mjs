import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { stopHost } from '../../helpers/host.mjs';

// Covers startup, two provider flows, and both desktop/host shutdown. Retain the
// five-second UI waits but allow the whole fixture to finish on Windows CI.
test('connected Codex and OpenCode selections send through takes and show compatibility errors', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-native-ui-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    t.diagnostic('Starting disposable desktop');
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      globalThis.nativeRequests = [];
      for (const name of ['ai:status', 'chat:models', 'takes:send']) ipcMain.removeHandler(name);
      ipcMain.handle('ai:status', () => ['claude', 'chatgpt', 'opencode'].map(provider => ({ provider, status: 'connected' })));
      ipcMain.handle('chat:models', (_event, provider) => ({ ok: true, source: 'runtime', models: [{ value: provider + '-fixture', label: provider + ' fixture', imageInput: true }] }));
      ipcMain.handle('takes:send', (_event, request) => {
        globalThis.nativeRequests.push(request);
        throw new Error('Synthetic unsupported CLI version. Update the adapter before retrying.');
      });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    for (const [provider, label] of [['chatgpt', 'ChatGPT'], ['opencode', 'OpenCode Zen']]) {
      t.diagnostic(`Checking synthetic ${provider} selection`);
      await page.getByRole('button', { name: 'Choose AI model', exact: true }).click();
      await page.getByRole('menuitemradio', { name: provider + ' fixture', exact: true }).click();
      const input = page.getByLabel('Message ' + label, { exact: true });
      await input.fill('Synthetic ' + provider + ' request');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.locator('form [role=alert]').filter({ hasText: 'Synthetic unsupported CLI version' }).waitFor();
      assert.equal(await input.inputValue(), 'Synthetic ' + provider + ' request');
      assert.equal(await page.getByText(/coming soon|execution is not available/i).count(), 0);
    }
    const requests = await app.evaluate(() => globalThis.nativeRequests);
    assert.deepEqual(requests.map(r => r.selection), [
      { provider: 'chatgpt', model: 'chatgpt-fixture' },
      { provider: 'opencode', model: 'opencode-fixture' },
    ]);
    assert.equal(requests[0].takeId, requests[1].takeId);
  } finally {
    t.diagnostic('Closing disposable desktop and host');
    if (app) await closeDesktop(app);
    await stopHost(profile); await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('ChatGPT connects to a usable default and a new take can send while another runs', { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-parallel-ui-')); let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      const takes = new Map(); const active = new Set(); let revision = 0;
      globalThis.parallelRequests = [];
      globalThis.connectedFixture = false;
      for (const name of ['ai:status', 'chat:models', 'takes:create', 'takes:update', 'takes:snapshot', 'takes:send', 'takes:stop']) ipcMain.removeHandler(name);
      ipcMain.handle('ai:status', () => globalThis.connectedFixture ? [{ provider: 'chatgpt', status: 'connected' }] : []);
      ipcMain.handle('chat:models', () => ({ ok: true, source: 'runtime', models: [{ value: 'gpt-fixture', label: 'GPT fixture' }] }));
      ipcMain.handle('takes:create', () => {
        const id = crypto.randomUUID();
        takes.set(id, { id, title: 'New Take', draft: '', draftImages: [], messages: [], headId: null, archivedAt: null, selection: { provider: 'claude', model: 'default' } });
        revision++; return id;
      });
      ipcMain.handle('takes:update', (_event, id, patch) => { Object.assign(takes.get(id), patch); revision++; });
      ipcMain.handle('takes:snapshot', (_event, id) => ({ revision: `fixture:${revision}:${id}:false`, takes: [...takes.values()], take: takes.get(id) ?? null, running: active.has(id), activeTakeIds: [...active], activeTakeId: active.has(id) ? id : null }));
      ipcMain.handle('takes:send', (_event, request) => {
        globalThis.parallelRequests.push(request);
        active.add(request.takeId); revision++;
      });
      ipcMain.handle('takes:stop', (_event, id) => { active.delete(id); revision++; });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    await app.evaluate(() => { globalThis.connectedFixture = true; });
    await page.getByRole('button', { name: 'Choose AI model', exact: true }).filter({ hasText: 'GPT fixture' }).waitFor();
    await page.getByLabel('Message ChatGPT', { exact: true }).fill('First independent take');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New Take', exact: true }).first().click();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    await page.getByLabel('Message ChatGPT', { exact: true }).fill('Second independent take');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    const requests = await app.evaluate(() => globalThis.parallelRequests);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].takeId, requests[1].takeId);
    assert.ok(requests.every(request => request.parentId === null && request.selection.provider === 'chatgpt' && request.selection.model === 'gpt-fixture'));
  } finally {
    if (app) await closeDesktop(app);
    await stopHost(profile); await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
