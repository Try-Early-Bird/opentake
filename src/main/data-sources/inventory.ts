import {readCoinbaseAccountConfig} from '../../shared/coinbase-field-mappings';
import {investmentVenueIds} from '../../shared/investment-venues';
import type { createDatabaseLifecycle } from '../database';
import type { DataSourceInventory, ManagedDataFeed, ManagedDataSource } from '../../shared/data-sources';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
type FeedRow = { resource: string; state: string; updated_at: Date | null };
const labels: Record<string, [string, string]> = {
  portfolio: ['Account balance and holdings', 'Saved portfolio observations used by account and Take views.'],
  equity_positions: ['Stock holdings', 'Saved equity positions and their observed values.'],
  option_positions: ['Option holdings', 'Saved option positions and their observed values.'],
  crypto_positions: ['Crypto holdings', 'Saved cryptocurrency positions and their observed values.'],
  equity_orders: ['Stock orders', 'Order status and execution records.'],
  option_orders: ['Option orders', 'Order status and execution records.'],
  crypto_orders: ['Crypto orders', 'Order status and execution records.'],
  spot_orders: ['Spot orders', 'Coinbase spot order status and activity.'],
  spot_fills: ['Spot fills', 'Coinbase spot execution records.'],
};
const states = new Set(['running', 'completed', 'failed', 'interrupted', 'partial']);
function feed(row: FeedRow): ManagedDataFeed {
  const [name, description] = labels[row.resource];
  return { id: row.resource, name, description,
    state: states.has(row.state) ? row.state as ManagedDataFeed['state'] : 'waiting',
    lastUpdatedAt: row.updated_at?.toISOString() ?? null };
}

/** Read only. Never calls provider adapters, refreshes credentials, or starts collection. */
export function createDataSourceInventory(database: Database) {
  return async (): Promise<DataSourceInventory> => database.use(async db => {
    const accounts = (await db.query<{id: string; venue: ManagedDataSource['venue']; label: string; connected: boolean}>(`
      SELECT a.id,c.venue,coalesce(cd.label,a.nickname,a.masked_number) AS label,
        (c.status='connected' AND a.available) AS connected
      FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
      JOIN local_owners o ON o.id=c.owner_id
      LEFT JOIN coinbase_connection_details cd ON cd.connection_id=c.id
      WHERE c.venue=ANY($1::text[]) AND c.status<>'disconnected'
      ORDER BY c.venue,a.id LIMIT 128`,[investmentVenueIds])).rows;
    const sources: ManagedDataSource[] = [];
    for (const account of accounts) {
      let rows: FeedRow[];
      if (account.venue === 'coinbase') {
        rows = (await db.query<FeedRow>(`
          SELECT 'portfolio' AS resource,coalesce(s.state,'waiting') AS state,
            (SELECT max(observed_at) FROM coinbase_portfolio_observations WHERE account_id=$1) AS updated_at
          FROM linked_accounts a LEFT JOIN coinbase_portfolio_sync s ON s.account_id=a.id WHERE a.id=$1
          UNION ALL
          SELECT resource,state,completed_at AS updated_at FROM coinbase_activity_sync WHERE account_id=$1`, [account.id])).rows;
      } else {
        rows = (await db.query<FeedRow>(`
          SELECT DISTINCT ON (r.resource) r.resource,r.state,c.watermark AS updated_at
          FROM account_sync_runs r LEFT JOIN account_sync_checkpoints c ON c.account_id=r.account_id AND c.resource=r.resource
          WHERE r.account_id=$1 ORDER BY r.resource,r.started_at DESC,r.id DESC`, [account.id])).rows;
      }
      const configured=account.venue==='coinbase'?(await db.query<{config:unknown}>('SELECT config FROM coinbase_account_source_settings WHERE account_id=$1',[account.id])).rows[0]?.config:undefined;
      // A malformed stored row must not fail the whole inventory: show the defaults background sync uses, and flag it.
      const stored=configured===undefined?undefined:readCoinbaseAccountConfig(configured);
      const reads=stored?.config.reads;
      sources.push({ ...account, ...(stored?.unreadable?{settingsUnreadable:true as const}:{}), feeds: rows.filter(row => Object.hasOwn(labels, row.resource)).map(row=>({...feed(row),...(reads?{enabled:row.resource==='portfolio'?reads.portfolio:row.resource==='spot_orders'?reads.orders:row.resource==='spot_fills'?reads.fills:true}:{})})) });
    }
    return { sources };
  });
}
