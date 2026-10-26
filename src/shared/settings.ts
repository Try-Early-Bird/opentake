import type { SearchSettings } from './search-settings';
import type { CredentialInput, CredentialResult } from './credentials';
import type { AppVersion, UpdateState } from './app-updates';
export interface LoginItemState { supported: boolean; enabled: boolean; message?: string }
export interface MemoryStats {
  appWorkingSetBytes: number;
  mainWorkingSetBytes: number;
  processCount: number;
  postgresAllocatedBytes: number | null;
  storageBytes: number;
}

export type ExportResult = { status: 'saved' | 'cancelled' | 'error'; message?: string };
export type ImportSelection = { status: 'selected'; token: string; name: string } | { status: 'cancelled' | 'error'; message?: string };
export type ImportResult = { status: 'imported' | 'error'; message: string };
export interface SettingsAPI {
  search(): Promise<SearchSettings>;
  saveSearch(value: SearchSettings): Promise<SearchSettings>;
  appVersion(): Promise<AppVersion>;
  checkForUpdates(includePrereleases: boolean): Promise<UpdateState>;
  updateState(): Promise<UpdateState>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  openUpdateDownload(): Promise<void>;
  jobRetention(): Promise<number | null>;
  setJobRetention(days: number | null): Promise<number | null>;
  financialRetention(): Promise<number | null>;
  setFinancialRetention(days: number | null): Promise<number | null>;
  aiAuditRetention(): Promise<number | null>;
  setAiAuditRetention(days: number | null): Promise<number | null>;
  loginItem(): Promise<LoginItemState>;
  setLoginItem(enabled: boolean): Promise<LoginItemState>;
  migrationHistory(): Promise<Array<{ version: number; name: string; appliedAt: string }>>;
  listCredentials(): Promise<CredentialResult>;
  saveCredential(input: CredentialInput): Promise<CredentialResult>;
  removeCredential(id: string): Promise<CredentialResult>;
  securityStatus(): Promise<{ secretStorageAvailable: boolean; databaseEncrypted: false; filesystemProtection: 'profile-acl' | 'owner-only'; diskEncryption: 'not-verified' }>;
  logRetention(): Promise<number>;
  setLogRetention(days:number): Promise<number>;
  logs(): Promise<import('./diagnostics').DiagnosticPage>;
  memoryStats(): Promise<MemoryStats>;
  exportDatabase(password: string): Promise<ExportResult>;
  chooseImport(): Promise<ImportSelection>;
  importDatabase(token: string, password: string, allowLegacy: boolean): Promise<ImportResult>;
}
