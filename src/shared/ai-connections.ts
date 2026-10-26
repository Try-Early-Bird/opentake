export type AiProvider = 'chatgpt' | 'claude' | 'grok';
export interface AiConnectionState {
  provider: AiProvider | 'opencode' | 'openrouter' | 'local';
  status: 'disconnected' | 'starting' | 'pending' | 'connected' | 'error';
  installed?: boolean;
  version?: string;
  verificationUrl?: string;
  userCode?: string;
  message?: string;
}
export interface GrokAccessResult { ok: boolean; message: string }
export interface AiConnectionsAPI {
  testGrok(): Promise<GrokAccessResult>;
  cancelGrokTest(): Promise<void>;
  status(): Promise<AiConnectionState[]>;
  start(provider: AiProvider): Promise<AiConnectionState>;
  submitCode(provider: AiProvider, code: string): Promise<void>;
  useCredential(id: string): Promise<{ ok: boolean; message?: string }>;
  /** Re-checks the OpenCode installation used by Zen, OpenRouter and local models. */
  checkOpenCode(): Promise<void>;
  connectLocal(baseUrl: string): Promise<{ ok: boolean; message?: string }>;
  useOpenRouterCredential(id: string): Promise<{ ok: boolean; message?: string }>;
  disconnect(provider: AiConnectionState['provider']): Promise<void>;
  cancel(): Promise<void>;
  reopen(): Promise<void>;
}
