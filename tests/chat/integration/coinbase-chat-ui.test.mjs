import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { closeDesktop } from '../../helpers/desktop.mjs';
import { stopHost } from '../../helpers/host.mjs';

test('Take chat sends without a Coinbase account pill or hidden account selection', { timeout: 40000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-coinbase-chat-ui-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(6000);
    await page.setViewportSize({ width: 1440, height: 900 }); await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      for (const name of ['coinbase:list','takes:snapshot','takes:create','takes:send','takes:stop','chat:models','ai:status','strategies:read','strategies:available','strategies:message-proposals']) ipcMain.removeHandler(name);
      ipcMain.handle('strategies:read', () => null);
      ipcMain.handle('strategies:available', () => false);
      ipcMain.handle('strategies:message-proposals', () => []);
      const accounts = [{ accountId: '11111111-1111-4111-8111-111111111111', label: 'Primary synthetic', maskedReference: '••••1111', capabilities: { chat: true } }, { accountId: '22222222-2222-4222-8222-222222222222', label: 'Savings synthetic', maskedReference: '••••2222', capabilities: { chat: true } }];
      ipcMain.handle('coinbase:list', () => ({ ok: true, connections: accounts }));
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'connected' }]);
      ipcMain.handle('chat:models', () => ({ ok: true, source: 'runtime', models: [{ value: 'synthetic-model', label: 'Synthetic model' }] }));
      const takes = []; let revision = 0; let counter = 0;
      ipcMain.handle('takes:create', () => { const id = `take-${++counter}`; takes.unshift({ id, title: 'Synthetic Coinbase chat', messages: [], headId: null, draft: '', draftImages: [], archivedAt: null, selection: { provider: 'claude', model: 'synthetic-model' } }); revision++; return id; });
      ipcMain.handle('takes:snapshot', (_event, id) => ({ revision: 'test:' + revision, takes, take: takes.find(t => t.id === id) ?? null, running: takes.some(t => t.running) }));
      ipcMain.handle('takes:send', (_event, request) => {
        globalThis.coinbaseChatRequest = request;
        const take = takes.find(t => t.id === request.takeId), user = `user-${++counter}`, assistant = `assistant-${++counter}`, createdAt = new Date().toISOString();
        take.messages.push({ id: user, parentId: take.headId, role: 'user', text: request.text, images: [], tools: [], createdAt, selection: request.selection, state: 'completed' }, { id: assistant, parentId: user, role: 'assistant', text: 'Which Coinbase account would you like to use?', images: [], tools: [{ id: 'call-1', name: 'coinbase_portfolios_get', state: 'completed', startedAt: createdAt }], createdAt, selection: request.selection, state: 'running' });
        take.headId = assistant; take.running = true; revision++;
      });
      ipcMain.handle('takes:stop', (_event, id) => { const take = takes.find(t => t.id === id); take.running = false; take.messages.at(-1).state = 'cancelled'; revision++; });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    const picker = page.getByRole('combobox', { name: 'Coinbase portfolio', exact: true });
    assert.equal(await picker.count(), 0);
    await page.getByRole('textbox', { name: 'Message Claude', exact: true }).fill('What is my Coinbase balance?');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Which Coinbase account would you like to use?', { exact: true }).waitFor();
    assert.equal((await app.evaluate(() => globalThis.coinbaseChatRequest)).coinbaseAccountRef, undefined);

    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.screenshot({ path: '/tmp/coinbase-chat-desktop.png' });
    await page.setViewportSize({ width: 520, height: 900 });
    await page.screenshot({ path: '/tmp/coinbase-chat-mobile.png' });
    await page.getByRole('button', { name: 'New Take', exact: true }).last().click();
    assert.equal(await picker.count(), 0);
  } finally { if (app) await closeDesktop(app); await stopHost(profile); await rm(profile, { recursive: true, force: true }); }
});
