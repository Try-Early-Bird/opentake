import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { loadConfigFromFile } from 'electron-vite';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';
import { stopHost } from './helpers/host.mjs';

test('nav search uses the host, preserves drafts, and keeps distinct venue rows stable as results arrive', { timeout: 90000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-search-ui-'));
  let app; let server;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    if (process.env.SEARCH_TEST_DEV === '1') {
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('electron.vite.config.ts'));
      server = await createServer({ ...loaded.config.renderer, configFile: false, root: resolve('src/renderer'),
        cacheDir: join(profile, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
      await server.listen(); env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0];
    }
    app = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:models'); ipcMain.handle('chat:models', () => ({ ok: true, models: [{ value: 'fixture', label: 'Synthetic model' }, { value: 'fixture-quick', label: 'Quick model' }], source: 'catalog' }));
    });
    await dismissConnectionPrompt(page, app);
    await page.waitForFunction(async () => { try { return !!(await window.activity.hostStatus()).pid; } catch { return false; } });
    // Real host/preload path, empty disconnected synthetic profile; no MCP reads.
    const target = await page.evaluate(async () => { const id = await window.takes.create(); await window.takes.update(id, { title: 'Search fixture take' }); return id; });
    await page.getByRole('textbox', { name: /^Message / }).fill('Keep this unsent draft');
    await page.getByRole('button', { name: 'Search markets and takes', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Search', exact: true });
    const input = dialog.getByRole('combobox', { name: 'Search markets and takes' });
    await input.fill('Search fixture');
    await dialog.getByRole('option', { name: /Search fixture take/ }).waitFor();
    await input.press('ArrowDown'); await input.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(id => window.location && document.querySelector('textarea')?.value === '', target);
    const saved = await page.evaluate(async () => { const result = await window.takes.snapshot(null, false); return Promise.all(result.takes.map(t => window.takes.snapshot(t.id, false))); });
    assert.ok(saved.some(s => s.take?.draft === 'Keep this unsent draft'), 'new unsent draft saved before navigation');

    // Synthetic adapters exercise incremental IPC snapshots and foreign venues.
    await app.evaluate(({ ipcMain }) => {
      const hit = (venue, kind, pair) => ({ identity: { venue, instance: 'test', reference: 'btc', kind, ...(pair ? { pair } : {}) }, symbol: 'BTC', name: 'Bitcoin', venueLabel: venue, typeLabel: kind, quote: { price: kind === 'Perpetual' ? '64203.5' : '64000', previousClose: '63000', currency: 'USD', asOf: '2026-10-09T14:00:00.000Z', fetchedAt: '2026-10-09T14:00:01.000Z' } });
      globalThis.searchFixtures = { request: null, late: false, resolved: null };
      const snapshot = request => ({ id: request.id, query: request.query, takes: [], localState: 'complete', localTruncated: false,
        done: globalThis.searchFixtures.late || !request.sources.includes('Slow venue'),
        sources: request.sources.map(id => ({ id, label: id, state: id === 'Slow venue' && !globalThis.searchFixtures.late ? 'pending' : 'complete', truncated: false,
          markets: id === 'Slow venue' ? globalThis.searchFixtures.late ? [hit(id, 'Spot', 'BTC-USD')] : [] : [hit(id, 'Spot', 'BTC-USD'), hit(id, 'Perpetual', 'BTC-USDC')] })) });
      for (const method of ['sources', 'start', 'snapshot', 'cancel', 'resolve']) ipcMain.removeHandler('search:' + method);
      ipcMain.handle('search:sources', () => ['Slow venue', 'Fast venue'].map(id => ({ id, label: id, connected: true, capabilities: { lookup: true, details: true, screening: false } })));
      ipcMain.handle('search:start', (_event, request) => { globalThis.searchFixtures.request = request; return snapshot(request); });
      ipcMain.handle('search:snapshot', (_event, id) => globalThis.searchFixtures.request?.id === id ? snapshot(globalThis.searchFixtures.request) : null);
      ipcMain.handle('search:cancel', () => {});
      ipcMain.handle('search:resolve', (_event, value) => { globalThis.searchFixtures.resolved = value; return value; });
    });
    // App-wide shortcut, when focus is outside editable fields.
    await page.getByRole('link', { name: 'Opentake home' }).focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await dialog.waitFor(); await input.fill('BTC');
    await dialog.getByRole('option', { name: /Perpetual.*Fast venue/ }).waitFor();
    assert.equal(await dialog.getByRole('option').count(), 2);
    // Select by the displayed identity; ranking may place Perpetual before Spot.
    await page.mouse.move(0, 0);
    const options = await dialog.getByRole('option').allTextContents();
    const targetIndex = options.findIndex(text => /Perpetual[\s\S]*Fast venue/.test(text));
    assert.ok(targetIndex >= 0);
    for (let index = 0; index <= targetIndex; index++) await input.press('ArrowDown');
    assert.match(await dialog.locator('[aria-selected="true"]').innerText(), /Perpetual/);
    await app.evaluate(() => { globalThis.searchFixtures.late = true; });
    await dialog.getByRole('option', { name: /Slow venue/ }).waitFor();
    assert.equal(await dialog.getByRole('option').count(), 3);
    assert.match(await dialog.locator('[aria-selected="true"]').innerText(), /Perpetual[\s\S]*Fast venue/);
    const selected = dialog.locator('[aria-selected="true"]');
    assert.match(await selected.locator('[data-search-column="quote"]').innerText(), /\$64,203\.50[\s\S]*1\.91%/);
    const columns = await selected.locator('[data-search-column]').evaluateAll(elements => elements.map(el => ({ name: el.dataset.searchColumn, x: el.getBoundingClientRect().x })));
    assert.deepEqual(columns.map(column => column.name), ['instrument', 'venue', 'quote']);
    assert.ok(columns[0].x < columns[1].x && columns[1].x < columns[2].x);
    if (process.env.SEARCH_SCREENSHOT_PATH) await page.screenshot({ path: process.env.SEARCH_SCREENSHOT_PATH });
    await input.press('Enter'); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'Market unavailable' }).waitFor();
    assert.deepEqual(await app.evaluate(() => globalThis.searchFixtures.resolved.identity), { venue: 'Fast venue', instance: 'test', reference: 'btc', kind: 'Perpetual', pair: 'BTC-USDC' });

    await page.getByRole('button', { name: 'Search markets and takes', exact: true }).click();
    await dialog.getByRole('option', { name: /Perpetual.*Fast venue/ }).waitFor();
    assert.equal(await dialog.getByRole('option', { name: /Perpetual.*Fast venue/ }).getByLabel('Price unavailable').count(), 1);
    await dialog.getByRole('button', { name: 'Clear recent searches' }).click();
    assert.equal(await dialog.getByRole('button', { name: /^Clear (search|recent searches)$/ }).count(), 0);
    assert.equal(await dialog.getByRole('option').count(), 0);
    await input.fill('BTC');
    const filters = dialog.getByRole('button', { name: 'Search filters', exact: true });
    assert.equal(await page.getByRole('menu', { name: 'Search filters' }).count(), 0);
    await filters.click();
    const menu = page.getByRole('menu', { name: 'Search filters' });
    await menu.waitFor();
    if (process.env.SEARCH_FILTER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.SEARCH_FILTER_SCREENSHOT_PATH });
    await menu.getByRole('menuitemcheckbox', { name: 'Slow venue', exact: true }).click();
    assert.equal(await menu.isVisible(), true);
    assert.equal(await menu.getByRole('menuitemcheckbox', { name: 'Slow venue', exact: true }).getAttribute('aria-checked'), 'false');
    await dialog.getByRole('option', { name: /Perpetual.*Fast venue/ }).waitFor();
    await menu.getByRole('menuitemcheckbox', { name: 'Fast venue', exact: true }).click();
    await menu.getByRole('menuitemcheckbox', { name: 'Archived takes', exact: true }).click();
    assert.equal(await menu.getByRole('menuitemcheckbox', { name: 'Archived takes', exact: true }).getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    assert.equal(await dialog.isVisible(), true);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search filters');
    await dialog.getByText('Searching local takes only.', { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#global-search-results [role="option"]').length === 0);
    await input.press('Enter'); assert.equal(await dialog.isVisible(), true);
    await input.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.id === 'nav-search-button');
    // Search configuration uses the actual host settings bridge, with synthetic AI status/catalog.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:status');
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'connected' }]);
    });
    await page.getByRole('button', { name: 'Search markets and takes', exact: true }).click();
    await dialog.getByRole('button', { name: 'Search AI models', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Search settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Search', exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Search', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('search-ai-selection').innerText(), 'No search AI selected');
    await page.getByRole('button', { name: 'Choose AI model', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Synthetic model', exact: true }).click();
    await page.getByRole('combobox', { name: 'Read market data', exact: true }).click();
    await page.getByRole('option', { name: 'Block', exact: true }).click();
    await page.getByRole('combobox', { name: 'Manage search screeners', exact: true }).click();
    await page.getByRole('option', { name: 'Ask', exact: true }).click();
    await page.getByRole('button', { name: 'Save search settings', exact: true }).click();
    await page.getByText('Search settings saved.', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.settings.search()), {
      version: 1, selection: { provider: 'claude', model: 'fixture' }, permissions: { marketData: 'blocked', managedScreeners: 'ask' },
    });
    // Real native-dialog / host backup path, using only fixture files and the disposable profile.
    const backupPath = join(profile, 'fixture-screens.json'), exportPath = join(profile, 'exported-screens.json');
    const backup = { kind: 'opentake-saved-screens', version: 1, exportedAt: new Date().toISOString(), screens: [{
      version: 1, id: '30000000-0000-4000-8000-000000000001', originRunId: '30000000-0000-4000-8000-000000000002',
      createdAt: new Date().toISOString(), title: 'Imported fixture screen', question: 'Find stocks over five dollars',
      selection: { provider: 'claude', model: 'fixture' }, includeNewVenues: false,
      sources: [{ adapterVersion: 1, scope: { venue: 'robinhood', instance: 'production', connectionId: 'fixture', accountId: 'fixture' },
        definition: { filters: [{ filter_type: 'PRICE', predicate: '>', values: ['5'] }], sorting_column: 'Market cap', sorting_direction: 'desc' } }],
    }] };
    await writeFile(backupPath, JSON.stringify(backup));
    await app.evaluate(({ dialog }, paths) => {
      globalThis.originalSearchDialogs = { open: dialog.showOpenDialog, save: dialog.showSaveDialog };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.backup] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.export });
    }, { backup: backupPath, export: exportPath });
    await page.getByRole('button', { name: 'Import saved screens', exact: true }).click();
    await page.getByText('1 screens to add · 0 duplicates skipped', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.searchAgent.saved())).length, 0, 'preview does not write');
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.getByRole('button', { name: 'Import saved screens', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
    await page.getByText('1 saved screens imported; 0 duplicates skipped.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Export saved screens', exact: true }).click();
    await page.getByText('Saved screens exported.', { exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await readFile(exportPath, 'utf8')).screens, backup.screens);
    await page.getByRole('button', { name: 'Import saved screens', exact: true }).click();
    await page.getByText('0 screens to add · 1 duplicates skipped', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.evaluate(id => window.searchAgent.removeSaved(id), backup.screens[0].id);
    await page.getByRole('button', { name: 'Check Robinhood for interrupted screener', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Screener recovery is blocked by current search or server permissions.' }).waitFor();
    await writeFile(backupPath, JSON.stringify({ ...backup, version: 999 }));
    await page.getByRole('button', { name: 'Import saved screens', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Invalid or unsupported saved-screen backup.' }).waitFor();
    await app.evaluate(({ dialog, ipcMain }) => {
      dialog.showOpenDialog = globalThis.originalSearchDialogs.open; dialog.showSaveDialog = globalThis.originalSearchDialogs.save;
      ipcMain.removeHandler('search:agent:preview-recovery'); ipcMain.removeHandler('search:agent:confirm-recovery');
      globalThis.recoveryConfirmed = false;
      ipcMain.handle('search:agent:preview-recovery', () => ({ status: 'ready', id: 'fixture-scan', title: 'Opentake · Ask Agent · fixture nonce', token: 'fixture-preview' }));
      ipcMain.handle('search:agent:confirm-recovery', (_event, token) => { if (token !== 'fixture-preview') throw new Error('Wrong token'); globalThis.recoveryConfirmed = true; });
    });
    await page.getByRole('button', { name: 'Check Robinhood for interrupted screener', exact: true }).click();
    await page.getByRole('button', { name: 'Reconnect search screener', exact: true }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.recoveryConfirmed), false);
    await page.getByRole('button', { name: 'Reconnect search screener', exact: true }).click();
    await page.getByText('Search screener reconnected. You can rerun your search.', { exact: true }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.recoveryConfirmed), true);
    if (process.env.SEARCH_SETTINGS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.SEARCH_SETTINGS_SCREENSHOT_PATH });
    await page.getByRole('button', { name: 'Search markets and takes', exact: true }).click();
    await dialog.getByRole('button', { name: 'Search AI models', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Quick model', exact: true }).click();
    await page.waitForFunction(async () => (await window.settings.search()).selection?.model === 'fixture-quick');
    assert.equal((await page.evaluate(() => window.settings.search())).permissions.marketData, 'blocked');
    await input.fill('BTC');
    await dialog.getByRole('option', { name: /Perpetual.*Fast venue/ }).waitFor();
    await input.press('Escape');
    await app.evaluate(({ ipcMain }) => {
      globalThis.agentFixture = { starts: 0, replays: 0, sequence: 0, stopped: false, approved: false, saved: [], mode: null, run: null, question: '' };
      const fixture = globalThis.agentFixture;
      const begin = (question, mode = null) => {
        fixture.stopped = false; fixture.approved = false; fixture.mode = mode; fixture.question = question;
        fixture.run = `10000000-0000-4000-8000-${String(++fixture.sequence).padStart(12, '0')}`;
        return fixture.run;
      };
      for (const name of ['start', 'snapshot', 'stop', 'decide', 'saved', 'save', 'remove-saved', 'replay']) ipcMain.removeHandler('search:agent:' + name);
      ipcMain.handle('search:agent:start', (_event, request) => { fixture.starts++; return begin(request.question); });
      ipcMain.handle('search:agent:snapshot', () => ({ id: fixture.run, question: fixture.question, sources: ['Fast venue'], selection: { provider: 'claude', model: 'fixture-quick' },
        state: fixture.stopped ? 'cancelled' : fixture.approved ? 'completed' : 'running',
        text: fixture.approved ? 'A provider-backed fixture result.' : '',
        canSave: fixture.approved && !fixture.mode, replay: fixture.mode,
        screening: fixture.approved ? { venue: 'robinhood', total: 100, returned: 1, omitted: 2, truncated: true, sortedBy: 'Market cap desc' } : undefined,
        markets: fixture.approved ? [{ identity: { venue: 'Fast venue', instance: 'test', reference: 'agent-fixture', kind: 'Spot' }, symbol: 'AGENT', name: 'Agent fixture', typeLabel: 'Spot', venueLabel: 'Fast venue' }] : [],
        approvals: fixture.approved || fixture.stopped ? [] : [{ id: 'approval', title: 'Allow market lookup?', detail: 'Synthetic approval' }] }));
      ipcMain.handle('search:agent:decide', (_event, run, _approval, allowed) => { if (run === fixture.run) fixture.approved = allowed; });
      ipcMain.handle('search:agent:stop', (_event, run) => { if (run === fixture.run) fixture.stopped = true; });
      ipcMain.handle('search:agent:saved', () => fixture.saved);
      ipcMain.handle('search:agent:save', (_event, run, title, venues) => {
        if (JSON.stringify(venues) !== JSON.stringify(['Fast venue'])) throw new Error('Wrong saved scope');
        if (run !== fixture.run || !fixture.approved || fixture.mode) throw new Error('Not saveable');
        const saved = { id: '20000000-0000-4000-8000-000000000001', title, question: fixture.question, venues: ['Fast venue'], createdAt: '2026-10-09T00:00:00.000Z', conditions: ['Price > 5'] };
        fixture.saved = [saved]; return saved;
      });
      ipcMain.handle('search:agent:remove-saved', (_event, id) => { fixture.saved = fixture.saved.filter(s => s.id !== id); });
      ipcMain.handle('search:agent:replay', (_event, id) => {
        const saved = fixture.saved.find(s => s.id === id); if (!saved) throw new Error('Missing saved screen');
        fixture.replays++; return begin(saved.question, { id, title: saved.title });
      });
    });
    await page.getByRole('button', { name: 'Search markets and takes', exact: true }).click();
    await input.fill('Find companies with positive daily returns and rank them by market capitalization');
    assert.equal(await app.evaluate(() => globalThis.agentFixture.starts), 0);
    await dialog.getByRole('button', { name: 'Ask Agent', exact: true }).click();
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).click();
    await dialog.getByRole('option', { name: /AGENT.*Agent fixture/ }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.agentFixture.starts), 1);
    await dialog.getByText(/Robinhood screen: 1 of 100 matches.*result limit reached.*2 rows unavailable/).waitFor();
    await dialog.getByRole('button', { name: 'Save screen', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Saved screen name', exact: true }).fill('My market screen');
    await dialog.getByRole('checkbox', { name: 'Save venue Fast venue', exact: true }).uncheck();
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await dialog.getByRole('checkbox', { name: 'Save venue Fast venue', exact: true }).check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByText('Screen saved with its current venue and account.', { exact: true }).waitFor();
    await input.fill('');
    await dialog.getByRole('button', { name: 'Run saved screen My market screen', exact: true }).click();
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).click();
    await dialog.getByText('Saved screen · My market screen · no AI call', { exact: true }).waitFor();
    await dialog.getByRole('option', { name: /AGENT.*Agent fixture/ }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.agentFixture.starts), 1, 'replay does not start an AI search');
    assert.equal(await app.evaluate(() => globalThis.agentFixture.replays), 1);
    await input.fill('');
    await dialog.getByRole('button', { name: 'Remove saved screen My market screen', exact: true }).click();
    await dialog.getByRole('button', { name: 'Run saved screen My market screen', exact: true }).waitFor({ state: 'hidden' });
    await input.fill('Another fixture');
    await input.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Stop agent search', exact: true }).click();
    await dialog.getByText('Agent search stopped.', { exact: true }).waitFor();
    await input.press('Escape');
    assert.deepEqual(errors, []);
  } finally {
    await app?.close(); await server?.close(); await stopHost(profile); await rm(profile, { recursive: true, force: true });
  }
});
