#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { hostCall, type HostManifest } from '../host-rpc';
import { toolCatalog } from './catalog';

async function main() {
  if (process.argv.includes('--list-tools')) {
    process.stdout.write(`${JSON.stringify(toolCatalog(), null, 2)}\n`); return;
  }
  const runIndex = process.argv.indexOf('--run');
  const run = runIndex >= 0 ? process.argv[runIndex + 1] : undefined;
  const port = Number(process.env.OPENTAKE_GATEWAY_PORT);
  const token = process.env.OPENTAKE_GATEWAY_TOKEN ?? '';
  delete process.env.OPENTAKE_GATEWAY_TOKEN;
  if (!run || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Active run gateway required.');
  const host: HostManifest = { port, token, protocol: 1, pid: 0, build: 'run-gateway' };
  const clientId = randomUUID();
  const server = new Server({ name: 'earlybird-opentake-mcp', version: '0.1.0' }, { capabilities: { tools: {} },
    instructions: await hostCall<string>(host, 'gateway:instructions', [run], clientId) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await hostCall(host, 'gateway:list', [run], clientId) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return await hostCall<CallToolResult>(host, 'gateway:call', [run, request.params.name, request.params.arguments ?? {}], clientId, 210_000);
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Opentake host unavailable or busy. Open Opentake and check its connection status.' }] };
    }
  });
  await server.connect(new StdioServerTransport());
  const close = () => { void server.close().finally(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
void main().catch(() => { process.stderr.write('Could not start earlybird-opentake-mcp. Start a take in Opentake to create an authorized gateway.\n'); process.exitCode = 1; });
