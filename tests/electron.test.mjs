import { readHostLog } from './helpers/diagnostics.mjs';
import { closeDesktop } from './helpers/desktop.mjs';
import { migrationVersions } from './helpers/migrations.mjs';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { PGlite } from '@electric-sql/pglite';
import { stopHost } from './helpers/host.mjs';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';

// Call only after the disposable desktop/host have stopped. Chromium helpers
// may finish releasing session files just after the main process exits.
async function removeProfile(userData) {
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Windows CI must budget for Electron startup, disk-backed host initialization,
// interactions and safe teardown in both unpackaged and packaged smoke runs.
const smokeTimeout = milliseconds => process.platform === 'win32' ? Math.max(90_000, milliseconds) : milliseconds;

const launchPath = process.env.EARLYBIRD_TEST_APP || executablePath;
const launchArgs = process.env.EARLYBIRD_TEST_APP ? [] : ['.'];
launchArgs.push('--earlybird-test-no-secrets');
async function chooseSelect(page, name, option) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
if (process.env.CI && process.platform === 'linux' && process.env.ELECTRON_DISABLE_SANDBOX === '1') {
  launchArgs.push('--no-sandbox');
}

test('shortcut summary, editing, persistence and layered dismissal', { timeout: smokeTimeout(45_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'earlybird-shortcuts-'));
  let application;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
    await dismissConnectionPrompt(page, application);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('main', { name: 'Home' }).waitFor({ timeout: 3000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
    await page.getByRole('listbox').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.getByRole('main', { name: 'Home' }).waitFor({ timeout: 3000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    const popup = await page.getByRole('dialog').boundingBox();
    const trigger = await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).boundingBox();
    assert.ok(popup.width <= 340);
    assert.ok(popup.y + popup.height <= trigger.y);
    assert.ok(Math.abs(popup.x + popup.width - trigger.x - trigger.width) < 2);
    assert.notEqual(await page.getByRole('dialog').getAttribute('aria-modal'), 'true');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('main', { name: 'Settings' }).waitFor();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+/' : 'Control+/');
    await page.getByRole('dialog').waitFor();
    await page.getByRole('heading', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await page.getByRole('button', { name: 'Edit shortcuts' }).click();
    await page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Change Go back', exact: true }).locator('kbd').count(), 1);
    await page.getByRole('button', { name: 'Change Go back', exact: true }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await page.getByRole('alert').filter({ hasText: 'already assigned' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('main', { name: 'Settings' }).waitFor();
    await page.getByRole('button', { name: 'Change Go back', exact: true }).click();
    await page.keyboard.press('Control+Shift+K');
    await page.getByText('Ctrl + Shift + K', { exact: true }).waitFor();
    await page.keyboard.press('Control+Shift+K');
    await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Credentials', exact: true }).click();
    await page.getByRole('heading', { name: 'Credentials', exact: true }).waitFor();
    await page.getByText('Credentials are stored encrypted on your computer, protected by your operating system’s secure storage.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await page.reload();
    await dismissConnectionPrompt(page, application);
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await page.getByRole('dialog').getByText('Ctrl + Shift + K', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit shortcuts' }).click();
    await page.getByRole('button', { name: 'Reset shortcuts' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('main', { name: 'Home' }).waitFor();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await page.getByRole('main', { name: 'Settings' }).waitFor();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+[' : 'Alt+ArrowLeft');
    await page.getByRole('main', { name: 'Home' }).waitFor();
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); }
    await removeProfile(userData);
  }
});

test('credentials UI adds, edits and removes metadata without revealing values', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'earlybird-credentials-ui-'));
  let application;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
    await dismissConnectionPrompt(page, application);
    // UI-only IPC fixture: never access or write the developer's native keychain.
    // Real inventory validation/persistence and encryption are tested in unit suites.
    await application.evaluate(({ ipcMain }) => {
      let items = [];
      for (const channel of ['settings:security', 'settings:credentials:list', 'settings:credentials:save', 'settings:credentials:remove']) ipcMain.removeHandler(channel);
      ipcMain.handle('settings:security', () => ({ secretStorageAvailable: true }));
      ipcMain.handle('settings:credentials:list', () => ({ ok: true, items }));
      ipcMain.handle('settings:credentials:save', (_event, input) => {
        const item = { id: input.id || '11111111-1111-1111-1111-111111111111', name: input.name, provider: input.provider, type: input.type, updatedAt: new Date().toISOString() };
        items = [item]; return { ok: true, items };
      });
      ipcMain.handle('settings:credentials:remove', () => { items = []; return { ok: true, items }; });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Credentials', exact: true }).click();
    await page.getByText('No credentials saved yet.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add credential', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Database Unavailable', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'AI provider', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('button', { name: 'HTTP API', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('button', { name: 'WebSocket API', exact: true }).evaluate(node => node === document.activeElement), true);
    // Database is unavailable, so the arrow keys skip it.
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('button', { name: 'Key/value', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByLabel('Key', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    for (const [option, field] of [['AI provider', 'API key'], ['HTTP API', 'Base URL']]) {
      await page.getByRole('button', { name: option, exact: true }).click();
      await page.getByLabel(field, { exact: true }).waitFor();
      if (option === 'AI provider') {
        await page.getByLabel('Organization ID (optional)', { exact: true }).waitFor();
        await page.getByLabel('API key', { exact: true }).fill('test-only-not-a-real-key');
        await chooseSelect(page, 'AI provider', 'OpenCode Zen');
        assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
        assert.equal(await page.getByLabel('Custom base URL (optional)', { exact: true }).getAttribute('placeholder'), 'https://opencode.ai/zen/v1');
        await chooseSelect(page, 'AI provider', 'xAI (Grok)');
        assert.equal(await page.getByLabel('Custom base URL (optional)', { exact: true }).getAttribute('placeholder'), 'https://api.x.ai/v1');
        await chooseSelect(page, 'AI provider', 'Other');
        await page.getByRole('combobox', { name: 'API format', exact: true }).waitFor();
        assert.equal(await page.getByLabel('Base URL', { exact: true }).getAttribute('required'), '');
        await chooseSelect(page, 'AI provider', 'Anthropic');
        await page.getByRole('combobox', { name: 'AI provider', exact: true }).click();
        await page.getByRole('listbox').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await page.getByRole('listbox').waitFor({ state: 'hidden' });
        assert.equal(await page.getByRole('dialog').isVisible(), true);
      }
      if (option === 'HTTP API') {
        await chooseSelect(page, 'Authentication', 'Custom header');
        await page.getByLabel('Header name', { exact: true }).waitFor();
      }
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Key/value', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Fixture key');
    await page.getByLabel('Key', { exact: true }).fill('TEST_KEY');
    await page.getByLabel('Secret value', { exact: true }).fill('synthetic-secret-value');
    assert.equal(await page.getByLabel('Secret value', { exact: true }).getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Save credential', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Fixture key', exact: true }).click();
    await page.getByLabel('Replace credential details', { exact: true }).check();
    assert.equal(await page.getByLabel('Secret value', { exact: true }).inputValue(), '');
    await page.getByLabel('Replace credential details', { exact: true }).uncheck();
    await page.getByLabel('Name', { exact: true }).fill('Renamed fixture');
    await page.getByRole('button', { name: 'Save credential', exact: true }).click();
    await page.getByRole('button', { name: 'Remove Renamed fixture', exact: true }).click();
    await page.getByText('This does not revoke it at the provider.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Remove Renamed fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Remove credential', exact: true }).click();
    await page.getByText('No credentials saved yet.', { exact: true }).waitFor();
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings:security');
      ipcMain.handle('settings:security', () => ({ secretStorageAvailable: false }));
    });
    await page.getByRole('button', { name: 'Refresh credentials' }).click();
    await page.getByText('Saved credentials can’t be opened right now.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add credential', exact: true }).isDisabled(), true);
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); }
    await removeProfile(userData);
  }
});

test('Robinhood connection menu and migration history', { timeout: smokeTimeout(20_000) }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'earlybird-connect-ui-'));
  let application;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({
      executablePath: launchPath,
      args: [...launchArgs, `--user-data-dir=${userData}`],
      env,
    });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
    await dismissConnectionPrompt(page, application);
    await page.locator('main').waitFor();
    // Startup completes database initialization before the first window opens.
    page.setDefaultTimeout(5000);
    await access(join(userData, 'database', 'PG_VERSION'));
    assert.equal(await page.title(), 'Earlybird-Opentake');
    // UI fixture: never start real OAuth or open the user's brokerage account.
    await application.evaluate(({ ipcMain }) => {
      let connection = { status: 'disconnected', checkedAt: null, accounts: [] };
      for (const name of ['status', 'connect', 'refresh', 'disconnect', 'select']) ipcMain.removeHandler(`connections:${name}`);
      ipcMain.handle('connections:status', () => ({ ok: true, connection }));
      ipcMain.handle('connections:connect', () => {
        connection = { status: 'connected', checkedAt: new Date().toISOString(), accounts: [
          { id: 'ineligible', maskedNumber: '••••0000', nickname: 'Individual fixture', accountType: 'margin', agenticAllowed: false, selected: false },
          { id: 'fixture', maskedNumber: '••••1234', nickname: 'Test account', accountType: 'cash', agenticAllowed: true, selected: true },
          { id: 'second', maskedNumber: '••••5678', nickname: 'Second account', accountType: 'limited_margin', agenticAllowed: true, selected: false },
        ] };
        return { ok: true, connection };
      });
      let failSelection = true;
      ipcMain.handle('connections:select', (_event, id) => {
        if (failSelection) { failSelection = false; return { ok: false, message: 'Synthetic save failed. Please retry.' }; }
        if (!connection.accounts.some(account => account.id === id && account.agenticAllowed)) return { ok: false, message: 'Invalid account' };
        connection = { ...connection, accounts: connection.accounts.map(account => ({ ...account, selected: account.id === id })) };
        return { ok: true, connection };
      });
      ipcMain.handle('connections:refresh', () => ({ ok: true, connection }));
      ipcMain.handle('connections:disconnect', () => {
        connection = { status: 'disconnected', checkedAt: null, accounts: [] };
        return { ok: true, connection };
      });
    });
    const connect = page.getByRole('button', { name: 'Connect trading platform', exact: true });
    const connectBox = await connect.boundingBox();
    assert.equal(connectBox.x, 12);
    assert.ok(connectBox.y >= await page.evaluate(() => innerHeight - 29));
    assert.equal(await page.locator('header').getByRole('button', { name: 'Connect trading platform' }).count(), 0);
    await connect.click();
    await page.getByRole('dialog', { name: 'Connect a trading platform' }).waitFor();
    await page.getByRole('button', { name: /^Robinhood/ }).and(page.locator(':enabled')).waitFor();
    await page.getByRole('button', { name: /^Robinhood/ }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 2);
    assert.equal(await page.getByText('Individual fixture', { exact: false }).count(), 0);
    assert.equal(await page.getByText('Not agentic-enabled', { exact: false }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: /Test account/ }).isChecked(), true);
    await page.getByRole('radio', { name: /Second account/ }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic save failed' }).waitFor();
    assert.equal(await page.getByRole('radio', { name: /Second account/ }).isChecked(), true);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await connect.click();
    await page.getByText('MCP · ••••5678', { exact: true }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(Refresh accounts|Cancel)$/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save account', exact: true }).count(), 0);
    assert.equal(await page.getByText(/Connection needs verification/).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await connect.click();
    await page.getByRole('dialog', { name: 'Connections', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    // A persisted selection can be managed without replaying onboarding.
    await connect.click();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('connections:status');
      ipcMain.handle('connections:status', () => ({ ok: true, connection: { status: 'connected', checkedAt: null, accounts: [
        { id: 'ineligible', maskedNumber: '••••0000', nickname: 'Individual fixture', accountType: 'margin', agenticAllowed: false, selected: false },
      ] } }));
    });
    await page.reload();
    await page.getByText('No agentic-enabled accounts are available.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'Database migrations', exact: true }).count(), 0);
    const history = await page.evaluate(() => window.settings.migrationHistory());
    assert.deepEqual(history.map(item => item.version), migrationVersions);
    assert.ok(Number.isFinite(Date.parse(history[0].appliedAt)));
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); }
    await removeProfile(userData);
  }
});

