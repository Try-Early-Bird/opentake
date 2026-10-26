import type { DataSourcesAPI } from '../shared/data-sources';
import type { CoinbaseConnectionsAPI } from '../shared/platform-connections';
import type { SearchAgentAPI } from '../shared/search-agent';
import type { SearchAPI } from '../shared/search';
import type { StrategiesAPI } from '../shared/strategies';
import type { PortfolioAPI } from '../shared/portfolio';
import type { WatchlistsAPI } from '../shared/watchlists';
import type { AllocationsAPI } from '../shared/allocations';
import type { OrdersAPI } from '../shared/orders';
import type { NotificationsAPI } from '../shared/notifications';
import type { McpManagementAPI } from '../shared/mcp-management';
import type { TakesAPI } from '../shared/takes';
import type { ChatAPI } from '../shared/chat';
import type { AiConnectionsAPI } from '../shared/ai-connections';
import type { SettingsAPI } from '../shared/settings';
import type { ConnectionsAPI } from '../shared/connections';
import type { ActivityAPI } from '../shared/activity';
declare global {
  interface Window { dataSources: DataSourcesAPI; coinbase: CoinbaseConnectionsAPI; searchAgent: SearchAgentAPI; search: SearchAPI; strategies: StrategiesAPI; portfolio: PortfolioAPI; watchlists: WatchlistsAPI; allocations: AllocationsAPI; orders: OrdersAPI; notifications: NotificationsAPI; mcp: McpManagementAPI; takes: TakesAPI; chat: ChatAPI; aiConnections: AiConnectionsAPI; settings: SettingsAPI; connections: ConnectionsAPI; activity: ActivityAPI }
}
