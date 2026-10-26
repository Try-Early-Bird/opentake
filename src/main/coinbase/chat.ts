import type { createDatabaseLifecycle } from '../database';
import type { ConnectionSummary } from '../../shared/connections';
import type { CoinbaseChatScope } from '../../shared/platform-connections';
import type { createCoinbaseConnections } from './connections';

/** Resolve the run's captured account set; model references cannot widen it. */
export function createCoinbaseChat(database: Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>, connections: Pick<ReturnType<typeof createCoinbaseConnections>, 'assertChatScope' | 'readChat'>) {
  async function scopes(run?: string): Promise<CoinbaseChatScope[]> {
    if (!run) return [];
    const config = (await database.use(db => db.query<{ configuration: { coinbaseAccounts?: CoinbaseChatScope[]; coinbaseAccount?: CoinbaseChatScope } }>('SELECT configuration FROM take_runs WHERE id=$1', [run]))).rows[0]?.configuration;
    const values = config?.coinbaseAccounts ?? (config?.coinbaseAccount ? [config.coinbaseAccount] : []);
    for (const value of values) await connections.assertChatScope(value);
    return values;
  }
  async function scope(run?:string) { const values=await scopes(run); return values.length===1?values[0]:null; }
  return {
    scope, scopes,
    async status(run?: string): Promise<ConnectionSummary> {
      const available = await scopes(run);
      return { status: available.length ? 'connected' : 'disconnected', checkedAt: null, accounts: available.map(account=>({ id: account.accountRef, maskedNumber: '', nickname: account.label, accountType: 'coinbase_portfolio', agenticAllowed: true, selected: available.length===1 })) };
    },
    async read(run: string | undefined, name: string, args: Record<string, unknown>, accountRef?: string, signal?: AbortSignal) {
      const selected = (await scopes(run)).find(account=>account.accountRef===accountRef);
      if (!selected || accountRef !== selected.accountRef) throw new Error('Use an available Coinbase accountRef from opentake_list_accounts; clarify the account with the member if ambiguous.');
      return connections.readChat(selected, name, args, signal);
    },
  };
}
