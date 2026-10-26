import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { MAX_ARCHIVE_BYTES } from './import-archive';

// v1 fixes KDF parameters: untrusted files cannot request arbitrary KDF work.
const MAGIC = Buffer.from('EBBACK01');
const HEADER_BYTES = 8 + 16 + 12;
export const MAX_BACKUP_BYTES = MAX_ARCHIVE_BYTES + HEADER_BYTES + 16;
export function validBackupPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 1024;
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (!validBackupPassword(password)) return Promise.reject(new Error('Use a passphrase of 12 or more characters (maximum 1024 bytes)'));
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function encryptBackup(archive: Buffer, password: string): Promise<Buffer> {
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Backup too large');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, nonce]);
  const key = await derive(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(archive), cipher.final()]);
    return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
  } finally { key.fill(0); }
}
export async function decryptBackup(input: Buffer, password: string): Promise<Buffer> {
  if (input.length < HEADER_BYTES + 16 || input.length > MAX_BACKUP_BYTES || !input.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid encrypted backup');
  const key = await derive(password, input.subarray(8, 24));
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(24, HEADER_BYTES));
    decipher.setAAD(input.subarray(0, HEADER_BYTES));
    decipher.setAuthTag(input.subarray(-16));
    plaintext = decipher.update(input.subarray(HEADER_BYTES, -16));
    return Buffer.concat([plaintext, decipher.final()]);
  } finally { key.fill(0); plaintext?.fill(0); }
}
