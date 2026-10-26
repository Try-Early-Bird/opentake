import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { createSecretStore, osSecretEncryption } from '../../src/main/secret-store';
import { encryptBackup, decryptBackup } from '../../src/main/backup-crypto';
import { secureTree } from '../../src/main/private-files';

test('OS encryption refuses Linux basic_text, unknown backends and unavailable keychains', () => {
  let backend = 'basic_text';
  let available = true;
  const provider = osSecretEncryption({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: () => { throw new Error('Must not reach encryption'); },
    decryptString: () => { throw new Error('Must not reach decryption'); },
  }, 'linux');
  expect(provider.available()).toBe(false);
  expect(() => provider.encrypt('secret')).toThrow(/unavailable/);
  backend = 'unknown'; expect(provider.available()).toBe(false);
  backend = 'gnome_libsecret'; expect(provider.available()).toBe(true);
  available = false; expect(provider.available()).toBe(false);
});

test('encrypted backups reject wrong passwords, tampering, unsupported versions and weak passwords', async () => {
  const data = Buffer.from('private database test content');
  const pass = 'unit-test-passphrase';
  const a = await encryptBackup(data, pass);
  const b = await encryptBackup(data, pass);
  expect(a.equals(b)).toBe(false);
  expect(a.includes(data)).toBe(false);
  expect(await decryptBackup(a, pass)).toEqual(data);
  await expect(decryptBackup(a, 'incorrect-passphrase')).rejects.toThrow();
  for (const position of [8, 24, 40, a.length - 1]) {
    const corrupt = Buffer.from(a); corrupt[position] ^= 1;
    await expect(decryptBackup(corrupt, pass)).rejects.toThrow();
  }
  const version = Buffer.from(a); version[7] = 50;
  await expect(decryptBackup(version, pass)).rejects.toThrow();
  await expect(decryptBackup(a.subarray(0, 30), pass)).rejects.toThrow();
  await expect(encryptBackup(data, 'short')).rejects.toThrow();
});

test('secret store encrypts, persists, serializes writes, binds references and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-secrets-'));
  const key = randomBytes(32);
  let available = true;
  // A test encryption provider, not a production fallback or OS-keychain mock bypass.
  const provider = {
    available: () => available,
    encrypt: (text: string) => {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: (data: Buffer) => {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString();
    },
  };
  try {
    const store = createSecretStore(root, provider);
    await Promise.all([store.set('connection:one:key', 'not-for-logs'), store.set('connection:one:key', 'latest-secret')]);
    expect(await store.get('connection:one:key')).toBe('latest-secret');
    const reopened = createSecretStore(root, provider);
    expect(await reopened.has('connection:one:key')).toBe(true);
    const [file] = await readdir(root);
    const ciphertext = await readFile(join(root, file));
    expect(ciphertext.includes(Buffer.from('latest-secret'))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
    available = false;
    await expect(store.get('connection:one:key')).rejects.toThrow(/unavailable/);
    await expect(store.set('connection:two:key', 'blocked')).rejects.toThrow(/unavailable/);
    expect(await readdir(root)).toEqual([file]);
    available = true;
    await expect(store.set('../escape', 'value')).rejects.toThrow();
    await writeFile(join(root, file), provider.encrypt(JSON.stringify({ version: 1, ref: 'wrong-reference', value: 'substitution' })));
    await expect(store.get('connection:one:key')).rejects.toThrow(/could not be read/);
    await store.delete('connection:one:key');
    expect(await store.has('connection:one:key')).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally { key.fill(0); await rm(root, { recursive: true, force: true }); }
});

test('database filesystem protection tightens existing files and rejects links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-permissions-'));
  try {
    const directory = join(root, 'database');
    await mkdir(directory, { mode: 0o755 });
    await writeFile(join(directory, 'data'), 'preserved', { mode: 0o644 });
    await secureTree(directory);
    expect(await readFile(join(directory, 'data'), 'utf8')).toBe('preserved');
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'data'))).mode & 0o777).toBe(0o600);
      await symlink(join(directory, 'data'), join(directory, 'link'));
      await expect(secureTree(directory)).rejects.toThrow(/links/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