test('Electron renders the bare React shell with Tailwind and isolation', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'earlybird-oss-smoke-'));
  let application;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
    await dismissConnectionPrompt(page, application);
    await page.locator('main').waitFor();
    await access(join(userData, 'database', 'PG_VERSION'));
    assert.equal(await page.title(), 'Earlybird-Opentake');
    assert.equal(await page.locator('main').getAttribute('aria-label'), 'Home');
    assert.equal(await page.locator('main').evaluate((node) => getComputedStyle(node).paddingBottom), '0px');
    const mark = await page.getByRole('link', { name: 'Opentake home' }).boundingBox();
    assert.equal(mark.x, 24);
    assert.ok(mark.y >= 12);
    assert.equal(mark.width, 21);
    assert.equal(mark.height, 24);
    assert.equal(await page.locator('footer').evaluate((node) => getComputedStyle(node).position), 'fixed');
    const footer = await page.locator('footer').boundingBox();
    assert.equal(footer.height, 28);
    assert.equal(footer.y + footer.height, await page.evaluate(() => innerHeight));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('main', { name: 'Settings' }).waitFor();
    await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('main', { name: 'Home' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('main', { name: 'Settings' }).waitFor();
    await page.getByRole('link', { name: 'Opentake home' }).click();
    await page.getByRole('main', { name: 'Home' }).waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const fonts = await page.evaluate(async () => {
      await document.fonts.load('16px "Rubik Variable"');
      await document.fonts.load('16px "Inter Variable"');
      return {
        selected: document.documentElement.dataset.font,
        family: getComputedStyle(document.documentElement).fontFamily,
        rubik: document.fonts.check('16px "Rubik Variable"'),
        inter: document.fonts.check('16px "Inter Variable"'),
      };
    });
    assert.equal(fonts.selected, 'rubik');
    assert.match(fonts.family, /Rubik Variable/);
    assert.equal(fonts.rubik, true);
    assert.equal(fonts.inter, true);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), darkBackground);
    const preferences = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    );
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.sandbox, true);
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); }
    await removeProfile(userData);
  }
});

