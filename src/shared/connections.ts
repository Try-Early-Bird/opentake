export interface RobinhoodToolDefinition { annotations?: { readOnlyHint?: boolean; [key:string]: unknown }; name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }
export type RobinhoodSchemaResult = { ok: true; tools: RobinhoodToolDefinition[] } | { ok: false; message: string };
export interface LinkedAccount {
  id: string;
  maskedNumber: string;
  nickname: string | null;
  accountType: string | null;
  optionLevel?: string | null;
  agenticAllowed: boolean;
  selected: boolean;
}
export interface ConnectionSummary {
  status: 'disconnected' | 'connected' | 'reauth_required';
  checkedAt: string | null;
  accounts: LinkedAccount[];
}
export type ConnectionResult = { ok: true; connection: ConnectionSummary; queued?: boolean } | { ok: false; message: string };
export interface ConnectionsAPI {
  toolSchemas(): Promise<RobinhoodSchemaResult>;
  cryptoToolSchemas(): Promise<RobinhoodSchemaResult>;
  status(): Promise<ConnectionResult>;
  connect(): Promise<ConnectionResult>;
  refresh(): Promise<ConnectionResult>;
  cancel(): Promise<void>;
  reopenSignIn(): Promise<void>;
  disconnect(): Promise<ConnectionResult>;
  selectAccount(id: string): Promise<ConnectionResult>;
}
