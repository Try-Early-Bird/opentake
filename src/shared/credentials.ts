import { websocketCredentialSchema } from './websocket-credential';
export const credentialTypes = { 'ai-provider': 'AI provider', 'http-api': 'HTTP API', 'websocket-api': 'WebSocket API', database: 'Database', 'key-value': 'Key/value', 'api-key': 'API key', 'bearer-token': 'Bearer token' } as const;
export const credentialMenu = ['ai-provider', 'http-api', 'websocket-api', 'database', 'key-value'] as const;
export const aiBaseUrls: Record<string, string> = { OpenAI: 'https://api.openai.com/v1', OpenRouter: 'https://openrouter.ai/api/v1', Anthropic: 'https://api.anthropic.com/v1', Google: 'https://generativelanguage.googleapis.com/v1beta', 'OpenCode Zen': 'https://opencode.ai/zen/v1', 'xAI (Grok)': 'https://api.x.ai/v1' };
export type CredentialField = { key: string; label: string; secret?: boolean; options?: string[]; optional?: boolean; placeholder?: string };
export const credentialFields: Partial<Record<CredentialType, CredentialField[]>> = {
  'ai-provider': [{ key: 'provider', label: 'AI provider', options: ['OpenAI', 'Anthropic', 'Google', 'OpenRouter', 'OpenCode Zen', 'xAI (Grok)', 'Other'] }, { key: 'baseUrl', label: 'Custom base URL (optional)', optional: true }, { key: 'apiFormat', label: 'API format', options: ['OpenAI-compatible', 'Anthropic', 'Google Gemini'], optional: true }, { key: 'organization', label: 'Organization ID (optional)', optional: true }, { key: 'project', label: 'Project ID (optional)', optional: true }, { key: 'apiKey', label: 'API key', secret: true }],
  'websocket-api': [{key:'endpoint',label:'WebSocket endpoint',placeholder:'wss://feed.example.com/prices'},{key:'kind',label:'Authentication',options:['bearer','basic','api-key','message']},{key:'header',label:'API-key header',options:['X-API-Key','API-Key']},{key:'value',label:'Token / credential value (base64 username:password for Basic)',secret:true}],
  'http-api': [{ key: 'url', label: 'Base URL' }, { key: 'auth', label: 'Authentication', options: ['Bearer token', 'Custom header', 'Basic auth'] }, { key: 'header', label: 'Header name' }, { key: 'username', label: 'Username' }, { key: 'secret', label: 'Token / password', secret: true }],
  database: [{ key: 'engine', label: 'Database engine', options: ['PostgreSQL', 'MySQL'] }, { key: 'host', label: 'Host' }, { key: 'port', label: 'Port' }, { key: 'database', label: 'Database name' }, { key: 'username', label: 'Username' }, { key: 'tls', label: 'TLS', options: ['Verify certificate', 'Disabled (local development only)'] }, { key: 'password', label: 'Password', secret: true }],
  'key-value': [{ key: 'key', label: 'Key' }, { key: 'value', label: 'Secret value', secret: true }],
};
export function visibleCredentialFields(type: CredentialType, values: Record<string, string>): CredentialField[] {
  if (type === 'websocket-api') return credentialFields[type]!.filter(field=>field.key!=='header'||values.kind==='api-key');
  if (type === 'ai-provider') return credentialFields[type]!.filter(field =>
    (field.key !== 'apiFormat' || values.provider === 'Other') &&
    (!['organization', 'project'].includes(field.key) || values.provider === 'OpenAI')
  ).map(field => field.key === 'baseUrl' ? { ...field, label: values.provider === 'Other' ? 'Base URL' : field.label, optional: values.provider !== 'Other', placeholder: aiBaseUrls[values.provider] ?? 'https://your-provider.example/v1' } : field);
  return (credentialFields[type] ?? []).filter(field => type !== 'http-api' || (field.key !== 'header' || values.auth === 'Custom header') && (field.key !== 'username' || values.auth === 'Basic auth'));
}
export function validateCredentialPayload(type: CredentialType, raw: string, forSave = false): void {
  if (type === 'websocket-api') { websocketCredentialSchema.parse(JSON.parse(raw)); return; }
  if (!credentialFields[type]) return; // Original API-key / bearer-token records remain supported.
  const values = JSON.parse(raw);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid fields');
  for (const field of visibleCredentialFields(type, values)) {
    const value = values[field.key];
    if (value === undefined && (field.optional || (!forSave && type === 'ai-provider' && field.key === 'baseUrl'))) continue;
    if (!forSave && type === 'ai-provider' && field.key === 'baseUrl' && value === '') continue;
    if (typeof value !== 'string' || (!field.optional && !value.trim()) || value.length > 4096 || (field.options && !field.options.includes(value))) throw new Error('Invalid fields');
  }
  for (const key of type === 'ai-provider' ? ['baseUrl'] : type === 'http-api' ? ['url'] : []) {
    if (!values[key]) continue;
    const url = new URL(values[key]);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
    if (forSave && type === 'ai-provider' && (url.search || url.hash || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS or a local endpoint, without query parameters');
  }
  if (forSave && type === 'ai-provider') {
    if (values.provider === 'Other' && (!values.baseUrl?.trim() || !values.apiFormat)) throw new Error('Custom provider requires URL and API format');
    if (['apiKey', 'organization', 'project'].some(key => typeof values[key] === 'string' && /[\r\n]/.test(values[key]))) throw new Error('Invalid credential header');
  }
  if (type === 'http-api' && values.auth === 'Custom header' && !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(values.header)) throw new Error('Invalid header');
  if (type === 'database' && (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535)) throw new Error('Invalid port');
}
export type CredentialType = keyof typeof credentialTypes;
export interface CredentialMetadata {
  id: string;
  name: string;
  provider: string;
  type: CredentialType;
  updatedAt: string;
}
export interface CredentialInput { id?: string; name: string; provider: string; type: CredentialType; value?: string }
export type CredentialResult = { ok: true; items: CredentialMetadata[] } | { ok: false; message: string };
