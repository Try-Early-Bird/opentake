import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { waitForUpdateShutdown } from '../../src/main/update-shutdown';

it('requires both the matching flush receipt and process exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opentake-stop-update-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
  const exited = once(child, 'exit');
  try {
    await writeFile(join(root, 'update-shutdown.json'), JSON.stringify({ pid: child.pid, nonce: 'attempt' }));
    await expect(waitForUpdateShutdown(root, child.pid!, 'attempt', 150)).rejects.toThrow('did not exit');
    child.kill(); await exited;
    await expect(waitForUpdateShutdown(root, child.pid!, 'different')).rejects.toThrow('not confirmed');
    await expect(waitForUpdateShutdown(root, child.pid!, 'attempt')).resolves.toBeUndefined();
    await rm(join(root, 'update-shutdown.json'));
    await expect(waitForUpdateShutdown(root, child.pid!, 'attempt')).rejects.toThrow();
  } finally { child.kill(); await exited; await rm(root, { recursive: true, force: true }); }
});
