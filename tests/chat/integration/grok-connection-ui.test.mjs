import { closeDesktop } from '../../helpers/desktop.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { stopHost } from '../../helpers/host.mjs';

test('main app connects and disconnects Grok without diagnostic test UI', { timeout: 40000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-grok-ui-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(8000);
    await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      for (const name of ['connections:status', 'ai:status', 'ai:start', 'ai:reopen', 'ai:cancel', 'ai:disconnect', 'ai:grok-test', 'ai:grok-test-cancel']) ipcMain.removeHandler(name);
      let grok = { provider: 'grok', installed: true, status: 'disconnected' };
      globalThis.grokTests = 0;
      ipcMain.handle('connections:status', () => ({ ok: true, connection: { status: 'connected', checkedAt: null, accounts: [{ id: 'synthetic-account', maskedNumber: '••1234', agenticAllowed: true, selected: true }] } }));
      ipcMain.handle('ai:status', () => [{ provider: 'chatgpt', installed: true, status: 'connected' }, { provider: 'claude', installed: true, status: 'disconnected' }, grok]);
      ipcMain.handle('ai:start', (_event, provider) => {
        if (provider !== 'grok') throw new Error('Unexpected provider');
        grok = { provider: 'grok', installed: true, status: 'pending', verificationUrl: 'https://auth.x.ai/device', userCode: 'TEST2345' };
        return grok;
      });
      ipcMain.handle('ai:reopen', () => { grok = { provider: 'grok', installed: true, status: 'connected' }; });
      ipcMain.handle('ai:cancel', () => {});
      ipcMain.handle('ai:disconnect', () => { grok = { provider: 'grok', installed: true, status: 'disconnected' }; });
      ipcMain.handle('ai:grok-test', () => ++globalThis.grokTests === 1
        ? { ok: false, message: 'Grok reported a billing or credit restriction. No plan was purchased.' }
        : { ok: true, message: 'Connection verified. Grok responded successfully.' });
      ipcMain.handle('ai:grok-test-cancel', () => {});
    });
    await page.reload();
    await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Grok', exact: true }).click();
    await page.getByLabel('Grok device code', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Grok device code', { exact: true }).textContent(), 'TEST2345');
    await page.getByRole('button', { name: /Open Grok sign-in/ }).click(); // Synthetic IPC; never opens browser.
    await page.getByRole('button', { name: 'Disconnect Grok', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Test Grok access', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: 'Grok access test', exact: true }).count(), 0);
    assert.equal(await app.evaluate(() => globalThis.grokTests), 0);
    await page.getByRole('button', { name: 'Disconnect Grok', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Grok', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Test Grok access', exact: true }).count(), 0);
  } finally {
    if (app) await closeDesktop(app);
    await stopHost(profile);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
