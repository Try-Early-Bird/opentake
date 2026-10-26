import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RobinhoodToolDefinition } from '../shared/connections';

const names = new Set([
  'get_accounts', 'get_trade_approvals', 'decline_trade_approval', 'search',
  'get_currency_pairs', 'get_crypto_quotes', 'get_crypto_positions',
  'get_crypto_orders', 'preview_crypto_order', 'place_crypto_order',
  'cancel_crypto_order', 'get_crypto_account_onboarding_info', 'get_crypto_tax_lots',
]);

/** Metadata only: never invokes a tool, including preview or placement. */
export async function listRobinhoodToolSchemas(client: Pick<Client, 'listTools'>, signal: AbortSignal): Promise<RobinhoodToolDefinition[]> {
  const tools: RobinhoodToolDefinition[] = [];
  const cursors = new Set<string>();
  const seenNames = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let page = 0; page < 20; page++) {
    signal.throwIfAborted();
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 20_000 });
    signal.throwIfAborted();
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > 4 * 1024 * 1024) throw new Error('Tool metadata too large');
    for (const tool of result.tools) {
      // Keep newly advertised crypto reads, including history tools, in the
      // metadata export. A fixed list must not be mistaken for server capability.
      // This does not register or invoke any additional tool.
      if (seenNames.has(tool.name)) throw new Error('Duplicate tool definition');
      seenNames.add(tool.name);
      tools.push({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: structuredClone(tool.inputSchema),
        ...(tool.annotations === undefined ? {} : {annotations: structuredClone(tool.annotations)}),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: structuredClone(tool.outputSchema) }) });
    }
    if (!result.nextCursor) return tools.sort((a, b) => a.name.localeCompare(b.name));
    if (cursors.has(result.nextCursor)) throw new Error('Repeated tool cursor');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Too many tool pages');
}

export async function listCryptoToolSchemas(client: Pick<Client, 'listTools'>, signal: AbortSignal): Promise<RobinhoodToolDefinition[]> {
  return (await listRobinhoodToolSchemas(client, signal)).filter(tool => names.has(tool.name) || /^(?:get|list)_crypto_/.test(tool.name));
}
