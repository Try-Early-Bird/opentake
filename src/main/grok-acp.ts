import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveAiCli, type CliCommand } from './ai-runtime';
import { atomicPrivateWrite } from './private-files';
import type { SecretStore } from './secret-store';
import { AdapterError, manageChild, nativeFailure, protocolError } from './native-chat-process';
import { checkGrokVersion, confinedGrok, grokEnvironment, grokSecretRef, validateGrokCredential } from './grok-runtime';

export interface GrokDependencies {
  launch?: typeof spawn; command?: () => CliCommand; version?: typeof checkGrokVersion;
  confine?: typeof confinedGrok; requestMs?: number;
}
// In 1.0.46, top-level --tools/--max-turns flags do not configure agent stdio.
// Enforce the toolset via session/new's agentProfile and permissions via config.
export const grokAgentProfile = {
  name: 'opentake', description: 'Opentake chat through its authorized MCP gateway',
  tools: ['search_tool', 'use_tool'], permissionMode: 'dontAsk', maxTurns: 20,
  discoverSkills: false, agentsMd: false, injectDefaultTools: false,
};
export const grokChatConfig = `[cli]
auto_update = false
[ui]
permission_mode = "dontAsk"
[permission]
rules = [
  { action = "allow", tool = "mcp", pattern = "opentake__*" },
  { action = "deny", tool = "read" },
  { action = "deny", tool = "edit" },
  { action = "deny", tool = "bash" }
]
[subagents]
enabled = false
[memory]
enabled = false
[memory_v2]
enabled = false
[managed_mcps]
enabled = false
[compat.claude]
mcps = false
[compat.cursor]
mcps = false
`;
export async function withGrok<T>(store: SecretStore, profile: string, signal: AbortSignal, deps: GrokDependencies,
  work: (home: string, command: CliCommand, credential: string, cli: { version: string | null; verified: boolean }) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const credential = await store.get(grokSecretRef);
  if (!credential) throw new AdapterError('Connect Grok in Settings.');
  const root = join(profile, 'grok-temporary'); await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, 'acp-'));
  let written = false;
  try {
    validateGrokCredential(credential);
    const command = (deps.command ?? (() => resolveAiCli('grok')))();
    const cli = await (deps.version ?? checkGrokVersion)(command, home) ?? { version: null, verified: false };
    signal.throwIfAborted();
    await mkdir(join(home, '.grok'), { mode: 0o700, recursive: true });
    await atomicPrivateWrite(join(home, '.grok', 'auth.json'), Buffer.from(credential)); written = true;
    await atomicPrivateWrite(join(home, '.grok', 'config.toml'), Buffer.from(grokChatConfig));
    return await work(home, (deps.confine ?? confinedGrok)(command, home, true), credential, cli);
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason : new AdapterError('Response stopped.');
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('Grok could not complete the request. Check sign-in and that the Grok CLI is installed. No automatic retry was made.');
  } finally {
    try {
      // The caller must reap its process before returning. Only read the private
      // app-owned copy, and never resurrect a concurrently disconnected account.
      if (written) {
        const path = join(home, '.grok', 'auth.json'), stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid state');
        const updated = await readFile(path, 'utf8'); validateGrokCredential(updated);
        const before = Object.entries(JSON.parse(credential))[0] as [string, { user_id: string }];
        const after = Object.entries(JSON.parse(updated))[0] as [string, { user_id: string }];
        if (before[0] !== after[0] || (before[1].user_id && before[1].user_id !== after[1].user_id)) throw new Error('Account changed');
        if (updated !== credential && (!store.compareAndSet || !await store.compareAndSet(grokSecretRef, credential, updated))) throw new Error('Connection changed');
      }
    } catch { throw new AdapterError('Could not save Grok sign-in state. Reconnect Grok before the next response.'); }
    finally { await rm(home, { recursive: true, force: true }); }
  }
}
const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
type Event = z.infer<typeof envelope>;
export function grokAcp(home: string, command: CliCommand, signal: AbortSignal, deps: GrokDependencies,
  onEvent: (event: Event, respond: (result: unknown) => void) => Promise<void>) {
  const child = (deps.launch ?? spawn)(command.executable, [...command.args, '--no-auto-update', 'agent', 'stdio'],
    { cwd: home, env: grokEnvironment(home), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  // Register cancellation before manageChild's kill listener, to send ACP cancel first.
  let sessionId = '', failure: Error | undefined, sequence = 0, buffer = '', bytes = 0, closing = false;
  let queue = Promise.resolve(); const work = new Set<Promise<void>>();
  const seen = new Set<string>();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const send = (value: unknown) => { if (failure || closing) throw failure ?? new AdapterError('Grok request ended.'); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...value as object }) + '\n'); };
  const abort = () => { if (sessionId && !failure) try { send({ method: 'session/cancel', params: { sessionId } }); } catch {} fail(new AdapterError('Response stopped.')); };
  signal.addEventListener('abort', abort, { once: true });
  const state = manageChild(child, signal);
  const fail = (error: Error) => {
    if (failure) return; failure = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); state.stop();
  };
  const consume = async (event: Event) => {
    if (failure || closing) return;
    if (event.method) {
      if (event.id !== undefined) {
        const key = typeof event.id + ':' + event.id;
        if (seen.has(key) || seen.size >= 1000) throw protocolError('Grok'); seen.add(key);
        // Reverse MCP requests may wait for user approval. Keep reading cancel,
        // notifications and other RPC replies while the gateway is pending.
        const task = onEvent(event, result => send({ id: event.id, result })).catch(error => fail(error instanceof AdapterError ? error : protocolError('Grok')));
        work.add(task); void task.finally(() => work.delete(task));
      } else await onEvent(event, () => { throw protocolError('Grok'); });
      return;
    }
    if (typeof event.id !== 'number') throw protocolError('Grok');
    const p = pending.get(event.id); if (!p) throw protocolError('Grok');
    pending.delete(event.id); clearTimeout(p.timer);
    if (event.error) { const error = nativeFailure('Grok', event.error); p.reject(error); fail(error); }
    else p.resolve(event.result);
  };
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { fail(new AdapterError('Grok response exceeded its output limit.')); return; }
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
      queue = queue.then(() => consume(envelope.parse(JSON.parse(line)))).catch(error => fail(error instanceof AdapterError ? error : protocolError('Grok')));
    }
  });
  child.once('error', () => fail(new AdapterError('Could not start Grok. Check the installed CLI.')));
  void state.done.then(async () => { await queue; if (!closing) fail(new AdapterError('Grok exited before completing the request.')); });
  return {
    session(id: string) { sessionId = id; },
    request(method: string, params: unknown, timeout = deps.requestMs ?? 30000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (failure || signal.aborted || closing) { reject(failure ?? new AdapterError('Response stopped.')); return; }
        const id = ++sequence, timer = setTimeout(() => fail(new AdapterError('Grok request timed out. No automatic retry was made.')), timeout);
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
      });
    },
    async drain() { await queue; if (failure) throw failure; if (work.size) throw protocolError('Grok'); },
    async close() {
      closing = true; signal.removeEventListener('abort', abort);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new AdapterError('Grok request ended.')); } pending.clear();
      await state.close(); await queue; await Promise.allSettled([...work]);
    },
  };
}
export const grokInitialize = { protocolVersion: 1, clientInfo: { name: 'opentake', version: '0.1.0' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
export function grokInit(value: unknown) {
  const init = z.object({ protocolVersion: z.literal(1), authMethods: z.array(z.object({ id: z.string() })),
    // The CLI updates itself, so require the capabilities used rather than one version.
    _meta: z.object({ agentVersion: z.string(), 'x.ai/mcp/sdk': z.literal(true) }).passthrough() }).parse(value);
  if (!init.authMethods.some(m => m.id === 'cached_token')) throw new AdapterError('Reconnect Grok in Settings. A saved Grok session is required.');
  return init;
}
