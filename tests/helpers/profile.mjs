import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function temporaryProfile() {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-test-'));
  return {
    root,
    database: join(root, 'database'),
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}
