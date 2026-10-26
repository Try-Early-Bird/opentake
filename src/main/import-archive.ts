import { gunzipSync } from 'node:zlib';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

// Accept the regular-file/directory tar format produced by PGlite. Reject links,
// traversal, extra header formats, malformed sizes, and decompression bombs.
export function validateArchive(input: Buffer): Blob {
  if (input.length > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds 64 MiB');
  const tar = gunzipSync(input, { maxOutputLength: MAX_EXPANDED_BYTES });
  let offset = 0;
  let hasVersion = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid archive trailer');
      break;
    }
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const segments = name.replace(/^\//, '').replace(/\/$/, '').split('/');
    if (segments.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Unsafe archive path');
    if (header[156] !== 48 && header[156] !== 53 && header[156] !== 0) throw new Error('Unsupported archive entry');
    const sizeText = header.subarray(124, 136).toString().replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid archive size');
    const size = parseInt(sizeText, 8);
    const checksum = parseInt(header.subarray(148, 156).toString().replace(/\0/g, '').trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual || size > MAX_EXPANDED_BYTES || offset + 512 + size > tar.length) throw new Error('Invalid archive');
    if (segments.join('/') === 'PG_VERSION' && header[156] !== 53) hasVersion = true;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!hasVersion || offset > tar.length) throw new Error('Not a PGlite database snapshot');
  return new Blob([tar]);
}
