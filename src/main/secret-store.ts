import { createHash } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivateWrite, privateDirectory } from './private-files';

export interface SecretStore {
  available(): boolean;
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  has(ref: string): Promise<boolean>;
  delete(ref: string): Promise<void>;
  compareAndSet?(ref: string, expected: string, value: string): Promise<boolean>;
}
export interface SecretEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export function osSecretEncryption(storage: {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}, platform = process.platform): SecretEncryption {
  function available(): boolean {
    try {
      return storage.isEncryptionAvailable() && (platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend()));
    } catch { return false; }
  }
  return {
    available,
    encrypt: value => { if (!available()) throw new Error('Secure OS storage unavailable'); return storage.encryptString(value); },
    decrypt: value => { if (!available()) throw new Error('Secure OS storage unavailable'); return storage.decryptString(value); },
  };
}

// Main-process only: never expose get() or arbitrary secret references over IPC.
export function createSecretStore(directory: string, encryption: SecretEncryption): SecretStore {
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  }
  function pathFor(ref: string): string {
    if (typeof ref !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(ref)) throw new Error('Invalid secret reference');
    return join(directory, `${createHash('sha256').update(ref).digest('hex')}.secret`);
  }
  async function prepare(): Promise<void> {
    if (!encryption.available()) throw new Error('Secure OS storage unavailable');
    await privateDirectory(directory);
  }
  async function read(ref: string): Promise<string | null> {
    const path = pathFor(ref);
    await prepare();
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Invalid secret file');
      const record = JSON.parse(encryption.decrypt(await readFile(path)));
      if (record.version !== 1 || record.ref !== ref || typeof record.value !== 'string') throw new Error('Invalid secret record');
      return record.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Secret could not be read; reconnect the account or unlock OS storage');
    }
  }
  async function write(ref: string, value: string): Promise<void> {
    const path = pathFor(ref);
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 16 * 1024) throw new Error('Invalid secret value');
    await prepare();
    const encrypted = encryption.encrypt(JSON.stringify({ version: 1, ref, value }));
    await atomicPrivateWrite(path, encrypted);
  }
  return {
    available: () => encryption.available(),
    get: ref => serialize(() => read(ref)),
    has: ref => serialize(async () => (await read(ref)) !== null),
    set: (ref, value) => serialize(() => write(ref, value)),
    compareAndSet: (ref, expected, value) => serialize(async () => {
      if (await read(ref) !== expected) return false;
      await write(ref, value); return true;
    }),
    delete: ref => serialize(async () => {
      const path = pathFor(ref);
      await prepare();
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }),
  };
}
