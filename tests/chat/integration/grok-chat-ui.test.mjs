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

test('connected Grok appears in the picker and sends its model through takes', { timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-native-ui-'));
  let app;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${profile}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, app);
    await app.evaluate(({ ipcMain }) => {
      globalThis.nativeRequests = [];
      for (const name of ['ai:status', 'chat:models', 'takes:send']) ipcMain.removeHandler(name);
      ipcMain.handle('ai:status', () => ['grok'].map(provider => ({ provider, status: 'connected' })));
      ipcMain.handle('chat:models', (_event, provider) => ({ ok: true, source: 'runtime', models: [{ value: provider + '-fixture', label: provider + ' fixture', imageInput: false }] }));
      ipcMain.handle('takes:send', (_event, request) => {
        globalThis.nativeRequests.push(request);
        throw new Error('Synthetic unsupported CLI version. Update the adapter before retrying.');
      });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    for (const [provider, label] of [['grok', 'Grok']]) {
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
      { provider: 'grok', model: 'grok-fixture' },
    ]);
    await page.screenshot({ path: '/tmp/earlybird-grok-chat-ui.png' });
  } finally {
    if (app) await closeDesktop(app);
    await stopHost(profile); await rm(profile, { recursive: true, force: true });
  }
});