test('stored data survives two Electron launches and normal quits', { timeout: smokeTimeout(60_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'earlybird-app-restart-'));
  const dataDir = join(userData, 'database');
  let application;
  let db;
  try {
    db = new PGlite(dataDir);
    await db.exec('create table restart_probe (value text)');
    await db.query('insert into restart_probe values ($1)', ['persisted']);
    await db.close();
    db = undefined;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    for (let launch = 0; launch < 2; launch++) {
      application = await electron.launch({
        executablePath: launchPath,
        args: [...launchArgs, `--user-data-dir=${userData}`],
        env,
      });
      const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
      await dismissConnectionPrompt(page, application);
      await page.locator('main').waitFor();
      if (launch === 0) {
        const duplicate = spawn(launchPath, [...launchArgs, `--user-data-dir=${userData}`], { env, stdio: 'ignore' });
        const timeout = setTimeout(() => duplicate.kill('SIGKILL'), 10_000);
        try {
          const [code] = await once(duplicate, 'exit');
          assert.equal(code, 0, 'duplicate instance exits without opening the database');
          assert.equal(await page.locator('main').getAttribute('aria-label'), 'Home');
        } finally {
          clearTimeout(timeout);
          if (duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill('SIGKILL');
        }
      }
      await closeDesktop(application);
      application = undefined;
      await stopHost(userData);
      const events = (await readHostLog(userData))
        .trim().split('\n').map((line) => JSON.parse(line).event);
      assert.ok(events.includes('database.ready'));
      assert.equal(events.at(-1), 'database.closed');
      db = new PGlite(dataDir);
      assert.deepEqual((await db.query('select value from restart_probe')).rows, [{ value: 'persisted' }]);
      await db.close();
      db = undefined;
    }
  } finally {
    if (application) await closeDesktop(application);
    if (db) await db.close();
    await stopHost(userData);
    await removeProfile(userData);
  }
});

