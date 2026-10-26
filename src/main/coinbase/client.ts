import { assertCoinbaseReadContract, coinbaseReadTools, type CoinbaseChatRead } from './read-tools';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createVenueQueue } from '../venue-queue';
import type { CoinbaseKey } from './key';
import { CoinbaseError } from './errors';

export const COINBASE_CLI_VERSION = '0.0.10';
const allowed = ['coinbase_api_key_permissions', 'coinbase_portfolios_list', 'coinbase_portfolios_get'] as const;
export type CoinbaseRead = typeof allowed[number] | CoinbaseChatRead;
export interface CoinbaseSession { read(name: CoinbaseRead, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>; close(): Promise<void> }
export type CoinbaseSessionFactory = (key: CoinbaseKey, signal: AbortSignal) => Promise<CoinbaseSession>;
export function coinbaseChildEnvironment(home: string, key: CoinbaseKey, parent = process.env) {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (parent[name]) env[name] = parent[name]!;
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home, XDG_CACHE_HOME: home, COINBASE_CONFIG_DIR: home,
    COINBASE_ENV: 'live', COINBASE_TRANSPORT: 'brokerage', COINBASE_NO_HISTORY: '1',
    COINBASE_NO_UPDATE_CHECK: '1', COINBASE_KEY_ID: key.name, COINBASE_KEY_SECRET: key.privateKey,
    ELECTRON_RUN_AS_NODE: '1' };
}
export function createCoinbaseSessionFactory(root: string, runtime = process.execPath, testEntrypoint?: string): CoinbaseSessionFactory {
  return async (key, signal) => {
    signal.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(root, 'session-'));
    const client = new Client({ name: 'Earlybird-Opentake', version: '0.1.0' }, { capabilities: {} });
    const queue = createVenueQueue();
    let transport: StdioClientTransport | undefined;
    let closed = false;
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await client.close().catch(() => {}); await transport?.close().catch(() => {});
        await queue.close(); await rm(home, { recursive: true, force: true });
      })();
      return closing;
    };
    const abort = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // electron-builder unpacks this pinned package; no PATH/global CLI resolution.
      const require = createRequire(join(__dirname, 'coinbase-loader.cjs'));
      const manifest = require.resolve('@coinbase/coinbase-cli/package.json');
      const cli = testEntrypoint ?? join(dirname(manifest), 'dist/index.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      transport = new StdioClientTransport({ command: runtime, args: [cli, 'mcp'],
        env: coinbaseChildEnvironment(home, key), cwd: home, stderr: 'pipe', maxBufferSize: 1024 * 1024 });
      transport.stderr?.on('data', () => {}); // Do not retain provider stderr or secrets.
      await client.connect(transport, { timeout: 10_000, signal });
      if (client.getServerVersion()?.version !== COINBASE_CLI_VERSION) throw new CoinbaseError('contract');
      const catalog = await client.listTools({}, { timeout: 10_000, signal });
      if (catalog.nextCursor || catalog.tools.length > 100) throw new CoinbaseError('contract');
      for (const name of allowed) {
        const tool = catalog.tools.find(t => t.name === name);
        if (!tool || tool.inputSchema.type !== 'object' || tool.annotations?.readOnlyHint !== true) throw new CoinbaseError('contract');
        if (name === 'coinbase_portfolios_get' && (tool.inputSchema.properties?.portfolio_id as { type?: string })?.type !== 'string') throw new CoinbaseError('contract');
      }
      for (const tool of coinbaseReadTools) assertCoinbaseReadContract(tool.name, catalog.tools.find(t => t.name === tool.name));
      signal.throwIfAborted();
      return {
        read(name, args, callSignal) {
          if (!(allowed as readonly string[]).includes(name) && !coinbaseReadTools.some(t => t.name === name)) return Promise.reject(new CoinbaseError('contract'));
          return queue.submit(async queuedSignal => {
            if (coinbaseReadTools.some(t => t.name === name)) assertCoinbaseReadContract(name, catalog.tools.find(t => t.name === name));
            if (closed) throw new CoinbaseError('cancelled');
            const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined,
              { signal: AbortSignal.any([signal, callSignal, queuedSignal]), timeout: 15_000 }));
            if (result.isError) {
              const text = result.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
              throw new CoinbaseError(/HTTP (401|403)\b|AUTHENTICATION_FAILED|PERMISSION_INTROSPECTION_FORBIDDEN/.test(text) ? 'authentication' : 'provider');
            }
            const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
            if (text.length > 1024 * 1024) throw new CoinbaseError('provider');
            try { return JSON.parse(text) as unknown; } catch { throw new CoinbaseError('provider'); }
          }, 'sync', callSignal);
        },
        async close() { signal.removeEventListener('abort', abort); await close(); },
      };
    } catch (error) {
      signal.removeEventListener('abort', abort); await close();
      if (signal.aborted) throw new CoinbaseError('cancelled');
      throw error instanceof CoinbaseError ? error : new CoinbaseError('runtime');
    }
  };
}
