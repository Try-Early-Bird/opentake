import { createPrivateKey } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CoinbaseError } from './errors';
export interface CoinbaseKey { name: string; privateKey: string }
export function parseCoinbaseKey(raw: string): CoinbaseKey {
  try {
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error();
    const input = JSON.parse(raw);
    if (!input || typeof input.name !== 'string' || !/^organizations\/[A-Za-z0-9_-]+\/apiKeys\/[A-Za-z0-9_-]+$/.test(input.name)
      || input.name.length > 500 || typeof input.privateKey !== 'string') throw new Error();
    const key = createPrivateKey(input.privateKey);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    // The pinned CLI expects SEC1 PEM; accept CDP EC input and canonicalize in memory.
    return { name: input.name, privateKey: key.export({ type: 'sec1', format: 'pem' }).toString() };
  } catch { throw new CoinbaseError('invalid_key'); }
}
/** Path comes only from the desktop native chooser, never a renderer-supplied path. */
export async function readCoinbaseKeyFile(path: unknown): Promise<CoinbaseKey> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new CoinbaseError('invalid_key');
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16 * 1024) throw new Error();
      const bytes = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16 * 1024) throw new Error();
      return parseCoinbaseKey(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
  } catch { throw new CoinbaseError('invalid_key'); }
}