test('quit exits after database close even if a renderer cancels unload', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'earlybird-quit-regression-'));
  let application;
  let watchdog;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
    await dismissConnectionPrompt(page, application);
    await page.locator('main').waitFor();
    await page.evaluate(() => window.addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = 'cancel';
    }));
    const child = application.process();
    const exited = once(child, 'exit');
    watchdog = setTimeout(() => child.kill('SIGKILL'), 8000);
    await page.evaluate(() => window.activity.quitCompletely());
    const [code, signal] = await exited;
    application = undefined; // Already exited; Playwright has disposed its process handle.
    assert.equal(signal, null, 'process must exit without test-runner cleanup');
    assert.equal(code, 0);
    await stopHost(userData);
    const events = (await readHostLog(userData)).trim().split('\n').map(line => JSON.parse(line).event);
    assert.equal(events.at(-1), 'database.closed');
  } finally {
    clearTimeout(watchdog);
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); }
    await removeProfile(userData);
  }
});

test('settings persist appearance, report metrics, and export a restorable snapshot', { timeout: smokeTimeout(60_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'earlybird-settings-'));
  const exportDirectory = await mkdtemp(join(tmpdir(), 'earlybird-settings-export-'));
  let application;
  let restored;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 });
    await dismissConnectionPrompt(page, application);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await chooseSelect(page, 'Theme', 'Light');
    await chooseSelect(page, 'Font', 'Inter');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), false);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.font), 'inter');
    await page.reload();
    await dismissConnectionPrompt(page, application);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.match(await page.getByRole('combobox', { name: 'Theme', exact: true }).innerText(), /Light/);
    assert.match(await page.getByRole('combobox', { name: 'Font', exact: true }).innerText(), /Inter/);
    await chooseSelect(page, 'Theme', 'System');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    await chooseSelect(page, 'Theme', 'Dark');
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'Database migrations', exact: true }).count(), 0);
    await page.getByText('PGlite storage on disk', { exact: true }).waitFor();
    const stats = await page.evaluate(() => window.settings.memoryStats());
    assert.ok(stats.appWorkingSetBytes > 0);
    assert.ok(stats.mainWorkingSetBytes > 0);
    assert.ok(stats.storageBytes > 0);
    assert.ok(stats.postgresAllocatedBytes > 0);
    const destination = join(exportDirectory, 'snapshot.ebbackup');
    const passphrase = 'test-only-backup-passphrase';
    async function exportViaUI() {
      await page.getByRole('button', { name: 'Export PGlite data' }).click();
      assert.equal(await page.getByRole('button', { name: 'Save encrypted backup' }).isDisabled(), true);
      await page.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
      await page.getByLabel('Confirm backup passphrase', { exact: true }).fill(passphrase);
      await page.getByRole('button', { name: 'Save encrypted backup' }).click();
    }
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, destination);
    await exportViaUI();
    await page.getByText('Database exported.', { exact: true }).waitFor();
    const encrypted = await readFile(destination);
    assert.equal(encrypted.subarray(0, 8).toString(), 'EBBACK01');
    const key = scryptSync(passphrase, encrypted.subarray(8, 24), 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(24, 36));
    decipher.setAAD(encrypted.subarray(0, 36));
    decipher.setAuthTag(encrypted.subarray(-16));
    const archive = Buffer.concat([decipher.update(encrypted.subarray(36, -16)), decipher.final()]);
    key.fill(0);
    restored = new PGlite({ loadDataDir: new Blob([archive]) });
    assert.deepEqual((await restored.query('select 1 as ready')).rows, [{ ready: 1 }]);
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    });
    await exportViaUI();
    await page.getByText('Export cancelled.', { exact: true }).waitFor();
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, join(userData, 'database', 'PG_VERSION'));
    await exportViaUI();
    await page.getByText('Choose a destination outside the app data folder.', { exact: true }).waitFor();
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, destination);
    await page.getByRole('button', { name: 'Import PGlite data', exact: true }).click();
    await page.getByRole('dialog', { name: 'Replace the current database?' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Replace database', exact: true }).isDisabled(), true);
    await page.getByLabel('Type IMPORT to confirm replacement').fill('IM');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+[' : 'Alt+ArrowLeft');
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'Memory', exact: true }).waitFor();
    await assert.rejects(access(join(userData, 'database.active')));
    // Wrong passwords must not change the active database.
    await page.getByRole('button', { name: 'Import PGlite data', exact: true }).click();
    await page.getByLabel('Backup passphrase', { exact: true }).fill('wrong-test-passphrase');
    await page.getByLabel('Type IMPORT to confirm replacement').fill('IMPORT');
    await page.getByRole('button', { name: 'Replace database', exact: true }).click();
    await page.getByText('Import failed.', { exact: false }).waitFor();
    await assert.rejects(access(join(userData, 'database.active')));
    await page.getByRole('button', { name: 'Import PGlite data', exact: true }).click();
    await page.getByRole('dialog', { name: 'Replace the current database?' }).waitFor();
    if (process.env.EARLYBIRD_TEST_SCREENSHOTS) await page.screenshot({ path: join(process.env.EARLYBIRD_TEST_SCREENSHOTS, 'import-dialog.png') });
    await page.getByLabel('Type IMPORT to confirm replacement').fill('IMPORT');
    await page.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
    await page.getByRole('button', { name: 'Replace database', exact: true }).click();
    await page.getByText('Database imported. Previous database retained at:', { exact: false }).waitFor();
    await access(join(userData, 'database', 'PG_VERSION')); // recovery copy retained
    const activeDirectory = await readFile(join(userData, 'database.active'), 'utf8');
    await access(join(userData, activeDirectory, 'PG_VERSION'));
    assert.ok((await page.evaluate(() => window.settings.memoryStats())).storageBytes > 0);
    const replay = await page.evaluate(() => window.settings.importDatabase('invalid-token'));
    assert.equal(replay.status, 'error');
    const security = await page.evaluate(() => window.settings.securityStatus());
    assert.equal(security.databaseEncrypted, false);
    assert.equal(await page.evaluate(() => 'getSecret' in window.settings), false);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => (localStorage.getItem(key) || '').includes('test-only-backup-passphrase'))), false);
    const legacyPath = join(exportDirectory, 'legacy.tar.gz');
    await writeFile(legacyPath, archive);
    await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, legacyPath);
    const unacknowledged = await page.evaluate(async () => {
      const selected = await window.settings.chooseImport();
      return window.settings.importDatabase(selected.token, '', false);
    });
    assert.equal(unacknowledged.status, 'error');
    assert.equal(await readFile(join(userData, 'database.active'), 'utf8'), activeDirectory);
    await page.getByRole('button', { name: 'Import PGlite data', exact: true }).click();
    await page.getByRole('checkbox').check();
    await page.getByLabel('Type IMPORT to confirm replacement').fill('IMPORT');
    await page.getByRole('button', { name: 'Replace database', exact: true }).click();
    await page.getByText('Database imported. Previous database retained at:', { exact: false }).waitFor();
    if (process.env.EARLYBIRD_TEST_SCREENSHOTS) {
      await page.screenshot({ path: join(process.env.EARLYBIRD_TEST_SCREENSHOTS, 'settings-memory.png') });
      await page.getByRole('button', { name: 'General', exact: true }).click();
      await page.screenshot({ path: join(process.env.EARLYBIRD_TEST_SCREENSHOTS, 'settings-general.png') });
    }
  } finally {
    if (application) await closeDesktop(application);
    if (restored) await restored.close();
    await stopHost(userData);
    await removeProfile(userData);
    await rm(exportDirectory, { recursive: true, force: true });
  }
});

