// Crash leftovers in per-run CLI homes are cleared at host start. Disposable directories only.
import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepTemporaryRoots, temporaryRoots } from '../../src/main/temporary-files';

test('every temporary root is removed with its contents; other profile files and symlink targets survive', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-sweep-'));
  const outside = await mkdtemp(join(tmpdir(), 'opentake-sweep-target-'));
  try {
    for (const name of temporaryRoots) { await mkdir(join(profile, name, 'turn-x', '.codex'), { recursive: true }); await writeFile(join(profile, name, 'turn-x', '.codex', 'auth.json'), '{"synthetic":true}'); }
    await writeFile(join(outside, 'keep'), 'x');
    await symlink(outside, join(profile, 'chat-temporary', 'turn-x', 'link'));
    await mkdir(join(profile, 'database')); await writeFile(join(profile, 'host.json'), '{}');
    sweepTemporaryRoots(profile);
    expect((await readdir(profile)).sort()).toEqual(['database', 'host.json']);
    expect((await stat(join(outside, 'keep'))).isFile()).toBe(true);
    sweepTemporaryRoots(profile);
  } finally { await rm(profile, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
