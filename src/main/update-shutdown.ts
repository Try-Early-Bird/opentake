import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostCall, type HostManifest } from './host-rpc';

export async function stopHostForUpdate(profile: string, host: HostManifest, clientId: string) {
  const nonce = randomUUID();
  await hostCall(host, 'host:prepare-update', [nonce], clientId, 5000);
  await waitForUpdateShutdown(profile, host.pid, nonce);
}

export async function waitForUpdateShutdown(profile: string, pid: number, nonce: string, timeout = 30_000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid background host PID');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let exited = false;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') exited = true; else throw error; }
    if (exited) {
      const receipt = JSON.parse(await readFile(join(profile, 'update-shutdown.json'), 'utf8'));
      if (receipt.nonce !== nonce || receipt.pid !== pid) throw new Error('Database shutdown was not confirmed');
      return;
    }
    await delay(100);
  }
  throw new Error('Background host did not exit. Update postponed.');
}