test('account Continue offers BYO AI, supports Claude code and ChatGPT device login, and skips connected AI', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'opentake-ai-ui-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 }); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      const connection = { status: 'connected', checkedAt: null, accounts: [{ id: 'synthetic', nickname: 'Agentic', maskedNumber: '••••1234', accountType: 'cash', agenticAllowed: true, selected: true }] };
      for (const name of ['connections:status', 'connections:select', 'ai:status', 'ai:start', 'ai:submit-code', 'ai:reopen', 'ai:cancel']) ipcMain.removeHandler(name);
      let states = [{ provider: 'chatgpt', status: 'disconnected' }, { provider: 'claude', status: 'disconnected' }];
      let selected;
      let attempts = 0;
      ipcMain.handle('connections:status', () => ({ ok: true, connection }));
      ipcMain.handle('connections:select', () => ({ ok: true, connection }));
      globalThis.syntheticAiUnavailable = true;
      ipcMain.handle('ai:status', () => { if (globalThis.syntheticAiUnavailable) throw new Error('Unknown operation: ai:status'); return states; });
      ipcMain.handle('ai:start', (_event, provider) => {
        selected = provider;
        attempts++;
        const state = attempts === 1 ? { provider, status: 'error', message: 'Synthetic sign-in failed.' }
          : { provider, status: 'pending', verificationUrl: provider === 'claude' ? 'https://claude.com/oauth/authorize' : 'https://auth.openai.com/codex/device', ...(provider === 'chatgpt' ? { userCode: 'ABCD-12345' } : {}) };
        states = states.map(item => item.provider === provider ? state : item); return state;
      });
      ipcMain.handle('ai:submit-code', (_event, provider, code) => {
        if (provider !== 'claude' || code !== 'synthetic-code#state') throw new Error('Unexpected test code');
        states = states.map(item => item.provider === provider ? { provider, status: 'connected' } : item);
      });
      ipcMain.handle('ai:cancel', () => { states = states.map(item => item.status === 'connected' ? item : { provider: item.provider, status: 'disconnected' }); });
      ipcMain.handle('ai:reopen', () => { if (selected === 'chatgpt') states = states.map(item => item.provider === selected ? { provider: selected, status: 'connected' } : item); });
    });
    const openAccounts = async () => {
      await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    };
    await openAccounts();
    await page.getByRole('dialog', { name: 'Connect your AI', exact: true }).waitFor();
    await page.getByRole('alert').filter({ hasText: 'needs an app restart' }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Connect a trading platform', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Claude', exact: true }).isDisabled(), true);
    await application.evaluate(() => { globalThis.syntheticAiUnavailable = false; });
    await page.getByRole('button', { name: 'Retry AI connection check', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Claude', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic sign-in failed.' }).waitFor();
    await page.getByRole('button', { name: 'Retry sign-in', exact: true }).click();
    await page.getByRole('button', { name: 'Open Claude sign-in ↗', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'ChatGPT', exact: true }).click();
    await page.getByLabel('ChatGPT device code').filter({ hasText: 'ABCD-12345' }).waitFor();
    await page.getByRole('button', { name: 'Open ChatGPT sign-in ↗', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
    await page.keyboard.press('Escape'); // management does not replay AI onboarding
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    // Simulate no saved AI connection, then complete Claude's reverse code flow.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:status');
      let state = { provider: 'claude', status: 'disconnected' };
      ipcMain.handle('ai:status', () => [state]);
      ipcMain.removeHandler('ai:start');
      ipcMain.handle('ai:start', () => { state = { provider: 'claude', status: 'pending', verificationUrl: 'https://claude.com/oauth/authorize' }; return state; });
      ipcMain.removeHandler('ai:submit-code');
      ipcMain.handle('ai:submit-code', (_event, provider, code) => {
        if (provider !== 'claude' || code !== 'synthetic-code#state') throw new Error('Unexpected code');
        state = { provider: 'claude', status: 'connected' };
      });
    });
    await page.reload(); // existing brokerage account with no AI resumes the AI step
    await page.getByRole('dialog', { name: 'Connect your AI', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Claude', exact: true }).click();
    await page.getByLabel('Claude authorization code').fill('synthetic-code#state');
    await page.getByRole('button', { name: 'Connect Claude', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.reload(); // connected Robinhood + AI do not reopen onboarding
    await page.locator('main').waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); } await removeProfile(userData);
  }
});

