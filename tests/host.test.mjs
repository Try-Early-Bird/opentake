import { readHostLog } from './helpers/diagnostics.mjs';
import { closeDesktop } from './helpers/desktop.mjs';
import { migrationVersions } from './helpers/migrations.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { hostRequest } from './helpers/host.mjs';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';

async function rpc(profile, method) {
  // Only disposable test manifests. This is the local IPC capability, not SecretStore.
  const host = JSON.parse(await readFile(join(profile, 'host.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ method, args: [], clientId: randomUUID() }), signal: AbortSignal.timeout(3000) });
  return (await response.json()).value;
}
async function waitStopped(profile, pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(join(profile, 'host.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (pid === undefined) return;
      // Unpublishing IPC precedes the final diagnostic and process exit.
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
    }
    await delay(100);
  }
  throw new Error('Host did not stop');
}

test('background host survives desktop closure, is adopted on reopen, and quits completely', { timeout: 40_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-host-e2e-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  const launch = () => electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env, timeout: 15000 });
  try {
    application = await launch();
    let page = await application.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await page.locator('main').waitFor();
    const first = await page.evaluate(() => window.activity.hostStatus());
    assert.notEqual(first.pid, application.process().pid);
    const history = await page.evaluate(() => window.settings.migrationHistory());
    assert.deepEqual(history.map(item => item.version), migrationVersions);
    assert.equal((await page.evaluate(() => window.settings.securityStatus())).secretStorageAvailable, false);
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByText('No active jobs.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Quit completely/ }).count(), 0);
    await page.keyboard.press('Escape');
    await closeDesktop(application); application = undefined;
    assert.equal((await rpc(profile, 'host:status')).pid, first.pid);
    application = await launch();
    page = await application.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await page.locator('main').waitFor();
    assert.equal((await page.evaluate(() => window.activity.hostStatus())).pid, first.pid);
    assert.deepEqual(await page.evaluate(() => window.settings.migrationHistory()), history);
    await page.evaluate(() => window.activity.quitCompletely());
    await waitStopped(profile, first.pid);
    assert.ok((await readHostLog(profile)).includes('database.closed'));
  } finally {
    if (application) await closeDesktop(application).catch(() => {});
    await rpc(profile, 'host:shutdown').catch(() => {});
    await waitStopped(profile);
    // Chromium helpers can release profile locks just after the main process exits on Windows.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('activity queue shows running, retrying, attention and completed jobs without credential fields', { timeout: 25_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-queue-ui-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    application = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    assert.deepEqual(await page.evaluate(() => window.activity.history()), { jobs: [], nextCursor: null });
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('activity:list'); ipcMain.removeHandler('activity:retry'); ipcMain.removeHandler('activity:history'); ipcMain.removeHandler('activity:details');
      const jobs = ['running', 'retrying', 'needs_attention', 'completed'].map((state, index) => ({ id: `fixture-${index}`, kind: 'account_sync', state, attempts: 1, reason: 'manual', errorCode: state === 'needs_attention' ? 'storage_locked' : state === 'retrying' ? 'transient' : null, updatedAt: new Date().toISOString(), nextRunAt: new Date().toISOString() }));
      ipcMain.handle('activity:list', () => jobs);
      ipcMain.handle('activity:details', (_, id) => ({
        job: { ...jobs[0], id, createdAt: new Date().toISOString() }, truncated: false,
        events: [{ id: 'event-1', state: 'running', attempts: 1, errorCode: null, occurredAt: new Date().toISOString(), nextRunAt: new Date().toISOString() }],
      }));
      const history = Array.from({ length: 120 }, (_, index) => ({ ...jobs[3], id: `history-${index}`, updatedAt: new Date(Date.now() - index * 60_000).toISOString() }));
      ipcMain.handle('activity:history', (_, cursor) => {
        const start = cursor ? history.findIndex(job => job.id === cursor.id) + 1 : 0;
        const page = history.slice(start, start + 50);
        return { jobs: page, nextCursor: start + 50 < history.length ? { id: page.at(-1).id, updatedAt: page.at(-1).updatedAt } : null };
      });
      ipcMain.handle('activity:retry', () => { jobs[2].state = 'pending'; jobs[2].errorCode = null; });
    });
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('button', { name: 'Sync Robinhood accounts', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Execution log', exact: true }).waitFor();
    await page.getByText('Running · Attempt 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    for (const label of ['Running', 'Retrying']) await page.getByText(label, { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Needs attention', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry Sync Robinhood accounts', exact: true }).click();
    await page.getByText('Queued', { exact: true }).waitFor();
    assert.equal(await page.getByText('Completed', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await page.getByText('Completed', { exact: true }).first().waitFor();
    await page.getByText('Running', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: 'View all' }).click();
    await page.getByRole('heading', { name: 'Job History', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
    await page.getByRole('main', { name: 'Job History' }).getByRole('listitem').nth(49).waitFor();
    await page.getByRole('main', { name: 'Job History' }).getByRole('listitem').nth(49).scrollIntoViewIfNeeded();
    await page.getByRole('main', { name: 'Job History' }).getByRole('listitem').nth(99).waitFor({ state: 'attached' });
    await page.getByRole('main', { name: 'Job History' }).getByRole('listitem').nth(99).scrollIntoViewIfNeeded();
    await page.getByText('You’ve reached the end of your job history.').waitFor();
    assert.equal(await page.getByRole('main', { name: 'Job History' }).getByRole('listitem').count(), 120);
    await page.getByRole('link', { name: 'Data retention', exact: true }).click();
    await page.getByLabel('Keep job history', { exact: true }).click();
    await page.getByRole('option', { name: '30 days', exact: true }).click();
    await page.getByText('Retention saved.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.settings.jobRetention()), 30);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings:job-retention:set');
      ipcMain.handle('settings:job-retention:set', () => { throw new Error('Synthetic save failure'); });
    });
    await page.getByLabel('Keep job history', { exact: true }).click();
    await page.getByRole('option', { name: '7 days', exact: true }).click();
    await page.getByText('Could not save retention. Your previous setting is unchanged. Try selecting again.', { exact: true }).waitFor();
    assert.match(await page.getByLabel('Keep job history', { exact: true }).innerText(), /30 days/);
    assert.equal(await page.evaluate(() => window.settings.jobRetention()), 30);
  } finally {
    if (application) await closeDesktop(application).catch(() => {});
    await rpc(profile, 'host:shutdown').catch(() => {}); await waitStopped(profile);
    // Chromium helpers can release profile locks just after the main process exits on Windows.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('host-owned backup/import stays behind desktop file dialogs and rejects unsafe destinations', { timeout: 30_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-host-backup-'));
  const output = await mkdtemp(join(tmpdir(), 'earlybird-host-export-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    application = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await application.firstWindow();
    await dismissConnectionPrompt(page, application);
    await page.locator('main').waitFor();
    const file = join(output, 'fixture.ebbackup');
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
    assert.equal((await page.evaluate(() => window.settings.exportDatabase('synthetic-test-passphrase'))).status, 'saved');
    assert.equal((await readFile(file)).subarray(0, 8).toString(), 'EBBACK01');
    const imported = await page.evaluate(async () => {
      const selected = await window.settings.chooseImport();
      return window.settings.importDatabase(selected.token, 'synthetic-test-passphrase', false);
    });
    assert.equal(imported.status, 'imported');
    assert.deepEqual((await page.evaluate(() => window.settings.migrationHistory())).map(item => item.version), migrationVersions);
    assert.equal((await hostRequest(profile, 'settings:export', ['synthetic-test-passphrase', join(profile, 'unsafe.ebbackup')])).status, 'error');
  } finally {
    if (application) await closeDesktop(application).catch(() => {});
    await rpc(profile, 'host:shutdown').catch(() => {}); await waitStopped(profile);
    // Chromium helpers can release profile locks just after the main process exits on Windows.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(output, { recursive: true, force: true });
  }
});

test('host retires a different build and safely restarts after a process crash', { timeout: 35_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-host-upgrade-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  const launch = () => electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
  try {
    application = await launch();
    await (await application.firstWindow()).locator('main').waitFor();
    await closeDesktop(application); application = undefined;
    const file = join(profile, 'host.json');
    const original = JSON.parse(await readFile(file, 'utf8'));
    // Synthetic manifest in this disposable profile, simulating an older build.
    await writeFile(file, JSON.stringify({ ...original, build: 'older-test-build' }), { mode: 0o600 });
    application = await launch();
    await (await application.firstWindow()).locator('main').waitFor();
    const replacement = await rpc(profile, 'host:status');
    assert.notEqual(replacement.pid, original.pid);
    await closeDesktop(application); application = undefined;
    // Only the host spawned by this test is killed, never a PID from a real profile.
    process.kill(replacement.pid, 'SIGKILL');
    await delay(300);
    application = await launch();
    await (await application.firstWindow()).locator('main').waitFor();
    assert.notEqual((await rpc(profile, 'host:status')).pid, replacement.pid);
    assert.deepEqual((await hostRequest(profile, 'settings:migrations')).map(item => item.version), migrationVersions);
  } finally {
    if (application) await closeDesktop(application).catch(() => {});
    await rpc(profile, 'host:shutdown').catch(() => {}); await waitStopped(profile);
    // Chromium helpers can release profile locks just after the main process exits on Windows.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('MCP redesign collapses servers, updates permissions, and connects with secret references', { timeout: 30_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'earlybird-mcp-design-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    application = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, '--earlybird-test-no-secrets'], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      const server = { id: 'fixture-builtin', config: { name: 'Opentake brokerage', command: 'built-in', transport: 'stdio', args: [], env: {}, bindings: [], url: '', oauth: false }, enabled: true, revision: 1 };
      const tools = ['opentake_connection_status', 'opentake_list_accounts', 'robinhood_get_equity_orders', 'robinhood_get_equity_quotes'].map(name => ({ server_id: server.id, name, policy: 'allowed', fingerprint: 'fixture', definition: { name, description: 'Read connection status and available capabilities.', inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['robinhood'] } }, required: ['platform'] } } }));
      const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler); };
      replace('mcp:list', () => ({ servers: [server], tools }));
      replace('mcp:policy', (_, id, name, policy) => { tools.find(tool => tool.name === name).policy = policy; });
      replace('mcp:enable', (_, id, enabled) => { server.enabled = enabled; });
      replace('settings:credentials:list', () => ({ ok: true, items: [{ id: '00000000-0000-4000-8000-000000000123', name: 'Research API', type: 'api-key', provider: 'MCP', updatedAt: new Date().toISOString() }] }));
      replace('mcp:save', (_, id, config) => { globalThis.mcpSaved = config; return 'fixture-custom'; });
      replace('mcp:discover', () => {});
      replace('settings:credentials:save', (_, input) => {
        if (input.value !== 'synthetic-fixture-key') throw new Error('Unexpected synthetic credential');
        return { ok: true, items: [{ id: '00000000-0000-4000-8000-000000000124', name: input.name, type: 'api-key', provider: 'MCP', updatedAt: new Date().toISOString() }] };
      });
    });
    await page.evaluate(() => { localStorage.setItem('theme', 'dark'); document.documentElement.classList.add('dark'); });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'MCP servers & tools', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse Opentake brokerage', exact: true }).click();
    assert.equal(await page.getByText('Connection status', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Expand Opentake brokerage', exact: true }).click();
    await page.getByRole('button', { name: /Connection status opentake_connection_status/ }).click();
    await page.getByText('string · required', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Full definition', exact: true }).click();
    await page.locator('pre').filter({ hasText: '"platform"' }).waitFor();
    await page.getByRole('button', { name: 'Hide definition', exact: true }).click();
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Ask each time', exact: true }).click();
    await page.getByRole('combobox').first().getByText('Ask each time', { exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), 'earlybird-mcp-settings-redesign.png'), fullPage: true });
    await page.getByRole('button', { name: 'Add server', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP server', exact: true });
    await dialog.getByLabel('Name', { exact: true }).fill('Market research tools');
    await dialog.getByLabel('Server URL', { exact: true }).fill('https://mcp.example.com/mcp');
    await dialog.getByRole('tab', { name: 'API key', exact: true }).click();
    await dialog.getByLabel('Value 1', { exact: true }).fill('synthetic-fixture-key');
    await page.screenshot({ path: join(tmpdir(), 'earlybird-mcp-modal-redesign.png') });
    await dialog.getByRole('button', { name: 'Saved credentials for row 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Research API', exact: true }).click();
    assert.equal(await dialog.getByLabel('Value 1', { exact: true }).count(), 0);
    await dialog.getByLabel('Key 1', { exact: true }).fill('Authorization');
    await dialog.getByRole('button', { name: 'Clear saved credential 1', exact: true }).click();
    await dialog.getByLabel('Value 1', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Saved credentials for row 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Research API', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add header', exact: true }).click();
    await dialog.getByRole('button', { name: 'Saved credentials for row 2', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Research API', exact: true }).click();
    await dialog.getByLabel('Key 2', { exact: true }).fill('X-API-Key');
    await dialog.getByRole('button', { name: 'Add header', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove row 3', exact: true }).click();
    assert.equal(await dialog.getByLabel('Key 3', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Connect server', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved = await application.evaluate(() => globalThis.mcpSaved);
    assert.deepEqual(saved.bindings, [{ name: 'Authorization', credentialId: '00000000-0000-4000-8000-000000000123', prefix: '' }, { name: 'X-API-Key', credentialId: '00000000-0000-4000-8000-000000000123', prefix: '' }]);
    assert.equal(JSON.stringify(saved).includes('synthetic-fixture-key'), false);
    await page.getByRole('button', { name: 'Add server', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('New API server');
    await dialog.getByLabel('Server URL', { exact: true }).fill('https://mcp.example.com/mcp');
    await dialog.getByRole('tab', { name: 'API key', exact: true }).click();
    await dialog.getByLabel('Value 1', { exact: true }).fill('synthetic-fixture-key');
    await dialog.getByRole('button', { name: 'Connect server', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const newKeyConfig = await application.evaluate(() => globalThis.mcpSaved);
    assert.equal(newKeyConfig.bindings[0].credentialId, '00000000-0000-4000-8000-000000000124');
    assert.equal(JSON.stringify(newKeyConfig).includes('synthetic-fixture-key'), false);
    await page.getByRole('button', { name: 'Add server', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Local command', exact: true }).click();
    await dialog.getByLabel('Executable (absolute path)', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Connect server', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.screenshot({ path: join(tmpdir(), 'earlybird-mcp-settings-light.png'), fullPage: true });
    await page.getByRole('button', { name: 'Add server', exact: true }).click();
    await dialog.getByRole('tab', { name: 'API key', exact: true }).click();
    await page.screenshot({ path: join(tmpdir(), 'earlybird-mcp-modal-light.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    if (application) await closeDesktop(application).catch(() => {});
    await rpc(profile, 'host:shutdown').catch(() => {}); await waitStopped(profile);
    // Chromium helpers can release profile locks just after the main process exits on Windows.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
