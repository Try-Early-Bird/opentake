import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { hostRequest, stopHost } from './helpers/host.mjs';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('login startup opens the background host without a desktop window', { timeout: 25000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-login-host-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath, args: ['.', '--earlybird-login', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { status = await hostRequest(profile, 'host:status'); break; }
      catch { await delay(100); }
    }
    assert.ok(status?.pid);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  } finally { await stopHost(profile); if (application) await application.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); }
});

test('launch-at-login UI reads state, toggles, and preserves state on failure', { timeout: 25000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-login-ui-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Launch at login' });
    await page.getByText('Available in the installed app, not development mode.').waitFor();
    assert.equal(await toggle.isDisabled(), true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    // Synthetic IPC fixture; never change the user's OS login registration.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings:login-item:get'); ipcMain.removeHandler('settings:login-item:set');
      let enabled = false; let calls = 0;
      ipcMain.handle('settings:login-item:get', () => ({ supported: true, enabled }));
      ipcMain.handle('settings:login-item:set', (_event, value) => {
        if (++calls === 3) throw new Error('Synthetic failure');
        enabled = value; return { supported: true, enabled };
      });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await toggle.click();
    await page.getByRole('switch', { name: 'Launch at login', checked: true }).waitFor();
    await toggle.click();
    await page.getByRole('switch', { name: 'Launch at login', checked: false }).waitFor();
    await toggle.click();
    await page.getByRole('alert').getByText('Unable to update launch at login. Please try again.').waitFor();
    assert.equal(await toggle.isChecked(), false);
  } finally { if (application) await application.close(); await stopHost(profile); await rm(profile, { recursive: true, force: true }); }
});
