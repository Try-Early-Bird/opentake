import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { AiProvider } from '../shared/ai-connections';

export interface CliCommand { executable: string; args: string[] }
// Resolve executables only. Never load the user's CLI config or authentication.
export function resolveAiCli(provider: AiProvider, env = process.env, home = homedir()): CliCommand {
  if (provider === 'grok' && process.platform !== 'darwin') throw new Error('Grok connection testing currently requires macOS.');
  const name = ({ claude: 'claude', chatgpt: 'codex', grok: 'grok' } as const)[provider];
  const dirs = [...(env.PATH ?? '').split(delimiter), join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (provider === 'grok') dirs.unshift(join(home, '.grok', 'bin'));
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
  if (env.NVM_BIN) dirs.push(env.NVM_BIN);
  const nvm = join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node');
  try { for (const version of readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) dirs.push(join(nvm, version, 'bin')); } catch { /* Optional installation manager. */ }
  for (const dir of [...new Set(dirs)].filter(isAbsolute)) {
    const file = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return { executable: file, args: [] }; } catch { /* Try another installation. */ }
    // npm's Windows .cmd wrappers require a shell. Invoke their installed JS entry directly instead.
    if (process.platform === 'win32' && provider !== 'grok') {
      const native = join(dir, 'node_modules', provider === 'claude' ? '@anthropic-ai/claude-code/bin/claude.exe' : '@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe');
      try { if (statSync(native).isFile()) return { executable: native, args: [] }; } catch { /* Try the npm JS entry. */ }
      const script = join(dir, 'node_modules', provider === 'claude' ? '@anthropic-ai/claude-code/cli.js' : '@openai/codex/bin/codex.js');
      try { if (statSync(script).isFile()) return { executable: process.execPath, args: [script] }; } catch { /* Optional npm installation. */ }
    }
  }
  throw new Error(`${provider === 'grok' ? 'Grok' : provider === 'claude' ? 'Claude Code' : 'Codex'} CLI is not installed.`);
}
export function aiCliInstalled(provider: AiProvider): boolean {
  try { resolveAiCli(provider); return true; } catch { return false; }
}
