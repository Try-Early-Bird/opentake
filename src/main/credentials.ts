import { websocketCredentialSchema } from '../shared/websocket-credential';
import { randomUUID } from 'node:crypto';
import type { SecretStore } from './secret-store';
import { credentialTypes, validateCredentialPayload, type CredentialInput, type CredentialMetadata } from '../shared/credentials';

type Record = CredentialMetadata & { value: string; generation?: string };
const reference = 'credentials:v1';
// Keep metadata and values in one atomic encrypted record, outside database backups.
// This small manual inventory does not grant any venue/agent access.
export function createCredentials(store: SecretStore) {
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  }
  function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 80; }
  function validate(value: unknown): asserts value is CredentialInput {
    if (!value || typeof value !== 'object') throw new Error('Invalid credential');
    const input = value as CredentialInput;
    if (!validText(input.name) || !validText(input.provider) || !Object.hasOwn(credentialTypes, input.type)) throw new Error('Invalid credential');
    if (input.id !== undefined && (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id))) throw new Error('Invalid credential');
    if (input.value !== undefined && (typeof input.value !== 'string' || !input.value.length || Buffer.byteLength(input.value) > 4096)) throw new Error('Invalid credential');
    if (input.value !== undefined) validateCredentialPayload(input.type, input.value);
  }
  async function read(): Promise<Record[]> {
    const raw = await store.get(reference);
    if (raw === null) return [];
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 50) throw new Error('Invalid inventory');
    const ids = new Set<string>();
    for (const item of data.items) {
      validate(item);
      if (!item.id || !item.value || !('updatedAt' in item) || typeof item.updatedAt !== 'string' || ids.has(item.id)) throw new Error('Invalid inventory');
      ids.add(item.id);
    }
    return data.items;
  }
  const metadata = (items: Record[]): CredentialMetadata[] => items.map(({ id, name, provider, type, updatedAt }) => ({ id, name, provider, type, updatedAt }));
  async function write(items: Record[]) {
    const payload = JSON.stringify({ version: 1, items });
    if (items.length > 50 || Buffer.byteLength(payload) > 16 * 1024) throw new Error('Credential inventory capacity reached');
    await store.set(reference, payload);
    return metadata(items);
  }
  return {
    // Host-only WSS access; never expose resolved values through IPC.
    sourceWebsocketCredential: (id: string, endpoint: string) => serial(async () => {
      try {
        const item = (await read()).find(item => item.id === id && item.type === 'websocket-api');
        if (!item) throw Error();
        const fields = websocketCredentialSchema.parse(JSON.parse(item.value));
        if (new URL(fields.endpoint).href !== new URL(endpoint).href) throw Error();
        return { ...fields, generation: item.generation ?? item.updatedAt };
      } catch { throw Error('WebSocket source credential unavailable or incompatible with endpoint'); }
    }),
    // Host-only HTTP source access. Never expose this resolver through credential IPC.
    sourceHttpCredential: (id: string, endpoint: string) => serial(async () => {
      try {
        const item = (await read()).find(item => item.id === id && item.type === 'http-api');
        if (!item) throw Error();
        const fields = JSON.parse(item.value) as { url: string; auth: string; header?: string; username?: string; secret: string };
        const base = new URL(fields.url), target = new URL(endpoint);
        // A credential is scoped to its HTTPS origin and base path, never a sibling
        // path or another host. Reject encoded path separators/escapes conservatively.
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
            (base.port && base.port !== '443') || target.origin !== base.origin || target.username || target.password || target.search || target.hash ||
            /%|\\/.test(base.pathname + target.pathname)) throw Error();
        const prefix = base.pathname.replace(/\/$/, '');
        if (target.pathname !== prefix && !target.pathname.startsWith(prefix + '/')) throw Error();
        if (!fields.secret || /[\r\n]/.test(fields.secret)) throw Error();
        if (fields.auth === 'Bearer token') return { kind: 'bearer' as const, value: fields.secret };
        if (fields.auth === 'Custom header' && ['x-api-key', 'api-key'].includes(fields.header?.toLowerCase() ?? '')) {
          return { kind: 'api-key' as const, header: fields.header!.toLowerCase() === 'x-api-key' ? 'X-API-Key' as const : 'API-Key' as const, value: fields.secret };
        }
        if (fields.auth === 'Basic auth' && fields.username && !/[:\r\n]/.test(fields.username)) {
          return { kind: 'basic' as const, value: Buffer.from(`${fields.username}:${fields.secret}`, 'utf8').toString('base64') };
        }
        throw Error();
      } catch { throw new Error('HTTP source credential unavailable or incompatible with endpoint'); }
    }),
    mcpSecret: (id: string) => serial(async () => {
      const item=(await read()).find(item=>item.id===id);
      if(!item || !['key-value','api-key','bearer-token'].includes(item.type)) throw new Error('Choose a key/value or token credential.');
      return item.type==='key-value' ? JSON.parse(item.value).value as string : item.value;
    }),
    // Main-process only; never exposed through credential IPC.
    aiCredential: (id: unknown) => serial(async () => {
      const item = (await read()).find(item => item.id === id && item.type === 'ai-provider');
      if (!item) throw new Error('Unknown AI credential');
      return { ...item };
    }),
    list: () => serial(async () => metadata(await read())),
    save: (input: unknown) => serial(async () => {
      validate(input);
      if (input.type === 'database' && !input.id) throw new Error('New database credentials are disabled');
      if (input.value !== undefined) validateCredentialPayload(input.type, input.value, true);
      const items = await read();
      const current = input.id ? items.find(item => item.id === input.id) : undefined;
      if (input.id && !current) throw new Error('Unknown credential');
      if (current && input.type !== current.type) throw new Error('Credential type cannot change');
      if (!current && !input.value) throw new Error('Credential value required');
      if (items.some(item => item.id !== input.id && item.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error('Duplicate name');
      const record: Record = { id: current?.id ?? randomUUID(), name: input.name.trim(), provider: input.provider.trim(), type: input.type, value: input.value ?? current!.value, updatedAt: new Date().toISOString(), generation: randomUUID() };
      return write(current ? items.map(item => item.id === current.id ? record : item) : [...items, record]);
    }),
    remove: (id: unknown) => serial(async () => {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid credential ID');
      const items = await read();
      if (!items.some(item => item.id === id)) throw new Error('Unknown credential');
      return write(items.filter(item => item.id !== id));
    }),
    flush: () => pending.then(() => {}),
  };
}
