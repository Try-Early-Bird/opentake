/** Stable account identities; UI selection never changes credential authority. */
export interface PlatformAccountConnection {
  connectionId: string;
  accountId: string;
  venue: 'coinbase';
  environment: 'live';
  label: string;
  portfolioName: string;
  maskedReference: string;
  status: 'connected' | 'disconnected' | 'reauth_required' | 'storage_locked';
  checkedAt: string | null;
  permissions: { view: true; trade: boolean; transfer: false };
  capabilities: { accountRead: boolean; chat: boolean; trading: false };
  issue: string | null;
}
export type CoinbaseConnectionResult = { ok: true; connections: PlatformAccountConnection[]; cancelled?: boolean }
  | { ok: false; message: string };
export type CoinbaseImportStage = 'key' | 'permissions' | 'portfolio' | 'saving';
export interface CoinbaseConnectionsAPI {
  list(): Promise<CoinbaseConnectionResult>;
  importKey(input: { connectionId?: string; label?: string; readOnly: boolean }): Promise<CoinbaseConnectionResult>;
  importDroppedKey(file: File, input: { connectionId?: string; readOnly: boolean }): Promise<CoinbaseConnectionResult>;
  importProgress(): Promise<CoinbaseImportStage | null>;
  refresh(connectionId: string): Promise<CoinbaseConnectionResult>;
  rename(connectionId: string, label: string): Promise<CoinbaseConnectionResult>;
  disconnect(connectionId: string): Promise<CoinbaseConnectionResult>;
  cancel(): Promise<void>;
  openPortal(destination?: 'keys' | 'portfolios' | 'portfolio-help'): Promise<void>;
}

/** Immutable per-response scope. Authority is a digest, never a credential. */
export interface CoinbaseChatScope { accountRef: string; label: string; authority: string }
