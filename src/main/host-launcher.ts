import { clearStartupFailure, startupFailureMessage } from './host-startup';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import { hostCall, readHostManifest, type HostManifest } from './host-rpc';
import { existingHostResponds, processRunning } from './host-liveness';

export async function ensureHost(profile: string, build: string): Promise<HostManifest> {
  const clientId = randomUUID();
  const existing = await readHostManifest(profile);
  if (existing) {
    const live = await existingHostResponds({
      ping: () => hostCall(existing, 'host:status', [], clientId, 1000),
      running: () => processRunning(existing.pid),
    });
    if (live && existing.build === build) return existing;
    if (live) {
      // The server may close before its acknowledgement reaches the desktop;
      // actual exit and unpublishing below are the replacement barrier.
      await hostCall(existing, 'host:shutdown', [], clientId, 2000).catch(() => {});
      for (let attempt = 0; attempt < 120; attempt++) {
        const exited = !processRunning(existing.pid);
        if (!(await readHostManifest(profile)) && exited) break;
        if (attempt === 119) throw new Error('host_shutdown_timeout');
        await delay(100);
      }
    }
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--earlybird-host', `--user-data-dir=${profile}`];
  if (app.commandLine.hasSwitch('earlybird-test-no-secrets')) args.push('--earlybird-test-no-secrets');
  if (app.commandLine.hasSwitch('no-sandbox')) args.push('--no-sandbox');
  await clearStartupFailure(profile);
  // Development builds keep the host's own output, so a host that dies without a
  // diagnostic event (a native or WebAssembly abort) leaves a trace. Packaged builds stay silent.
  let output: number | 'ignore' = 'ignore';
  if (!app.isPackaged) {
    try { mkdirSync(join(profile, 'logs', 'host'), { recursive: true, mode: 0o700 }); output = openSync(join(profile, 'logs', 'host', 'process.log'), 'a', 0o600); }
    catch { output = 'ignore'; }
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', output, output], env });
  if (typeof output === 'number') closeSync(output);
  let failureCode: string | undefined;
  child.on('exit', code => { failureCode = code === 0 ? 'host_already_running' : 'host_exited'; });
  child.on('error', () => { failureCode = 'host_launch_failed'; }); child.unref();
  // A schema upgrade stages and validates a copy before activating it.
  for (let attempt = 0; attempt < 1200; attempt++) {
    const failure = await startupFailureMessage(profile);
    if (failure) throw new Error(failure);
    const host = await readHostManifest(profile);
    if (host?.build === build) {
      try { await hostCall(host, 'host:status', [], clientId, 500); return host; } catch { /* Starting. */ }
    }
    // A second launcher can lose the singleton lock while the first host is
    // still initializing. Give that owner a short chance to publish its RPC.
    if (failureCode && (failureCode !== 'host_already_running' || attempt >= 100)) break;
    await delay(100);
  }
  throw new Error(await startupFailureMessage(profile) ?? failureCode ?? 'host_startup_timeout');
}
