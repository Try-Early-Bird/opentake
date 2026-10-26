import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { stopHost } from './helpers/host.mjs';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';

test('connection onboarding and settings reflect disconnected, connected, reauth and unavailable states', { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-connections-settings-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(5000);
    // Real empty disposable database: prompt opens automatically and cannot be dismissed.
    const prompt = page.getByRole('dialog', { name: 'Connect a trading platform' });
    await prompt.waitFor();
    assert.equal(await prompt.getByRole('button', { name: 'Close dialog' }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await prompt.isVisible(), true);
    await page.mouse.click(5, 5);
    assert.equal(await prompt.isVisible(), true);
    // A system-browser close emits no event; allow reopen and Back without a new attempt.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('connections:connect');
      ipcMain.removeHandler('connections:cancel');
      ipcMain.removeHandler('connections:reopen');
      let finish;
      ipcMain.handle('connections:connect', () => new Promise(resolve => { finish = resolve; }));
      ipcMain.handle('connections:reopen', () => {});
      ipcMain.handle('connections:cancel', () => { finish?.({ ok: false, message: 'Connection cancelled.' }); });
    });
    await prompt.getByRole('button', { name: /^Robinhood/ }).click();
    await prompt.getByRole('status', { name: 'Connecting to Robinhood' }).waitFor();
    assert.equal(await prompt.locator('svg.animate-spin').count(), 1);
    await prompt.getByRole('link', { name: 'Reopen Robinhood sign-in ↗' }).click();
    await prompt.getByRole('button', { name: '← Back' }).click();
    await prompt.getByText('Sign in to your Robinhood agentic account or create one to get started.', { exact: true }).waitFor();
    assert.equal(await prompt.isVisible(), true);
    assert.equal(await prompt.getByRole('alert').count(), 0);
    assert.equal(await prompt.getByRole('button', { name: 'Close dialog' }).count(), 0);
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('connections:connect');
      ipcMain.handle('connections:connect', () => ({ ok: false, message: 'Synthetic sign-in failure.' }));
    });
    await prompt.getByRole('button', { name: /^Robinhood/ }).click();
    await prompt.getByRole('alert').getByText('Synthetic sign-in failure.').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await prompt.isVisible(), true);
    assert.equal(await prompt.getByRole('button', { name: 'Close dialog' }).count(), 0);
    await dismissConnectionPrompt(page, application);
    async function openSettings() {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor();
      await page.getByText('Robinhood', { exact: true }).waitFor();
    }
    await openSettings();
    await page.getByRole('status').getByText('Not connected', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    for (const [status, label] of [['connected', 'Connected'], ['reauth_required', 'Sign-in required'], ['error', 'Status unavailable']]) {
      await application.evaluate(({ ipcMain }, status) => {
        ipcMain.removeHandler('connections:status');
        ipcMain.handle('connections:status', () => status === 'error' ? { ok: false, message: 'Synthetic status unavailable.' }
          : { ok: true, connection: { status, checkedAt: null, accounts: status === 'connected' ? [{ id: 'synthetic-account', maskedNumber: '••••1234', agenticAllowed: true, selected: true }] : [] } });
      }, status);
      await page.reload();
      if (status === 'reauth_required') {
        // This is also the persisted state left by abandoned first-time OAuth.
        await prompt.waitFor();
        assert.equal(await prompt.getByRole('button', { name: 'Close dialog' }).count(), 0);
        await page.keyboard.press('Escape');
        await page.mouse.click(5, 5);
        assert.equal(await prompt.isVisible(), true);
        await application.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('connections:connect');
          ipcMain.handle('connections:connect', async () => {
            await new Promise(resolve => setTimeout(resolve, 150));
            return { ok: false, message: 'Synthetic sign-in timeout.' };
          });
        });
        await prompt.getByRole('button', { name: /^Robinhood/ }).click();
        await prompt.getByRole('alert').getByText('Synthetic sign-in timeout.').waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await prompt.isVisible(), true);
        assert.equal(await prompt.getByRole('button', { name: 'Close dialog' }).count(), 0);
        // Reload with the same saved status must prompt again.
        await page.reload();
        await prompt.waitFor();
        await dismissConnectionPrompt(page, application);
      }
      await openSettings();
      await page.getByRole('region', { name: 'Trading platforms', exact: true }).getByRole('status').getByText(label, { exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
    }
  } finally { if (application) await application.close(); await stopHost(profile); await rm(profile, { recursive: true, force: true }); }
});
