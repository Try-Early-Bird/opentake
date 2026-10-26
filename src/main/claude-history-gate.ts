import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliCommand } from './ai-runtime';
import { claudeHistory, VERIFIED_CLAUDE_HISTORY_VERSIONS } from './claude-history';
import { atomicPrivateWrite } from './private-files';

// The Claude CLI updates itself, and its transcript envelope is internal, so a
// follow-up may only resume a transcript on a version known to replay it. A
// version not verified yet is checked once, on first use, by the same probe as
// tests/chat/compatibility/claude-history.cjs: the production transcript builder
// resumed against a loopback mock Messages API, with a synthetic key and a
// disposable HOME (never the member's profile, never the network). The result
// is remembered per version. A version that fails, or cannot be checked, does
// not block the take: its follow-ups carry the earlier conversation as quoted
// context instead of a resumed transcript (owner decision 2026-10-05).

export type ClaudeHistoryMode = { mode: 'transcript'; version: string } | { mode: 'flattened'; version: string | null; reason: string };
type Verdicts = Record<string, { ok: boolean; checkedAt: string }>;
const PROBE_MARKER = 'SYNTHETIC-RESULT-452';
const PROBE_MS = 25_000;

/** The installed CLI's version, read without loading the member's configuration. */
export async function claudeVersion(command: CliCommand, home: string): Promise<string | null> {
 const env: NodeJS.ProcessEnv = {}; for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
 Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ELECTRON_RUN_AS_NODE: '1' });
 const stdout = await new Promise<string>(resolve => execFile(command.executable, [...command.args, '--version'], { cwd: home, env, timeout: 10_000, maxBuffer: 10_000 }, (error, out) => resolve(error ? '' : out)));
 return stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

/**
 * Whether this CLI resumes the production transcript with roles and tool results
 * intact. Everything stays on this machine: a mock Messages API on 127.0.0.1, a
 * synthetic API key, a disposable HOME, no MCP servers and no tools.
 */
export async function probeClaudeHistory(command: CliCommand, scratch: string, version: string, launch = spawn): Promise<boolean> {
 await mkdir(scratch, { recursive: true, mode: 0o700 });
 const home = await mkdtemp(join(scratch, 'history-probe-'));
 const seen: { role: string; content: unknown }[][] = [];
 const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body || '{}') as { messages?: { role: string; content: unknown }[] };
  if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 50 })); return; }
  if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
  seen.push(parsed.messages ?? []);
  const message = { id: 'msg_probe', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [type, data] of [['message_start', { message }], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Probe complete.' } }],
   ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]] as const) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const base = { id: randomUUID(), parentId: null, images: [], createdAt: new Date().toISOString(), selection: { provider: 'claude' as const, model: 'default' }, state: 'completed' as const, tools: [] };
  const transcript = join(home, 'replay.jsonl');
  await writeFile(transcript, await claudeHistory([
   { ...base, role: 'user', text: 'Retrieve the synthetic marker.' },
   { ...base, role: 'assistant', text: 'I retrieved the marker.', replay: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_marker', name: 'mcp__opentake__marker', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_marker', content: PROBE_MARKER, is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I retrieved the marker.' }] }] },
  ], async () => '', home, version), { mode: 0o600 });
  const address = server.address(); if (!address || typeof address === 'string') return false;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
   ANTHROPIC_API_KEY: 'synthetic-local-probe', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' };
  const child = launch(command.executable, [...command.args, '-p', '--resume', transcript, '--fork-session', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
   '--setting-sources', '', '--system-prompt', 'Synthetic test', '--model', 'claude-sonnet-4-6', '--output-format', 'stream-json', '--verbose'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout?.on('data', chunk => { out += chunk; }); child.stderr?.on('data', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_MS);
  child.stdin?.end('Recall the marker without any tool calls.');
  const code = await new Promise<number | null>(resolve => { child.on('close', resolve); child.on('error', () => resolve(null)); });
  clearTimeout(timer);
  const replayed = seen.some(messages => messages.some(m => m.role === 'user' && Array.isArray(m.content)
   && (m.content as { type?: string; content?: unknown }[]).some(p => p.type === 'tool_result' && p.content === PROBE_MARKER)));
  const roles = seen[0]?.map(m => m.role).join(',') ?? '';
  return code === 0 && replayed && roles.startsWith('user,assistant,user,assistant') && out.includes('Probe complete.');
 } catch { return false; }
 finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}

/** Remembers per CLI version whether transcript replay works; checks a new version once. */
export function createClaudeHistoryGate(profile: string, probe = probeClaudeHistory, readVersion = claudeVersion) {
 const file = join(profile, 'claude-history-verification.json');
 const inFlight = new Map<string, Promise<boolean>>();
 const load = async (): Promise<Verdicts> => { try { return JSON.parse(await readFile(file, 'utf8')) as Verdicts; } catch { return {}; } };
 return {
  async mode(command: CliCommand, home: string): Promise<ClaudeHistoryMode> {
   const version = await readVersion(command, home);
   if (version === null) return { mode: 'flattened', version: null, reason: 'version_unreadable' };
   if (VERIFIED_CLAUDE_HISTORY_VERSIONS.includes(version)) return { mode: 'transcript', version };
   const known = (await load())[version];
   if (known) return known.ok ? { mode: 'transcript', version } : { mode: 'flattened', version, reason: 'replay_unverified' };
   let check = inFlight.get(version);
   if (!check) {
    check = probe(command, join(profile, 'chat-temporary'), version).catch(() => false).then(async ok => {
     const verdicts = await load(); verdicts[version] = { ok, checkedAt: new Date().toISOString() };
     await atomicPrivateWrite(file, Buffer.from(JSON.stringify(verdicts, null, 1)));
     return ok;
    }).finally(() => inFlight.delete(version));
    inFlight.set(version, check);
   }
   return (await check) ? { mode: 'transcript', version } : { mode: 'flattened', version, reason: 'replay_unverified' };
  },
 };
}