test('OpenCode onboarding reuses saved credentials and adds an API key inline', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'opentake-opencode-ui-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 }); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      const connection = { status: 'connected', accounts: [{ id: 'synthetic', nickname: 'Agentic', maskedNumber: '••••1234', agenticAllowed: true, selected: true }] };
      for (const name of ['connections:status', 'connections:select', 'ai:status', 'ai:use-credential', 'ai:check-opencode', 'settings:credentials:list', 'settings:credentials:save']) ipcMain.removeHandler(name);
      let connected = false;
      let installed = false;
      let attempts = 0;
      ipcMain.handle('ai:check-opencode', () => { installed = true; });
      let items = [{ id: 'saved-ai', name: 'Saved AI', type: 'ai-provider', provider: 'OpenCode Zen' }, { id: 'not-ai', name: 'HTTP credential', type: 'http-api', provider: 'HTTP API' }];
      ipcMain.handle('connections:status', () => ({ ok: true, connection }));
      ipcMain.handle('connections:select', () => { connected = false; return { ok: true, connection }; });
      ipcMain.handle('ai:status', () => [{ provider: 'opencode', installed, status: connected ? 'connected' : 'disconnected' }]);
      ipcMain.handle('settings:credentials:list', () => ({ ok: true, items }));
      ipcMain.handle('settings:credentials:save', (_event, input) => {
        if (JSON.parse(input.value).apiKey !== 'synthetic-test-key' || input.provider !== 'OpenCode Zen') throw new Error('Unexpected synthetic credential');
        items = [...items, { id: 'new-ai', name: input.name, type: input.type, provider: input.provider }];
        return { ok: true, items };
      });
      ipcMain.handle('ai:use-credential', (_event, id) => {
        if (!['saved-ai', 'new-ai'].includes(id)) throw new Error('Invalid selection');
        if (++attempts === 1) return { ok: false, message: 'Invalid OpenCode Zen API key.' };
        connected = true; return { ok: true };
      });
    });
    const open = async () => {
      await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('Not installed', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'OpenCode Zen', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await page.getByRole('button', { name: 'OpenCode Zen', exact: true }).click();
    };
    await open();
    await page.getByRole('radio', { name: 'Saved AI · OpenCode Zen' }).waitFor();
    assert.equal(await page.getByText('HTTP credential').count(), 0);
    await page.getByRole('button', { name: 'Validate and connect', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Invalid OpenCode Zen API key.' }).waitFor();
    await page.getByRole('button', { name: 'Validate and connect', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('ai:status'); ipcMain.handle('ai:status', () => [{ provider: 'opencode', installed: true, status: 'disconnected' }]); });
    await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: 'Add key for OpenCode Zen', exact: true }).click();
    await page.getByRole('button', { name: 'Add API key', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('New Router');
    await page.getByLabel('OpenCode Zen API key', { exact: true }).fill('synthetic-test-key');
    await page.getByRole('button', { name: 'Save and validate', exact: true }).click();
    await page.getByRole('button', { name: 'Add key for OpenCode Zen', exact: true }).waitFor();
    await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('ai:status'); ipcMain.handle('ai:status', () => [{ provider: 'opencode', installed: true, status: 'connected' }]); });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('main').waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); } await removeProfile(userData);
  }
});

