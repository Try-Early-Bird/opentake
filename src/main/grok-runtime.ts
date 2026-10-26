import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { CliCommand } from './ai-runtime';

export const grokSecretRef = 'ai:subscription:v1:grok';
export const grokVersion = '1.0.46';
export function validGrokUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      ['auth.x.ai', 'accounts.x.ai'].includes(url.hostname) && /^\/[A-Za-z0-9/_-]{0,120}$/.test(url.pathname) &&
      [...url.searchParams].every(([key, val]) => key === 'user_code' && /^[A-Za-z0-9-]{4,32}$/.test(val));
  } catch { return false; }
}
// Public xai-org/grok-build GrokAuth/AuthStore schema. Never parse a real user's
// CLI profile: callers supply only app-owned temporary files or synthetic tests.
export function validateGrokCredential(credential: string): void {
  if (Buffer.byteLength(credential) > 16 * 1024) throw new Error('Invalid Grok credential');
  const parsed: unknown = JSON.parse(credential);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Grok credential');
  const entries = Object.entries(parsed);
  if (entries.length !== 1) throw new Error('Invalid Grok credential');
  const [scope, auth] = entries[0] as [string, Record<string, unknown>];
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) ||
    !/^https:\/\/auth\.x\.ai::[A-Za-z0-9._-]{1,200}$/.test(scope) || auth.auth_mode !== 'oidc' ||
    auth.oidc_issuer !== 'https://auth.x.ai' || typeof auth.oidc_client_id !== 'string' ||
    scope !== 'https://auth.x.ai::' + auth.oidc_client_id ||
    typeof auth.key !== 'string' || !auth.key ||
    (auth.refresh_token != null && (typeof auth.refresh_token !== 'string' || !auth.refresh_token)) ||
    typeof auth.user_id !== 'string' || typeof auth.create_time !== 'string' ||
    !Number.isFinite(Date.parse(auth.create_time))) throw new Error('Invalid Grok credential');
}
export function grokEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, GROK_HOME: join(home, '.grok'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: home, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', BROWSER: '/usr/bin/false' };
}
export function confinedGrok(command: CliCommand, home: string, model = false): CliCommand {
  if (process.platform !== 'darwin') throw new Error('Grok connection testing currently requires macOS.');
  const binary = realpathSync(command.executable), directory = realpathSync(home);
  const policy = ['(version 1)', '(allow default)',
    '(deny file-read* file-write* (subpath "/Users") (subpath "/var/root") (subpath "/private/var/root") (subpath "/etc/grok") (subpath "/private/etc/grok"))',
    `(allow file-read* file-write* (subpath ${JSON.stringify(directory)}))`,
    `(allow file-read* (literal ${JSON.stringify(binary)}))`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/security"))',
    ...(model ? ['(deny process-exec)', `(allow process-exec (literal ${JSON.stringify(binary)}))`] : []),
  ].join('\n');
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', policy, binary, ...command.args] };
}
/**
 * Confirms the confined Grok runtime starts and reports its version. A version other
 * than the one verified (grokVersion) no longer refuses: the CLI updates itself, and the
 * sandbox policy still fails closed if a newer CLI needs anything it does not allow.
 */
export async function checkGrokVersion(command: CliCommand, home: string): Promise<{ version: string | null; verified: boolean }> {
  const confined = confinedGrok(command, home);
  const output = await new Promise<string>((resolve, reject) => execFile(confined.executable, [...confined.args, '--version'],
    { cwd: home, env: grokEnvironment(home), timeout: 10000, maxBuffer: 4096 },
    (error, stdout) => error ? reject(new Error('Grok runtime unavailable')) : resolve(stdout.trim())));
  const version = output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  return { version, verified: version === grokVersion };
}
