import { createSearchSettings } from './search/settings';
import { getJobRetention, setJobRetention } from './job-history';
import { getAiAuditRetention, setAiAuditRetention } from './ai-audit-retention';
import { chooseFinancialRetention, getFinancialRetention } from './allocations/retention';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptBackup, MAX_BACKUP_BYTES, validBackupPassword } from './backup-crypto';
import type { SecretStore } from './secret-store';
import { createCredentials } from './credentials';
import type { CredentialMetadata, CredentialResult } from '../shared/credentials';
import { validateArchive } from './import-archive';
import type { createDatabaseLifecycle } from './database';
import { directoryBytes, exportSnapshot, postgresAllocatedBytes } from './database-tools';
import type { ExportResult, ImportResult, ImportSelection, MemoryStats } from '../shared/settings';
import { migrationHistory } from './migrations';

interface SettingsContext { clientId: string }
export function createSettingsService(database: ReturnType<typeof createDatabaseLifecycle>, isQuitting: () => boolean, secrets: SecretStore,
  profilePath: string, metrics: () => Array<{ pid: number; memory: { workingSetSize: number } }>, connectionBusy = () => false) {
  const handlers = new Map<string, (event: SettingsContext, ...args: unknown[]) => unknown>();
  const ipcMain = { handle: (name: string, handler: (event: SettingsContext, ...args: unknown[]) => unknown) => handlers.set(name, handler) };
  const credentials = createCredentials(secrets);
  const searchSettings = createSearchSettings(profilePath);
  let exporting = false;
  let importing = false;
  let selection: { token: string; path: string; sender: string } | undefined;
  function owner(_event: SettingsContext): void {
    if (isQuitting()) throw new Error('Settings unavailable');
  }
  async function credentialOperation(event: SettingsContext, operation: () => Promise<CredentialMetadata[]>): Promise<CredentialResult> {
    owner(event);
    try { return { ok: true, items: await operation() }; }
    catch { return { ok: false, message: 'Could not update credentials. Check that the name is unique and try again. Existing data has not been reset.' }; }
  }
  ipcMain.handle('settings:search:get', event => { owner(event); return searchSettings.read(); });
  ipcMain.handle('settings:search:set', (event, value: unknown) => { owner(event); return searchSettings.save(value); });
  ipcMain.handle('settings:credentials:list', event => credentialOperation(event, () => credentials.list()));
  ipcMain.handle('settings:credentials:save', (event, input: unknown) => credentialOperation(event, () => credentials.save(input)));
  ipcMain.handle('settings:credentials:remove', (event, id: unknown) => credentialOperation(event, () => credentials.remove(id)));
  ipcMain.handle('settings:security', event => {
    owner(event);
    return { secretStorageAvailable: secrets.available(), databaseEncrypted: false, filesystemProtection: process.platform === 'win32' ? 'profile-acl' : 'owner-only', diskEncryption: 'not-verified' };
  });
  ipcMain.handle('settings:job-retention:get', event => { owner(event); return database.use(getJobRetention); });
  ipcMain.handle('settings:job-retention:set', (event, days: unknown) => { owner(event); return database.use(db => setJobRetention(db, days)); });
  ipcMain.handle('settings:ai-audit-retention:get', event => { owner(event); return database.use(getAiAuditRetention); });
  ipcMain.handle('settings:ai-audit-retention:set', (event, days: unknown) => { owner(event); return database.use(db => setAiAuditRetention(db, days)); });
  ipcMain.handle('settings:financial-retention:get', event => { owner(event); return database.use(getFinancialRetention); });
  ipcMain.handle('settings:financial-retention:set', (event, days: unknown) => { owner(event); return database.use(db => chooseFinancialRetention(db, days)); });
  ipcMain.handle('settings:migrations', event => { owner(event); return database.use(migrationHistory); });
  ipcMain.handle('settings:memory', async (event): Promise<MemoryStats> => {
    owner(event);
    return database.use(async (db) => {
      const processes = metrics();
      return {
        appWorkingSetBytes: processes.reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0),
        mainWorkingSetBytes: (processes.find(metric => metric.pid === process.pid)?.memory.workingSetSize ?? 0) * 1024,
        processCount: processes.length,
        postgresAllocatedBytes: await postgresAllocatedBytes(db),
        storageBytes: await directoryBytes(database.directory),
      };
    });
  });
  ipcMain.handle('settings:export', async (event, password: unknown, filePath: unknown): Promise<ExportResult> => {
    owner(event);
    if (!validBackupPassword(password)) return { status: 'error', message: 'Use a backup passphrase of at least 12 characters (maximum 1024 bytes).' };
    if (exporting || importing) return { status: 'error', message: 'A database operation is already in progress.' };
    exporting = true;
    try {
      if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error('Invalid destination');
      // Do not allow an export to overwrite files in the active app profile.
      const profile = await realpath(profilePath);
      const parent = await realpath(dirname(filePath));
      const difference = relative(profile, parent);
      if (difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))) {
        return { status: 'error', message: 'Choose a destination outside the app data folder.' };
      }
      await database.use(db => exportSnapshot(db, filePath, password));
      return { status: 'saved' };
    } catch {
      return { status: 'error', message: 'Export failed. Check the destination and available disk space.' };
    } finally {
      exporting = false;
    }
  });
  ipcMain.handle('settings:choose-import', async (event, filePath: unknown): Promise<ImportSelection> => {
    owner(event);
    if (importing || exporting) return { status: 'error', message: 'A database operation is already in progress.' };
    selection = undefined;
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return { status: 'error', message: 'Choose a backup file.' };
    selection = { token: randomUUID(), path: filePath, sender: event.clientId };
    return { status: 'selected', token: selection.token, name: basename(selection.path) };
  });
  ipcMain.handle('settings:import', async (event, token: unknown, password: unknown, allowLegacy: unknown): Promise<ImportResult> => {
    owner(event);
    if (connectionBusy() || importing || exporting || !selection || token !== selection.token || selection.sender !== event.clientId) {
      return { status: 'error', message: 'Choose the archive again before importing.' };
    }
    const selected = selection;
    selection = undefined; // One confirmation authorizes one attempt.
    importing = true;
    try {
      const file = await open(selected.path, 'r');
      let content: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) throw new Error('Invalid archive size');
        // Bounded read even if another process grows the selected file.
        const buffer = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) throw new Error('Archive changed');
        content = buffer.subarray(0, bytesRead);
      } finally { await file.close(); }
      const legacy = content[0] === 0x1f && content[1] === 0x8b;
      if (legacy && allowLegacy !== true) throw new Error('Legacy import must be acknowledged');
      const plaintext = legacy ? content : await decryptBackup(content, typeof password === 'string' ? password : '');
      let backup: string;
      try {
        const snapshot = validateArchive(plaintext);
        backup = await database.replace(snapshot);
      } finally { plaintext.fill(0); }
      return { status: 'imported', message: `Database imported. Previous database retained at: ${backup}` };
    } catch {
      return { status: 'error', message: 'Import failed. Check the passphrase, backup integrity, and legacy acknowledgement. Limit: 64 MiB compressed / 256 MiB expanded. The previous database is retained.' };
    } finally { importing = false; }
  });
  return {
    flush: () => credentials.flush(),
    busy: () => exporting || importing,
    invoke(name: string, args: unknown[], clientId: string): unknown {
      const handler = handlers.get(name);
      if (!handler) throw new Error('Unknown settings operation');
      return handler({ clientId }, ...args);
    },
  };
}