test('OpenRouter onboarding adds a key inline and validates it through its own connection', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'opentake-openrouter-ui-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 }); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      const connection = { status: 'connected', accounts: [{ id: 'synthetic', nickname: 'Agentic', maskedNumber: '••••1234', agenticAllowed: true, selected: true }] };
      for (const name of ['connections:status', 'ai:status', 'ai:use-credential', 'ai:use-openrouter-credential', 'settings:credentials:list', 'settings:credentials:save']) ipcMain.removeHandler(name);
      globalThis.openRouterCalls = [];
      let connected = false;
      let items = [{ id: 'zen', name: 'Zen key', type: 'ai-provider', provider: 'OpenCode Zen' }];
      ipcMain.handle('connections:status', () => ({ ok: true, connection }));
      ipcMain.handle('ai:status', () => [{ provider: 'opencode', installed: true, status: 'disconnected' }, { provider: 'openrouter', installed: true, status: connected ? 'connected' : 'disconnected' }]);
      ipcMain.handle('settings:credentials:list', () => ({ ok: true, items }));
      ipcMain.handle('settings:credentials:save', (_event, input) => {
        const value = JSON.parse(input.value);
        if (value.apiKey !== 'sk-or-synthetic' || input.provider !== 'OpenRouter' || value.provider !== 'OpenRouter' || value.baseUrl !== '') throw new Error('Unexpected synthetic credential');
        items = [...items, { id: 'router', name: input.name, type: input.type, provider: input.provider }];
        return { ok: true, items };
      });
      ipcMain.handle('ai:use-credential', () => { throw new Error('OpenRouter must not use the Zen connection'); });
      ipcMain.handle('ai:use-openrouter-credential', (_event, id) => { globalThis.openRouterCalls.push(id); connected = true; return { ok: true }; });
    });
    // The first open loads the platform status; tabs appear once it is known to be connected.
    await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: 'Add key for OpenRouter', exact: true }).click();
    await page.getByText(/Validation only reads the key’s limits and costs nothing/).waitFor();
    await page.getByText('No OpenRouter keys saved yet.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Zen key').count(), 0);
    await page.getByRole('button', { name: 'Add API key', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('My OpenRouter');
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sk-or-synthetic');
    await page.getByRole('button', { name: 'Save and validate', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect OpenRouter', exact: true }).waitFor();
    assert.deepEqual(await application.evaluate(() => globalThis.openRouterCalls), ['router']);
    assert.equal(await page.getByText('sk-or-synthetic').count(), 0);
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); } await removeProfile(userData);
  }
});

