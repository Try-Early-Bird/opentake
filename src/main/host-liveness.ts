import { setTimeout as delay } from 'node:timers/promises';

export function processRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid background host PID');
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // Permission errors do not prove that a process exited.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

// A slow status request is not proof that the host is dead. In particular,
// synchronous OS-storage prompts can hold up Electron's main loop.
export async function existingHostResponds(deps: {
  ping: () => Promise<unknown>;
  running: () => boolean;
  wait?: () => Promise<void>;
}, attempts = 12): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await deps.ping(); return true; }
    catch {
      if (!deps.running()) return false;
      if (attempt + 1 < attempts) await (deps.wait?.() ?? delay(250));
    }
  }
  // Do not spawn a competing host or signal a PID taken from old metadata.
  throw new Error('host_unresponsive');
}
