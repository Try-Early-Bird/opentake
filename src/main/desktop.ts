import {logRetention,setLogRetention} from './diagnostic-retention';
import {createDiagnostics,readDiagnostics} from './diagnostics';
import { SAVED_SEARCH_BACKUP_MAX_BYTES } from '../shared/saved-search';
import { desktopStartupMessage } from './host-startup';
import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';
import { join } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { TAKE_FILE_MAX_BYTES } from '../shared/take-file';
import { randomUUID } from 'node:crypto';
import { ensureHost } from './host-launcher';
import { hostCall, type HostManifest } from './host-rpc';
import { privateDirectory } from './private-files';
import type { MemoryStats } from '../shared/settings';
import icon from '../../resources/icon.png?asset';
import { createLoginItem } from './login-item';
import { createAppUpdates } from './app-updates';
import { createUpdateManager } from './update-manager';
import { stopHostForUpdate } from './update-shutdown';
import { atomicPrivateWrite } from './private-files';
import { readFileSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';

export function bootDesktop(profile: string, build: string) {
  const diagnostics=createDiagnostics(join(profile,'logs','desktop'),app.getVersion());
  diagnostics.record('app.start');
  app.on('before-quit',()=>diagnostics.record('app.quit'));
  ipcMain.handle('settings:log-retention:get',event=>{windowFor(event);return logRetention(join(profile,'logs'));});
  ipcMain.handle('settings:log-retention:set',(event,days:unknown)=>{windowFor(event);return setLogRetention(join(profile,'logs'),days);});
  ipcMain.handle('settings:logs',event=>{windowFor(event);return readDiagnostics(profile);});
  // Separate singleton/Local State, retaining renderer session storage at its
  // original location so theme/font/shortcuts survive this process split.
  app.setPath('userData', join(profile, 'desktop-shell'));
  app.setPath('sessionData', profile);
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  const clientId = randomUUID();
  let host: HostManifest | undefined;
  let quitting = false;
  let preparingUpdate = false;
  let notificationUiSeenAt = 0;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const call = <T>(method: string, args: unknown[] = [], timeout?: number) => {
    if (!host || quitting || preparingUpdate) return Promise.reject(new Error('Background host unavailable'));
    return hostCall<T>(host, method, args, clientId, timeout);
  };
  async function quitCompletely() {
    if (host) await hostCall(host, 'host:shutdown', [], clientId, 2000);
    quitting = true; clearInterval(monitor); app.exit(0);
  }
  async function notificationPresence() {
    const window = BrowserWindow.getAllWindows()[0];
    const focused = !!window?.isFocused() && window.isVisible() && Date.now() - notificationUiSeenAt < 6000;
    const count = await call<number>('notifications:presence', [focused], 2000);
    app.setBadgeCount(count);
  }
  function openWindow() {
    if (quitting) return;
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) { existing.show(); if (existing.isMinimized()) existing.restore(); existing.focus(); return; }
    const window = new BrowserWindow({ width: 1200, height: 820, minWidth: 900, minHeight: 640, title: 'Earlybird-Opentake', icon,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const updatePresence = () => { void notificationPresence().catch(() => {}); };
    window.on('focus', updatePresence); window.on('blur', updatePresence);
    window.on('hide', updatePresence); window.on('closed', updatePresence);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => { void call('host:wake').catch(() => {}); });
    const loading = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? window.loadURL(process.env.ELECTRON_RENDERER_URL)
      : window.loadFile(join(__dirname, '../renderer/index.html'));
    void loading.catch(() => app.quit());
  }
  const passthrough = ['strategies:overview','strategies:mixed-withdrawal-end','strategies:mixed-withdrawal-limits','strategies:mixed-withdrawal-preview','strategies:mixed-withdrawal-confirm','strategies:mixed-withdrawal','strategies:mixed-preview','strategies:mixed-invest','strategies:mixed-investment','allocations:version-review','allocations:adopt-version','strategies:coinbase-lifecycle','strategies:decide-coinbase-lifecycle','strategies:coinbase-withdrawal-band','strategies:coinbase-preflight','strategies:coinbase-investment','strategies:invest-coinbase','strategies:act-coinbase-investment','strategies:save-coinbase-risk','markets:coinbase:detail','markets:coinbase:series','strategies:submit-coinbase-orders','strategies:refresh-coinbase-orders','strategies:coinbase-orders','strategies:preview-coinbase-orders','strategies:confirm-coinbase-orders','strategies:cancel-coinbase-orders','strategies:coinbase-capital','strategies:preview-coinbase-capital','strategies:confirm-coinbase-capital','coinbase:import-progress','coinbase:list','coinbase:refresh','coinbase:rename','coinbase:disconnect','coinbase:cancel','strategies:account-plan','strategies:save-account-plan','strategies:source','strategies:history','strategies:available','strategies:list','strategies:read','strategies:propose','strategies:use-revision','strategies:dismiss-suggestion','strategies:commit','strategies:verify','strategies:commit-review','strategies:message-proposals','strategies:performance','strategies:markers','portfolio:snapshot','portfolio:activity','orders:execute','orders:status','orders:list','orders:review','orders:confirm','orders:abandon','allocations:review','allocations:resume','allocations:pause','allocations:keep-reduced','allocations:cover-shortfall','allocations:holdings','allocations:create','allocations:update','allocations:deposit','allocations:redemption-preview','allocations:redeem','allocations:instructions','allocations:cancel-instruction','allocations:confirm-instruction','allocations:resolve-outside-sale','allocations:abandon-order','allocations:decide-share-event','allocations:close','allocations:plan','allocations:preflight','allocations:activity','allocations:queue-list','allocations:queue-act','allocations:trading-preferences','allocations:set-trading-preferences','portfolio:series','portfolio:strategy-history','portfolio:market','portfolio:logo','portfolio:fundamentals','portfolio:research','portfolio:search','portfolio:refresh','watchlists:lists','watchlists:items','watchlists:membership','watchlists:sync','watchlists:sync-items','watchlists:create','watchlists:rename','watchlists:remove','watchlists:add-item','watchlists:remove-item','watchlists:move','watchlists:move-item','notifications:act','notifications:list','notifications:seen','notifications:target','notifications:acknowledge','mcp:metadata-history','mcp:metadata-revision','mcp:oauth-status','mcp:oauth-start','mcp:oauth-cancel','mcp:oauth-disconnect','mcp:server-policy','mcp:trust-updates','mcp:take-permissions','mcp:set-take-permission','mcp:history','mcp:platform-settings','mcp:platform-configure','mcp:platform-pending','mcp:platform-decide','mcp:list','mcp:save','mcp:enable','mcp:remove','mcp:discover','mcp:policy','mcp:approvals','mcp:decide','mcp:tool-access-requests','mcp:tool-access-decide','takes:messages-page','takes:takes-page','takes:message-versions','takes:budgets','takes:automatic-limits','takes:save-automatic-limits','takes:save-budgets','takes:usage-history','takes:snapshot','takes:create','takes:update','takes:remove','takes:send','takes:stop','takes:document','takes:upload','takes:image','takes:instructions','takes:save-about','takes:restore-default-instructions','takes:instruction-profiles','takes:publish-instruction-profile','takes:instruction-versions','takes:save-instruction-profile','takes:remove-instruction-profile','chat:models','ai:check-opencode','ai:use-credential','ai:use-openrouter-credential','ai:connect-local','ai:grok-test','ai:grok-test-cancel','ai:status','ai:start','ai:submit-code','ai:cancel','ai:disconnect','ai:reopen','settings:credentials:list','settings:credentials:save','settings:credentials:remove','settings:security','settings:migrations','search:agent:saved','search:agent:save','search:agent:remove-saved','search:agent:replay','search:agent:start','search:agent:snapshot','search:agent:stop','search:agent:decide','settings:search:get','settings:search:set','search:sources','search:start','search:snapshot','search:cancel','search:resolve',
    'settings:import', 'connections:tool-schemas','connections:crypto-tool-schemas', 'connections:status', 'connections:connect', 'connections:refresh', 'connections:cancel', 'connections:reopen', 'connections:disconnect', 'connections:select',
    'settings:job-retention:get', 'settings:job-retention:set', 'settings:financial-retention:get', 'settings:financial-retention:set', 'settings:ai-audit-retention:get', 'settings:ai-audit-retention:set', 'activity:details', 'activity:list', 'activity:history', 'activity:retry', 'host:status', 'host:wake'];
  function windowFor(event: Electron.IpcMainInvokeEvent) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame || quitting) throw new Error('Desktop unavailable');
    return window;
  }
  for (const method of passthrough) ipcMain.handle(method, (event, ...args: unknown[]) => { windowFor(event); return call(method, args); });
  // Each renderer gets a private host client identity; never accept it from IPC args.
  const dataClients = new Map<number, string>();
  const dataReads = new Set<number>();
  function dataClient(window: Electron.BrowserWindow) {
    const contents = window.webContents;
    let id = dataClients.get(contents.id);
    if (!id) {
      id = randomUUID(); dataClients.set(contents.id, id);
      const captured = id, contentsId = contents.id;
      const release = () => {
        if (dataClients.get(contentsId) !== captured) return;
        dataClients.delete(contentsId);
        window.removeListener('closed', release); window.removeListener('hide', release); window.removeListener('minimize', release);
        contents.removeListener('render-process-gone', release); contents.removeListener('did-start-loading', release);
        if (host) void hostCall(host, 'dataSources:drop-client', [], captured, 2000).catch(() => {});
      };
      // TTL is the backstop if desktop/renderer teardown prevents this RPC.
      window.once('closed', release); window.once('hide', release); window.once('minimize', release);
      contents.once('render-process-gone', release); contents.once('did-start-loading', release);
    }
    return id;
  }
  for (const method of ['inventory', 'configure', 'list', 'acquire', 'renew', 'read', 'release', 'stream']) {
    ipcMain.handle('dataSources:' + method, (event, ...args: unknown[]) => {
      const window = windowFor(event);
      if (!host || preparingUpdate) throw new Error('Background host unavailable');
      if (method !== 'release' && (!window.isVisible() || window.isMinimized())) throw new Error('Data view inactive');
      const contentsId = window.webContents.id;
      if (method === 'read' && dataReads.has(contentsId)) throw new Error('Data read already pending');
      if (method === 'read') dataReads.add(contentsId);
      return hostCall(host, 'dataSources:' + method, args, dataClient(window), method === 'configure' ? 15000 : 2000)
        .finally(() => { if (method === 'read') dataReads.delete(contentsId); });
    });
  }
  const searchMaintenance = async <T>(method: string, args: unknown[] = []): Promise<T> => {
    const result = await call<{ value: T } | { error: string }>(method, args, 35000);
    if ('error' in result) throw new Error(result.error);
    return result.value;
  };
  for (const method of ['search:agent:import-backup', 'search:agent:preview-recovery', 'search:agent:confirm-recovery']) {
    ipcMain.handle(method, (event, ...args: unknown[]) => { windowFor(event); return searchMaintenance(method, args); });
  }
  ipcMain.handle('search:agent:export-file', async event => {
    const window = windowFor(event);
    const data = await searchMaintenance<unknown>('search:agent:export-backup');
    const chosen = await dialog.showSaveDialog(window, { title: 'Export saved screens', defaultPath: 'opentake-saved-screens.json', filters: [{ name: 'Saved screens', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' };
    await atomicPrivateWrite(chosen.filePath, Buffer.from(JSON.stringify(data)));
    return { status: 'saved' };
  });
  ipcMain.handle('search:agent:import-file', async event => {
    const window = windowFor(event);
    const chosen = await dialog.showOpenDialog(window, { title: 'Import saved screens', properties: ['openFile'], filters: [{ name: 'Saved screens', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { status: 'cancelled' };
    const path = chosen.filePaths[0];
    const limit = SAVED_SEARCH_BACKUP_MAX_BYTES;
    if ((await stat(path)).size > limit) throw new Error('Saved-screen backup exceeds 4 MB.');
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new Error('Saved-screen backup exceeds 4 MB.');
    let data: unknown;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid saved-screen backup.'); }
    return { status: 'preview', preview: await searchMaintenance('search:agent:preview-backup', [data]) };
  });
  ipcMain.handle('notifications:navigation', event => { windowFor(event); notificationUiSeenAt = Date.now(); void notificationPresence().catch(() => {}); return call('notifications:navigation'); });
  // Native selection or a dropped file supplies the key path. Neither the file
  // contents nor a generic path-reading API is exposed to renderer code.
  ipcMain.handle('coinbase:import-key', async (event, input: unknown) => {
    const window = windowFor(event);
    const chosen = await dialog.showOpenDialog(window, { title: 'Import Coinbase API key', properties: ['openFile'],
      filters: [{ name: 'Coinbase key JSON', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: true, cancelled: true, connections: [] };
    return call('coinbase:import-key', [chosen.filePaths[0], input]);
  });
  ipcMain.handle('coinbase:import-dropped-key', (event, path: unknown, input: unknown) => {
    windowFor(event);
    return call('coinbase:import-key', [path, input]);
  });
  ipcMain.handle('coinbase:open-portal', async (event, destination: unknown) => {
    windowFor(event);
    const url = destination === 'portfolios' ? 'https://www.coinbase.com/advanced-portfolio'
      : destination === 'portfolio-help' ? 'https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios'
      : 'https://portal.cdp.coinbase.com/api-keys/secret';
    await shell.openExternal(url);
  });
  // A take as a file (shared/take-file.ts): the host builds and checks it; the desktop owns the file dialogs.
  const fileName=(title:string)=>`${title.replace(/[^a-z0-9]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,60)||'take'}.opentake-take.json`;
  ipcMain.handle('takes:export-file', async (event, takeId: unknown) => {
    const window = windowFor(event);
    const data = await call<{ take: { title: string } } | { error: string }>('takes:export-data', [takeId], 30000);
    if ('error' in data) throw new Error(data.error);
    const chosen = await dialog.showSaveDialog(window, { title: 'Export take', defaultPath: fileName(data.take.title), filters: [{ name: 'Opentake take', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' };
    await writeFile(chosen.filePath, JSON.stringify(data, null, 1), { mode: 0o600 });
    return { status: 'saved' };
  });
  ipcMain.handle('takes:import-file', async event => {
    const window = windowFor(event);
    const chosen = await dialog.showOpenDialog(window, { title: 'Import take', properties: ['openFile'], filters: [{ name: 'Opentake take', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { status: 'cancelled' };
    if ((await stat(chosen.filePaths[0])).size > TAKE_FILE_MAX_BYTES) throw new Error('This file is too large to be a take.');
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(chosen.filePaths[0], 'utf8')); } catch { throw new Error('This is not an Opentake take file, or it is damaged.'); }
    const result = await call<{ takeId: string } | { error: string }>('takes:import-data', [parsed], 60000);
    if ('error' in result) throw new Error(result.error);
    return { status: 'imported', takeId: result.takeId };
  });
  ipcMain.handle('takes:open-link', async (event, value: unknown) => { windowFor(event); if(typeof value !== 'string') throw new Error('Invalid link'); const url = new URL(value); if(!['https:','http:'].includes(url.protocol)||url.username||url.password) throw new Error('Invalid link'); await shell.openExternal(url.href); });
  const loginItem = createLoginItem(app, process.platform, process.execPath);
  const updates = createAppUpdates({ version: app.getVersion(), build: build.slice(0, 12),
    packaged: app.isPackaged, platform: process.platform, arch: process.arch },
  { fetch: (...args) => fetch(...args), openExternal: url => shell.openExternal(url) });
  // Only the signed release configuration opts into in-app installation.
  const releaseUpdates = app.isPackaged && ['darwin', 'win32'].includes(process.platform) &&
    JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).releaseUpdates === true;
  const updateManager = createUpdateManager({ version: app.getVersion(), native: releaseUpdates ? autoUpdater : undefined,
    manualCheck: preview => updates.check(preview),
    savePreview: preview => atomicPrivateWrite(join(profile, 'update-preferences.json'), Buffer.from(JSON.stringify({ preview }))),
    changed: state => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('settings:update-state', state); },
    prepareInstall: async () => {
      preparingUpdate = true;
      try {
        if (!host) throw new Error('Background host unavailable');
        await stopHostForUpdate(profile, host, clientId);
      } catch (error) { preparingUpdate = false; throw error; }
    },
    installFailed: async () => { /* Retain the stopped host; user can restart safely. */ },
  });
  ipcMain.handle('settings:app-version', event => { windowFor(event); return updates.info(); });
  ipcMain.handle('settings:check-updates', (event, includePrereleases: unknown) => { windowFor(event); return updateManager.check(includePrereleases); });
  ipcMain.handle('settings:update-state', event => { windowFor(event); return updateManager.state(); });
  ipcMain.handle('settings:download-update', event => { windowFor(event); return updateManager.download(); });
  ipcMain.handle('settings:install-update', async event => {
    const window = windowFor(event);
    const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['Later', 'Restart and install'], defaultId: 0, cancelId: 0,
      title: 'Install update?', message: 'Restart Opentake to install the downloaded update?',
      detail: 'The background host will stop and flush its database first. Your data and preferences stay on this device. Schema upgrades retain the previous database for recovery.' });
    return choice.response === 1 ? updateManager.install() : updateManager.state();
  });
  ipcMain.handle('settings:open-update', event => { windowFor(event); return updates.openRelease(); });
  ipcMain.handle('settings:login-item:get', event => { windowFor(event); return loginItem.get(); });
  ipcMain.handle('settings:login-item:set', (event, enabled: unknown) => { windowFor(event); return loginItem.set(enabled); });
  ipcMain.handle('host:quit', event => { windowFor(event); setTimeout(() => { void quitCompletely().catch(() => {}); }, 50); });
  ipcMain.handle('settings:memory', async event => {
    windowFor(event);
    const stats = await call<MemoryStats>('settings:memory');
    const metrics = app.getAppMetrics();
    return { ...stats, appWorkingSetBytes: stats.appWorkingSetBytes + metrics.reduce((sum, item) => sum + item.memory.workingSetSize * 1024, 0), processCount: stats.processCount + metrics.length };
  });
  ipcMain.handle('settings:export', async (event, password: unknown) => {
    const window = windowFor(event);
    const chosen = await dialog.showSaveDialog(window, { title: 'Export PGlite database',
      defaultPath: `opentake-database-${new Date().toISOString().slice(0, 10)}.ebbackup`, filters: [{ name: 'Encrypted Opentake backup', extensions: ['ebbackup'] }] });
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' };
    return call('settings:export', [password, chosen.filePath]);
  });
  ipcMain.handle('portfolio:import-strategies', async event => {
    const window=windowFor(event);
    const chosen=await dialog.showOpenDialog(window,{title:'Import existing takes',properties:['openFile'],filters:[{name:'Takes export',extensions:['json']}]});
    if(chosen.canceled||!chosen.filePaths[0])return {status:'cancelled'};
    const importCall=async<T>(method:string,args:unknown[],timeout:number):Promise<T>=>{
      const result=await call<{ok:true;value:T}|{ok:false;message:string}>(method,args,timeout);
      if(!result.ok)throw new Error(result.message);
      return result.value;
    };
    const preview=await importCall<{token:string;update:boolean;strategies:number;allocations:number;entries:number;publishDays:number;lotIds:number}>('portfolio:prepare-strategy-import',[chosen.filePaths[0]],30000);
    // A newer export of an account already imported only adds lot ids and publish days to those takes.
    const confirmation=await dialog.showMessageBox(window,{type:'question',buttons:[preview.update?'Update takes':'Import takes','Cancel'],defaultId:0,cancelId:1,
      message:preview.update?`Update your ${preview.allocations} imported investments?`:`Import ${preview.strategies} takes and ${preview.allocations} investments?`,
      detail:preview.update
        ?`Adds ${preview.lotIds} Robinhood lot ids and ${preview.publishDays} publish dates from this export. Ownership, balances and history stay as imported. No orders will be placed.`
        :`Matched to your selected account. Preserves ${preview.entries} source attribution entries. Imported holdings stay paused for reconciliation. No orders will be placed.`});
    if(confirmation.response!==0)return {status:'cancelled'};
    const result=await importCall<{imported:number;skipped:number}>('portfolio:commit-strategy-import',[preview.token],60000);
    return {status:'imported',...result};
  });
  ipcMain.handle('portfolio:import-history', async event => {
    const window = windowFor(event);
    const chosen = await dialog.showOpenDialog(window, {title:'Import portfolio history',properties:['openFile'],filters:[{name:'Portfolio history export',extensions:['json']}]});
    if(chosen.canceled || !chosen.filePaths[0]) return {status:'cancelled'};
    const preview=await call<{token:string;count:number;earliest:string;latest:string}>('portfolio:prepare-history-import',[chosen.filePaths[0]],30000);
    const confirmed=await dialog.showMessageBox(window,{type:'question',buttons:['Import history','Cancel'],defaultId:0,cancelId:1,
      message:`Import ${preview.count.toLocaleString()} portfolio observations?`,
      detail:`Matched to your selected Robinhood account.\n${new Date(preview.earliest).toLocaleDateString()} – ${new Date(preview.latest).toLocaleDateString()}\n\nThis adds chart history. Current balances, positions and live-sync checkpoints are unchanged.`});
    if(confirmed.response!==0)return {status:'cancelled'};
    const result=await call<{imported:number;skipped:number}>('portfolio:commit-history-import',[preview.token],60000);
    return {status:'imported',...result};
  });
  ipcMain.handle('settings:choose-import', async event => {
    const window = windowFor(event);
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose an Opentake backup', properties: ['openFile'],
      filters: [{ name: 'Opentake backup or legacy PGlite snapshot', extensions: ['ebbackup', 'gz'] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { status: 'cancelled' };
    return call('settings:choose-import', [chosen.filePaths[0]]);
  });
  app.on('second-instance', () => { if (host) openWindow(); });
  app.on('activate', () => { if (host) openWindow(); });
  // app.quit() itself closes the windows. Do not re-enter quit while Electron
  // is already shutting down (Linux/Windows emit window-all-closed here).
  app.on('window-all-closed', () => { if (!quitting) app.quit(); });
  app.on('before-quit', () => { quitting = true; clearInterval(monitor); updateManager.stop(); });
  // Ctrl+C/dev-server stop is explicit full shutdown, unlike closing the GUI.
  process.on('SIGINT', () => { void quitCompletely().catch(() => app.exit(1)); });
  process.on('SIGTERM', () => { void quitCompletely().catch(() => app.exit(1)); });
  void app.whenReady().then(async () => {
    // BrowserWindow.icon does not brand the macOS Dock when running Electron in dev.
    app.dock?.setIcon(icon);
    await privateDirectory(profile);
    host = await ensureHost(profile, build);
    if (quitting) return;
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Opentake', submenu: [{ label: 'Close desktop (keep syncing)', role: 'quit' },
        { label: 'Quit completely', click: () => { void quitCompletely().catch(() => {}); } }] },
      { role: 'editMenu' }, { role: 'viewMenu' },
    ]));
    openWindow();
    let preview = app.getVersion().includes('-');
    try { const saved = JSON.parse(await readFile(join(profile, 'update-preferences.json'), 'utf8')); if (typeof saved.preview === 'boolean') preview = saved.preview; } catch { /* First launch uses the installed channel. */ }
    updateManager.start(preview, app.isPackaged && !app.commandLine.hasSwitch('earlybird-test-no-secrets'));
    let pinging = false;
    let missed = 0;
    // Liveness only: a host busy with the database (a sync after an order) answers
    // status late but is alive. A slow presence update is not a missed ping, and
    // three real misses reconnect (ensureHost reuses a live host or starts one)
    // rather than leaving every call refused as "Background host unavailable".
    monitor = setInterval(() => {
      if (pinging || quitting || preparingUpdate) return; pinging = true;
      void call('host:status', [], 5000).then(() => {
        missed = 0;
        void notificationPresence().catch(() => {});
      }, async () => {
        if (quitting || preparingUpdate) return;
        if (++missed < 3) return;
        missed = 0;
        // A host whose process still runs is busy, not gone: keep waiting for it.
        const pid = host?.pid;
        if (pid !== undefined) { try { process.kill(pid, 0); return; } catch { /* Gone: start another below. */ } }
        try { host = await ensureHost(profile, build); }
        catch (error) { if (!quitting) { quitting = true; clearInterval(monitor); dialog.showErrorBox('Background host unavailable', desktopStartupMessage(error)); app.exit(1); } }
      }).finally(() => { pinging = false; });
    }, 3000);
  }).catch(error => { dialog.showErrorBox('Background host unavailable', desktopStartupMessage(error)); app.exit(1); });
}
