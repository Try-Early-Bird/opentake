import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { closeDesktop } from './helpers/desktop.mjs';
import { stopHost, hostRequest } from './helpers/host.mjs';

test('data-source preload reaches its disposable host with an empty production catalog', { timeout: 40_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-data-host-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    application = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env, timeout: 15000 });
    const page = await application.firstWindow();
    await page.waitForLoadState('load');
    await page.waitForFunction(() => typeof window.dataSources?.list === 'function');
    assert.deepEqual(await page.evaluate(() => window.dataSources.list()), []);
    assert.equal((await page.evaluate(() => window.settings.securityStatus())).secretStorageAvailable, false);
    assert.equal(await page.evaluate(async () => {
      try { await window.dataSources.acquire({ sourceId: 'unregistered', feedId: 'price', configVersion: 1, schemaVersion: 1 }); return false; }
      catch { return true; }
    }), true);
    assert.deepEqual((await page.evaluate(() => window.dataSources.coinbaseStream.inspect())).subscriptions, []);
    await page.evaluate(() => window.dataSources.coinbaseStream.setDustPolicy({hide:true,threshold:'1.00'}));
    assert.equal(await page.evaluate(async()=>{try{await window.dataSources.coinbaseStream.setDustPolicy({hide:true,threshold:'-1'});return false;}catch{return true;}}),true);
    assert.equal(await page.evaluate(async()=>{if(typeof window.dataSources.coinbaseStream.inspectMappings!=='function')return false;try{await window.dataSources.coinbaseStream.inspectMappings();return false;}catch{return true;}}),true,'Sample inspection rejects an empty stream without opening a socket');
    const provider=await page.evaluate(()=>window.dataSources.coinbaseStream.source());
    assert.equal(provider.config.provider.kind,'coinbase-market');
    const paused=await page.evaluate(source=>window.dataSources.coinbaseStream.saveSource(source.revision,{...source.config,collection:'off'}),provider);
    assert.equal(paused.enabled,false);assert.equal(paused.revision,provider.revision+1);
    assert.equal(await page.evaluate(async source=>{try{await window.dataSources.coinbaseStream.saveSource(source.revision,source.config);return false;}catch{return true;}},provider),true);
    const unknown = '11111111-1111-4111-8111-111111111111';
    assert.equal(await page.evaluate(async takeId=>{try{await window.dataSources.configure({action:'take-inputs-snapshot',takeId});return false;}catch{return true;}},unknown),true,'Take input snapshots reject unknown Takes through the host bridge');
    assert.equal(await page.evaluate(async () => {
      try { await window.dataSources.coinbaseStream.acquire('BTC-USDC'); return false; }
      catch (error) { return /Background host request failed/.test(String(error)); }
    }), true, 'Invalid product is rejected before network I/O through the real preload/host bridge');
    assert.deepEqual(await page.evaluate(id => window.dataSources.coinbaseStream.read([id]), unknown), [{ leaseId: unknown, snapshot: null }]);
    assert.deepEqual(await page.evaluate(id => window.dataSources.coinbaseStream.renew([id]), unknown), []);
    await page.evaluate(id => window.dataSources.coinbaseStream.release([id]), unknown);

    assert.deepEqual(await page.evaluate(id => window.dataSources.read([id]), unknown), [{ leaseId: unknown, snapshot: null }]);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    assert.equal(await page.evaluate(async () => { try { await window.dataSources.list(); return false; } catch { return true; } }), true);
    assert.equal(await page.evaluate(async () => { try { await window.dataSources.coinbaseStream.read([]); return false; } catch { return true; } }), true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const reloaded = page.waitForEvent('domcontentloaded');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
    await reloaded;
    await page.waitForFunction(() => typeof window.dataSources?.list === 'function');
    assert.deepEqual(await page.evaluate(() => window.dataSources.list()), []);
    await closeDesktop(application); application = undefined;
    assert.deepEqual(await hostRequest(profile, 'dataSources:list'), []);
  } finally {
    if (application) await closeDesktop(application);
    await stopHost(profile);
    await rm(profile, { recursive: true, force: true });
  }
});
