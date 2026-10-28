import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretStore } from './secret-store';
import type { GrokAccessResult } from '../shared/ai-connections';
import { resolveAiCli } from './ai-runtime';
import { atomicPrivateWrite, privateDirectory } from './private-files';
import { manageChild } from './native-chat-process';
import { confinedGrok, grokEnvironment, grokSecretRef, validateGrokCredential, checkGrokVersion } from './grok-runtime';

export const grokAccessArgs = ['--no-auto-update', '--tools', '', '--no-plan', '--no-subagents', '--no-memory',
  '--disable-web-search', '--permission-mode', 'dontAsk', '--max-turns', '1', '--output-format', 'plain',
  '-p', 'Reply with exactly EARLYBIRD_GROK_OK. Do not use any tools.'];
const failed = (message: string): GrokAccessResult => ({ ok: false, message });
export function grokAccessOutcome(code: number | null, stdout: string, stderr: string): GrokAccessResult {
  if (code === 0 && stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim() === 'EARLYBIRD_GROK_OK') {
    return { ok: true, message: 'Connection verified. Grok responded successfully.' };
  }
  const raw = stderr + '\n' + stdout;
  if (/\b402\b|payment.required|insufficient.credits|subscription.required/i.test(raw)) return failed('Grok reported a billing or credit restriction. No plan was purchased.');
  if (/\b401\b|unauthorized|not.authenticated/i.test(raw)) return failed('Grok did not accept this session. Reconnect and retry.');
  if (/\b403\b|forbidden|access.denied/i.test(raw)) return failed('Grok reported an access denial. This does not identify a specific plan requirement.');
  if (/\b429\b|rate.limit|quota.exceeded/i.test(raw)) return failed('Grok reported a rate or quota limit.');
  return failed('The expected Grok reply was not verified. This is inconclusive; it does not prove a plan is required.');
}
interface Dependencies {
  launch?: typeof spawn;
  command?: typeof resolveAiCli;
  confine?: typeof confinedGrok;
  version?: typeof checkGrokVersion;
  deadlineMs?: number;
}
export function createGrokAccess(store: SecretStore, root: string, deps: Dependencies = {}) {
  let active: { abort: AbortController; done: Promise<GrokAccessResult> } | undefined;
  let closed = false;
  async function run(abort: AbortController): Promise<GrokAccessResult> {
    let home: string | undefined, credential: string | null = null;
    try {
      if (!store.available()) return failed('Sign in to Grok again to keep using it.');
      credential = await store.get(grokSecretRef);
      if (!credential) return failed('Connect Grok first.');
      validateGrokCredential(credential);
      await privateDirectory(root); home = await mkdtemp(join(root, 'grok-'));
      await mkdir(join(home, '.grok'), { mode: 0o700 });
      const command = (deps.command ?? resolveAiCli)('grok');
      await (deps.version ?? checkGrokVersion)(command, home);
      abort.signal.throwIfAborted();
      const authFile = join(home, '.grok', 'auth.json');
      await atomicPrivateWrite(authFile, Buffer.from(credential));
      const confined = (deps.confine ?? confinedGrok)(command, home, true);
      const child = (deps.launch ?? spawn)(confined.executable, [...confined.args, ...grokAccessArgs],
        { cwd: home, env: grokEnvironment(home), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const lifecycle = manageChild(child, abort.signal);
      let stdout = '', stderr = '', bytes = 0, code: number | null = null, overflow = false, launchFailed = false;
      const timer = setTimeout(() => abort.abort(), deps.deadlineMs ?? 60000);
      const consume = (stream: 'stdout' | 'stderr', data: string) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 64 * 1024) { overflow = true; abort.abort(); return; }
        if (abort.signal.aborted) return;
        if (stream === 'stdout') stdout += data; else stderr += data;
      };
      child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', data => consume('stdout', data));
      child.stderr!.on('data', data => consume('stderr', data));
      child.once('error', () => { launchFailed = true; });
      child.once('close', value => { code = value; });
      await lifecycle.done;
      clearTimeout(timer);
      const result = overflow ? failed('Grok exceeded the test output limit.')
        : abort.signal.aborted ? failed('Grok access test stopped or timed out.')
        : launchFailed ? failed('Could not start the Grok access test.') : grokAccessOutcome(code, stdout, stderr);
      stdout = ''; stderr = '';
      // The CLI may rotate its token. Only its app-owned temporary file is read,
      // after exit; CAS prevents disconnect/reconnect from resurrecting an old login.
      const stat = await lstat(authFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('Invalid refreshed credential');
      const refreshed = await readFile(authFile, 'utf8');
      validateGrokCredential(refreshed);
      if (refreshed !== credential) {
        if (!store.compareAndSet || !await store.compareAndSet(grokSecretRef, credential, refreshed)) {
          return failed('The Grok connection changed during the test. Reconnect before testing again.');
        }
      }
      return result;
    } catch {
      return failed('Grok access could not be verified. Check that Grok CLI 1.0.46 is installed, or sign in to Grok again.');
    } finally {
      credential = null;
      if (home) await rm(home, { recursive: true, force: true });
    }
  }
  return {
    test(): Promise<GrokAccessResult> {
      if (closed || active) return Promise.resolve(failed('A Grok test is already running or the app is closing.'));
      const abort = new AbortController();
      const entry = { abort, done: Promise.resolve({ ok: false, message: '' }) as Promise<GrokAccessResult> };
      active = entry;
      entry.done = run(abort).catch(() => failed('Grok test cleanup failed. Restart the app before retrying.')).finally(() => { if (active === entry) active = undefined; });
      return entry.done;
    },
    async cancel() { const entry = active; entry?.abort.abort(); await entry?.done; },
    async close() { closed = true; const entry = active; entry?.abort.abort(); await entry?.done; },
  };
}
