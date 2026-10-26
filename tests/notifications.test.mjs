import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { hostRequest, stopHost } from './helpers/host.mjs';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error('Notification test timed out');
}

test('windowless host groups native recovery alerts and clicking opens the real desktop attention list', { timeout: 65000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-notifications-'));
  const wrapper = join(profile, 'notification-host.cjs');
  // Intercept native delivery in the disposable test process only. Production
  // has no debug endpoint, fake notifier switch or notification injection API.
  await writeFile(wrapper, `
    const electron = require('electron');
    electron.app.setAppPath(${JSON.stringify(process.cwd())});
    globalThis.testAlerts = []; globalThis.testChildren = [];
    const childProcess = require('node:child_process'); const originalSpawn = childProcess.spawn;
    childProcess.spawn = function(...args) { const child = originalSpawn.apply(this,args); globalThis.testChildren.push(child.pid); return child; };
    electron.Notification.isSupported = () => true;
    electron.Notification.prototype.show = function() { globalThis.testAlerts.push(this); };
    require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const launch = () => electron.launch({ executablePath, args: [wrapper, `--user-data-dir=${profile}`, '--earlybird-host', '--earlybird-test-no-secrets'], env, timeout: 15000 });
  let application;
  let childPids = [];
  let db;
  try {
    application = await launch();
    await until(async () => { try { await hostRequest(profile, 'host:status'); return true; } catch { return false; } });
    await stopHost(profile); await application.close().catch(() => {}); application = undefined;
    db = new PGlite(join(profile, 'database')); await db.waitReady;
    await db.exec(`INSERT INTO platform_connections(owner_id,venue,status,maintenance_enabled)
      SELECT id,'synthetic-'||n,'reauth_required',false FROM local_owners CROSS JOIN generate_series(1,5) n;`);
    await db.close(); db = undefined;
    application = await launch();
    await until(async () => (await application.evaluate(() => globalThis.testAlerts.length)) === 1);
    assert.equal((await application.windows()).length, 0);
    const result = await hostRequest(profile, 'notifications:list');
    assert.equal(result.actionRequiredCount, 5);
    assert.equal(result.unreadCount, 5);
    const captured = await application.evaluate(() => ({ title: globalThis.testAlerts[0].title, body: globalThis.testAlerts[0].body }));
    assert.match(captured.title, /5 items/);
    await application.evaluate(() => globalThis.testAlerts[0].emit('click'));
    await until(async () => (await hostRequest(profile, 'notifications:list')).unreadCount === 0);
    assert.equal(await hostRequest(profile, 'notifications:navigation'), null);
    // Reading the attention list must not resolve the source problems.
    assert.equal((await hostRequest(profile, 'notifications:list')).actionRequiredCount, 5);
    assert.equal(await application.evaluate(() => globalThis.testAlerts.length), 1);
    childPids = await application.evaluate(() => globalThis.testChildren);
  } finally {
    if (db) await db.close();
    if (application) childPids = await application.evaluate(() => globalThis.testChildren).catch(() => childPids);
    await stopHost(profile);
    if (application) await application.close().catch(() => {});
    // The launched desktop notices the stopped host and exits itself.
    await until(async () => childPids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 15000);
    await rm(profile, { recursive: true, force: true });
  }
});

test('approval navigation selects the original take again after the user switches takes', { timeout: 35000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-notification-take-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    application = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(7000);
    await dismissConnectionPrompt(page, application);
    const [first, second] = await page.evaluate(async () => {
      const a = await window.takes.create(), b = await window.takes.create();
      await window.takes.update(a, { title: 'Approval take' });
      await window.takes.update(b, { title: 'Other take' });
      return [a,b];
    });
    // Only the navigation IPC is replaced, on this synthetic desktop. Selection,
    // persistence and rendering still use the real preload, router and host.
    await application.evaluate(({ ipcMain }, first) => {
      globalThis.testNavigation = { id: '11111111-1111-4111-8111-111111111111', target: { type: 'take', takeId: first } };
      ipcMain.removeHandler('notifications:navigation');
      ipcMain.handle('notifications:navigation', () => globalThis.testNavigation);
      ipcMain.removeHandler('notifications:acknowledge');
      ipcMain.handle('notifications:acknowledge', () => { globalThis.testNavigation = null; });
    }, first);
    const selected = id => page.waitForFunction(id => document.querySelector(`button[aria-current="page"]`)?.textContent === (id === 'first' ? 'Approval take' : 'Other take'), id);
    await selected('first');
    const history = page.getByRole('button', { name: 'Open take history', exact: true });
    if (await history.isVisible()) await history.click();
    await page.getByRole('button', { name: 'Other take', exact: true }).click();
    await selected('second');
    await application.evaluate((_, first) => { globalThis.testNavigation = { id: '22222222-2222-4222-8222-222222222222', target: { type: 'take', takeId: first } }; }, first);
    await selected('first');
    const snapshot = await page.evaluate(id => window.takes.snapshot(id, false), second);
    assert.equal(snapshot.running, false);
  } finally {
    if (application) await application.close().catch(() => {});
    await stopHost(profile);
    await rm(profile, { recursive: true, force: true });
  }
});
