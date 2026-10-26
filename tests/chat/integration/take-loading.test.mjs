import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { closeDesktop } from '../../helpers/desktop.mjs';
import { stopHost } from '../../helpers/host.mjs';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';

test('delayed Take history shows loading instead of an empty account and recovers', {timeout:60000}, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-loading-'));
  let app;
  try {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await electron.launch({executablePath, args:['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env});
    const page = await app.firstWindow();
    await page.setViewportSize({width:1440,height:900});
    await dismissConnectionPrompt(page, app);
    const snapshot = await page.evaluate(async () => {
      const id = await window.takes.create();
      await window.takes.update(id, {title:'Preserved synthetic Take'});
      return window.takes.snapshot(null, false);
    });
    await app.evaluate(({ipcMain}, snapshot) => {
      globalThis.loadingSnapshot = snapshot;
      globalThis.releaseLoading = [];
      globalThis.blockLoading = true;
      ipcMain.removeHandler('takes:snapshot');
      ipcMain.handle('takes:snapshot', () => globalThis.blockLoading ? new Promise(resolve => globalThis.releaseLoading.push(resolve)) : snapshot);
    }, snapshot);
    await page.reload();
    await dismissConnectionPrompt(page, app);
    const history = page.getByRole('region', {name:'Conversation'});
    await history.getByText('Loading your Takes…', {exact:true}).waitFor();
    assert.equal(await page.getByRole('heading', {name:'Your money’s story starts with one belief.'}).count(), 0);
    await history.getByText('Your Takes are taking longer to load.', {exact:true}).waitFor({timeout:15000});
    await app.evaluate(() => {
      globalThis.blockLoading = false;
      for (const resolve of globalThis.releaseLoading) resolve(globalThis.loadingSnapshot);
    });
    const openHistory = page.getByRole('button', {name:'Open take history', exact:true});
    if (await openHistory.isVisible()) await openHistory.click();
    await page.getByRole('button', {name:'Preserved synthetic Take', exact:true}).first().waitFor();
    assert.equal(await history.getByText('Your Takes are taking longer to load.', {exact:true}).count(), 0);
  } finally {
    if (app) {
      await app.evaluate(() => { for (const resolve of globalThis.releaseLoading ?? []) resolve(globalThis.loadingSnapshot); }).catch(() => {});
      await closeDesktop(app);
    }
    await stopHost(profile);
    await rm(profile, {recursive:true, force:true});
  }
});
