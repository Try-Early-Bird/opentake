/** Opentake's own tool server; its tools get plain-language approval text. */
export const builtinToolServer = '00000000-0000-4000-8000-000000000001';
export interface ApprovalSubject { tool_name: string; server_id: string; server_name?: string | null; input?: unknown }
/** A tool access request's input, tolerating a stored JSON string. */
export function requested(item: ApprovalSubject): { serverId?: string; name?: string; policy?: string; reason?: string } {
  try { return (typeof item.input === 'string' ? JSON.parse(item.input) : item.input ?? {}) as ReturnType<typeof requested>; } catch { return {}; }
}
/** What an approval asks, in the member's terms. The approval panel and its notification share it. */
export function approvalCopy(item: ApprovalSubject): { title: string; description: string } {
  const action = item.tool_name.replaceAll('_', ' ');
  if (item.server_id !== builtinToolServer) return { title: `Allow ${item.server_name || 'this server'} to ${action}?`, description: '' };
  if (item.tool_name === 'robinhood_get_portfolio') return { title: 'Allow Robinhood portfolio access?', description: 'Read your connected account’s balances and buying power.' };
  if (item.tool_name === 'robinhood_get_crypto_positions') return { title: 'Read your Robinhood crypto positions?', description: 'Read the requested data from Robinhood.' };
  if (item.tool_name === 'robinhood_get_crypto_orders') return { title: 'Read your Robinhood crypto order history?', description: 'Read the requested data from Robinhood.' };
  if (item.tool_name === 'opentake_connection_status') return { title: 'Check your platform connections?', description: 'Check which accounts are connected and which features they support.' };
  if (item.tool_name === 'opentake_list_accounts') return { title: 'List your connected accounts?', description: 'Read the list of connected accounts and the features each supports.' };
  if (item.tool_name === 'opentake_request_tool_access') {
    // The member is deciding a permission: name the tool, the setting and chat's stated reason.
    const request = requested(item);
    const tool = (request.name ?? 'a tool').replaceAll('_', ' ');
    return { title: `Turn on ${tool}?`, description: `${request.policy === 'allowed' ? 'Chat can use it without asking' : 'Chat asks you before each use'}, from its next response. You can change this in Settings → MCP.${request.reason ? ` Chat’s reason: ${request.reason}` : ''}` };
  }
  if (item.tool_name === 'opentake_propose_strategy') return { title: 'Save a proposed Take revision?', description: 'Saves a draft for you to review. Nothing is committed or traded.' };
  if (item.tool_name === 'opentake_propose_rules') return { title: 'Save proposed rule changes?', description: 'Saves a proposal for you to review in Rules. Nothing changes until you accept it.' };
  if (item.tool_name.startsWith('opentake_')) return { title: `Allow ${action.replace(/^opentake /, 'Opentake ')}?`, description: 'Use your Opentake data for this request.' };
  if (item.tool_name.startsWith('coinbase_')) return { title: `Allow ${action.replace(/^coinbase /, 'Coinbase ')}?`, description: 'Read the requested data from Coinbase.' };
  if (item.tool_name.startsWith('robinhood_')) return { title: `Allow ${action.replace(/^robinhood get /, 'Robinhood ').replace(/^robinhood /, 'Robinhood ')}?`, description: 'Read the requested data from Robinhood.' };
  return { title: `Allow ${action}?`, description: '' };
}
