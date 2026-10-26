import { confinedGrok, grokEnvironment, checkGrokVersion } from './grok-runtime';
import { mkdtemp, mkdir, readFile, rm, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { resolveAiCli } from './ai-runtime';
import { spawn, type IPty } from 'node-pty';
import type { AiProvider, AiConnectionState } from '../shared/ai-connections';
import { validateAiCredential, validLoginUrl, type AiLoginFactory } from './ai-connections';

export function loginCommand(provider: AiProvider) {
  const command = resolveAiCli(provider);
  return { ...command, args: [...command.args, ...(provider === 'grok' ? ['--no-auto-update', 'login', '--device-auth'] : provider === 'claude' ? ['setup-token'] : ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'])] };
}
export function parseLoginOutput(provider: AiProvider, raw: string): Pick<AiConnectionState, 'verificationUrl' | 'userCode'> & { credential?: string } {
  const clean = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
  const urls = clean.match(/https:\/\/[^\s\x00-\x1f]+/g) ?? [];
  const verificationUrl = urls.find(url => validLoginUrl(provider, url));
  if (provider === 'claude') {
    const token = clean.match(/(sk-ant-oat01-[A-Za-z0-9_-]{40,})[\s\x00-\x1f]/)?.[1];
    return { verificationUrl, ...(token ? { credential: JSON.stringify({ version: 1, kind: 'oauth_token', token }) } : {}) };
  }
  if (provider === 'grok') {
    const code = clean.match(/(?:Confirm this code in your browser|Then enter this code):\s*\n\s*([A-Za-z0-9-]{4,32})(?=\s)/)?.[1];
    return { verificationUrl, userCode: code };
  }
  const userCode = clean.split('\n').filter(line => !line.includes('https://')).join('\n').match(/\b([A-Z0-9]{3,10}-[A-Z0-9]{3,10})\b/)?.[1];
  return { verificationUrl, userCode };
}
export function createLocalAiLogin(root: string, commandFor = loginCommand): AiLoginFactory {
  return async (provider, progress) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(root, 'login-'));
    await mkdir(join(home, '.codex'), { mode: 0o700 });
    await mkdir(join(home, '.claude'), { mode: 0o700 });
    if (provider === 'grok') await mkdir(join(home, '.grok'), { mode: 0o700 });
    let terminal: IPty;
    try {
      let command = commandFor(provider);
      if (provider === 'grok' && commandFor === loginCommand) {
        await checkGrokVersion(resolveAiCli('grok'), home);
        command = confinedGrok(command, home);
      }
      // No inherited model keys, proxy settings, or real CLI home/config paths.
      const env: Record<string, string> = {};
      for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP']) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
        CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
        TERM: 'xterm-256color', BROWSER: 'echo', ELECTRON_RUN_AS_NODE: '1', DISABLE_AUTOUPDATER: '1' });
      if (provider === 'grok') { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, grokEnvironment(home)); }
      env.PATH = dirname(command.executable) + (process.platform === 'win32' ? ';' : ':') + (env.PATH ?? '');
      terminal = spawn(command.executable, command.args, { name: 'xterm-256color', cols: 2000, rows: 50, cwd: home, env });
    } catch { await rm(home, { recursive: true, force: true }); throw new Error('AI login runtime unavailable'); }
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => {});
    let exited = false; let exitCode: number | undefined;
    let resolveExit!: () => void;
    const exit = new Promise<void>(yes => { resolveExit = yes; });
    let finishing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let submitTimer: ReturnType<typeof setTimeout> | undefined;
    let buffer = '';
    let previousProgress = '';
    async function finish(credential?: string) {
      if (finishing) return finishing;
      finishing = (async () => {
        clearTimeout(timer); clearTimeout(submitTimer); clearTimeout(deadline);
        if (!exited) {
          try { terminal.kill(); } catch { /* It may have exited already. */ }
          await Promise.race([exit, new Promise<void>(yes => setTimeout(yes, 1500))]);
        }
        buffer = '';
        try {
          await rm(home, { recursive: true, force: true });
          if (credential) { validateAiCredential(provider, credential); resolve(credential); }
          else reject(new Error('AI login ended'));
        } catch { reject(new Error('AI login cleanup failed')); }
      })();
      return finishing;
    }
    const deadline = setTimeout(() => { void finish(); }, 15 * 60_000);
    terminal.onData(data => {
      if (finishing) return;
      buffer = (buffer + data).slice(-64 * 1024);
      const parsed = parseLoginOutput(provider, buffer);
      if (parsed.credential) { void finish(parsed.credential); return; }
      const safe = { verificationUrl: parsed.verificationUrl, userCode: parsed.userCode };
      if (safe.verificationUrl && (provider === 'claude' || safe.userCode)) {
        const signature = JSON.stringify(safe);
        if (signature !== previousProgress) { previousProgress = signature; progress(safe); }
      }
    });
    async function poll() {
      if (finishing) return;
      if (provider === 'chatgpt' || (provider === 'grok' && exited && exitCode === 0)) {
        try {
          const file = join(home, provider === 'grok' ? '.grok' : '.codex', 'auth.json');
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('Invalid credential file');
          const credential = await readFile(file, 'utf8');
          validateAiCredential(provider, credential);
          await finish(credential); return;
        } catch { /* CLI may still be writing; only this isolated login directory is read. */ }
      }
      if (exited) { await finish(); return; }
      timer = setTimeout(() => { void poll(); }, 300);
    }
    terminal.onExit(event => { exited = true; exitCode = event.exitCode; resolveExit(); });
    void poll();
    return {
      done,
      submit(code) {
        if (provider !== 'claude' || finishing || exited || submitTimer) throw new Error('Login inactive or submitting');
        terminal.write(`${code}\r`);
        // Claude's Ink input can treat code + Enter as one paste. Match the
        // app-builder driver: allow the field to render, then press Enter again.
        submitTimer = setTimeout(() => {
          submitTimer = undefined;
          if (finishing || exited) return;
          try { terminal.write('\r'); } catch { void finish(); }
        }, 1000);
      },
      cancel: () => finish(),
    };
  };
}
