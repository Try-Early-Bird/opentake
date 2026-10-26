import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants, accessSync, statSync } from 'node:fs';
import type { CliCommand } from './ai-runtime';
import { delimiter, join, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export async function detectOpenCode(): Promise<{ installed: boolean; version?: string }> {
  const home = homedir();
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(home, '.opencode', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of [...new Set(dirs)].filter(isAbsolute)) {
    const file = join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    try { await access(file, constants.X_OK); } catch { continue; }
    const isolated = await mkdtemp(join(tmpdir(), 'opentake-version-'));
    try {
      const version = await new Promise<string>((resolve, reject) => {
        execFile(file, ['--version'], { timeout: 2500, maxBuffer: 4096, cwd: isolated,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: isolated, USERPROFILE: isolated, XDG_CONFIG_HOME: isolated, XDG_DATA_HOME: isolated, XDG_CACHE_HOME: isolated, DISABLE_AUTOUPDATER: '1' } },
        (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
      });
      if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return { installed: true, version };
    } catch { /* Try the next conventional installation path. */ }
    finally { await rm(isolated, { recursive: true, force: true }); }
  }
  return { installed: false };
}

export function resolveOpenCode(env=process.env, home=homedir()): CliCommand {
  const dirs=[...(env.PATH??'').split(delimiter),join(home,'.opencode','bin'),join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin'];
  if(env.APPDATA)dirs.push(join(env.APPDATA,'npm'));
  for(const dir of [...new Set(dirs)].filter(isAbsolute)) {
    const executable=join(dir,process.platform==='win32'?'opencode.exe':'opencode');
    try { accessSync(executable,constants.X_OK);if(statSync(executable).isFile())return {executable,args:[]}; } catch { /* Try next installed executable. */ }
  }
  throw new Error('OpenCode CLI is not installed.');
}
