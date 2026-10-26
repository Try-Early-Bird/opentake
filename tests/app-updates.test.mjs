import { closeDesktop } from './helpers/desktop.mjs';
import { hostRequest, stopHost } from './helpers/host.mjs';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

test('Settings shows the version and checks releases only on request', { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-updates-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    application = await _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    await dismissConnectionPrompt(page, application);
    // Stub the public release transport in the desktop process, exercising the
    // real IPC handlers and selection logic without GitHub or an external browser.
    await application.evaluate(() => {
      globalThis.updateRequests = 0;
      globalThis.updateResponse = async () => new Response('[]');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        if (String(args[0]).startsWith('https://api.github.com/repos/Try-Early-Bird/opentake-releases/releases')) {
          globalThis.updateRequests++;
          return globalThis.updateResponse();
        }
        return originalFetch(...args);
      };
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const section = page.getByRole('region', { name: 'Version & updates' });
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    await section.getByText(`Opentake ${packageJson.version} · Development build`, { exact: false }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.updateRequests), 0);
    await section.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await section.getByText('No installers have been published for this system and channel yet.').waitFor();
    assert.equal(await application.evaluate(() => globalThis.updateRequests), 1);
    await application.evaluate(() => {
      globalThis.updateResponse = async () => new Response(JSON.stringify([{ tag_name: 'v99.0.0-beta.1', draft: false, prerelease: true,
        assets: [{ name: process.platform === 'darwin' ? 'app.dmg' : process.platform === 'win32' ? 'setup.exe' : 'app.AppImage', state: 'uploaded', size: 100 }] }]));
    });
    await section.getByRole('checkbox', { name: 'Include preview releases' }).check();
    await section.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await section.getByRole('button', { name: 'Download 99.0.0-beta.1' }).waitFor();
    // The app-wide banner offers the update; this development build opens the release page.
    const banner = page.getByRole('region', { name: 'App update' });
    await banner.getByText('Opentake 99.0.0-beta.1 is available.').waitFor();
    await banner.getByRole('button', { name: 'Download', exact: true }).waitFor();
    await banner.getByRole('button', { name: 'Later', exact: true }).click();
    assert.equal(await banner.count(), 0);
    await page.getByRole('button', { name: 'Version 99.0.0-beta.1 available', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Dismiss update notice' }).click();
    assert.equal(await page.getByRole('button', { name: 'Version 99.0.0-beta.1 available', exact: true }).count(), 0);
    await section.getByRole('checkbox', { name: 'Include preview releases' }).uncheck();
    assert.equal(await section.getByRole('button', { name: 'Download 99.0.0-beta.1' }).count(), 0);
    await application.evaluate(() => { globalThis.updateResponse = async () => { throw new Error('Synthetic offline'); }; });
    await section.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await section.getByRole('alert').getByText('Could not check for updates. Check your internet connection and try again.').waitFor();
    // The host must persist a receipt after flushing, then actually exit. Close
    // the desktop first so its normal liveness monitor cannot restart the fixture.
    const host = JSON.parse(await readFile(join(profile, 'host.json'), 'utf8'));
    await closeDesktop(application); application = undefined;
    const nonce = randomUUID();
    await hostRequest(profile, 'host:prepare-update', [nonce]);
    for (let attempt = 0; attempt < 150; attempt++) {
      let exited = false;
      try { process.kill(host.pid, 0); } catch (error) { if (error.code === 'ESRCH') exited = true; else throw error; }
      if (exited) break;
      if (attempt === 149) throw new Error('Fixture host did not stop');
      await delay(100);
    }
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'update-shutdown.json'), 'utf8')), { nonce, pid: host.pid });
  } finally {
    if (application) await closeDesktop(application);
    await stopHost(profile);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