test('connection manager shows Platform and AI tabs and disconnects the platform', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'opentake-connections-tabs-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 }); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      let connection = { status: 'connected', accounts: [{ id: 'synthetic', nickname: 'Agentic', maskedNumber: '••••1234', agenticAllowed: true, selected: true }] };
      for (const name of ['connections:status', 'connections:disconnect', 'ai:status', 'ai:disconnect']) ipcMain.removeHandler(name);
      ipcMain.handle('connections:status', () => ({ ok: true, connection }));
      ipcMain.handle('connections:disconnect', () => { connection = { status: 'disconnected', accounts: [] }; return { ok: true, connection }; });
      let aiConnected = true;
      ipcMain.handle('ai:disconnect', (_event, provider) => { assertProvider(provider); aiConnected = false; });
      function assertProvider(provider) { if (provider !== 'chatgpt') throw new Error('Unexpected provider'); }
      ipcMain.handle('ai:status', () => [{ provider: 'chatgpt', installed: true, status: aiConnected ? 'connected' : 'disconnected' }, { provider: 'claude', installed: true, status: 'disconnected' }, { provider: 'opencode', installed: true, status: 'disconnected' }]);
    });
    await page.reload();
    await page.locator('main').waitFor();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Connect trading platform', exact: true }).click();
    await page.getByRole('dialog', { name: 'Connections', exact: true }).waitFor();
    await page.getByRole('tabpanel').getByText('Connected', { exact: true }).waitFor();
    await page.getByText('MCP · ••••1234', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Connect Claude', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add key for OpenCode Zen', exact: true }).click();
    // A setup step's Back sits in the Connections header, not inline in the step.
    assert.equal(await page.getByRole('button', { name: '← Back' }).count(), 0);
    await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Add key for OpenCode Zen', exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'Platform', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByText('Sign in to your Robinhood agentic account or create one to get started.').waitFor();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click();
    await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); } await removeProfile(userData);
  }
});

test('settings Connections shows selected masked account and connected AI providers', { timeout: smokeTimeout(30_000) }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'opentake-settings-connections-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath: launchPath, args: [...launchArgs, `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow({ timeout: process.platform === 'win32' ? 60_000 : 30_000 }); page.setDefaultTimeout(6000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('connections:status');
      ipcMain.handle('connections:status', () => ({ ok: true, connection: { status: 'connected', checkedAt: null, accounts: [
        { id: 'selected', nickname: 'Trading', maskedNumber: '••••1234', agenticAllowed: true, selected: true },
        { id: 'other', nickname: 'Other fixture', maskedNumber: '••••9999', agenticAllowed: true, selected: false },
        { id: 'individual', nickname: 'Individual fixture', maskedNumber: '••••0000', agenticAllowed: false, selected: false },
      ] } }));
      ipcMain.removeHandler('ai:status');
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'connected' }, { provider: 'chatgpt', status: 'connected' }, { provider: 'opencode', status: 'disconnected' }]);
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    const section = page.getByRole('region', { name: 'Connections', exact: true });
    await section.getByLabel('Masked account number').filter({ hasText: '••••1234' }).waitFor();
    assert.equal(await section.getByText('Other fixture', { exact: false }).count(), 0);
    assert.equal(await section.getByText('Individual fixture', { exact: false }).count(), 0);
    const ai = section.getByRole('region', { name: 'AI', exact: true });
    await ai.getByText('Claude', { exact: true }).waitFor();
    await ai.getByText('ChatGPT', { exact: true }).waitFor();
    assert.equal(await ai.getByText('Connected', { exact: true }).count(), 2);
    assert.equal(await ai.getByText('OpenCode', { exact: true }).count(), 0);
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:status');
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'disconnected' }]);
      ipcMain.removeHandler('connections:status');
      ipcMain.handle('connections:status', () => ({ ok: true, connection: { status: 'disconnected', accounts: [] } }));
    });
    await ai.getByText('No AI connected yet.', { exact: true }).waitFor();
    await section.getByText('Not connected', { exact: true }).waitFor();
    assert.equal(await section.getByLabel('Masked account number').count(), 0);
  } finally {
    try { if (application) await closeDesktop(application); } finally { await stopHost(userData); } await removeProfile(userData);
  }
});
