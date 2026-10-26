import { DataSources } from './screens/DataSources';
import {CoinbaseMarketDetail} from './screens/CoinbaseMarketDetail';
import { SearchMarket } from './screens/SearchMarket';
import { Activity } from './screens/Activity';
import { Takes } from './screens/Takes';
import { Portfolio } from './screens/Portfolio';
import { MarketDetail } from './screens/MarketDetail';
import { StrategyDetail } from './screens/StrategyDetail';
import { JobHistory } from './screens/JobHistory';
import { Home } from './screens/Home';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { Settings } from './screens/Settings';

const rootRoute = createRootRoute({ component: AppShell });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home, validateSearch: (search: Record<string, unknown>): { takeId?: string } => ({ takeId: typeof search.takeId === 'string' && /^[a-f0-9-]{36}$/.test(search.takeId) ? search.takeId : undefined }) });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings,
  validateSearch: (search: Record<string, unknown>): { section?: 'mcp' | 'ai' | 'ai-settings' | 'general' | 'connections' | 'memory' | 'shortcuts' | 'credentials' | 'data-retention' | 'trading' | 'crypto' | 'logs' | 'search' } => ({
    section: search.section === 'job-history' ? 'data-retention' : search.section === 'data-retention' || search.section === 'mcp' || search.section === 'ai' || search.section === 'ai-settings' || search.section === 'connections' || search.section === 'memory' || search.section === 'shortcuts' || search.section === 'credentials' || search.section === 'trading' || search.section === 'crypto' || search.section === 'logs' || search.section === 'search' ? search.section : undefined,
  }),
});

// Keep old list links pointing to the take browser.
const basketsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/baskets', beforeLoad: () => { throw redirect({ to: '/takes' }); } });
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/activity', component: Activity });
const dataSourcesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/data-sources', component: DataSources });
const takesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/takes', component: Takes });
const portfolioRoute = createRoute({ getParentRoute: () => rootRoute, path: '/portfolio', component: Portfolio });
// Instrument detail. The `rh` segment names the source venue (Robinhood
// Agentic) so other venues can add their own detail routes alongside.
const coinbaseMarketRoute=createRoute({getParentRoute:()=>rootRoute,path:'/coinbase/$product',component:CoinbaseMarketDetail,validateSearch:(search:Record<string,unknown>):{accountId?:string}=>({accountId:typeof search.accountId==='string'&&/^[a-f0-9-]{36}$/.test(search.accountId)?search.accountId:undefined})});
const searchMarketRoute = createRoute({ getParentRoute: () => rootRoute, path: '/markets/$market', component: SearchMarket });
const robinhoodMarketRoute = createRoute({ getParentRoute: () => rootRoute, path: '/rh/$symbol', component: MarketDetail });
// One strategy's page: chart, holdings, key stats and your stake.
const strategyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/strategies/$strategyId', component: StrategyDetail });
const jobHistoryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/job-history', component: JobHistory });

// Memory history also works in packaged Electron's file:// renderer.
export const router = createRouter({
  routeTree: rootRoute.addChildren([dataSourcesRoute, homeRoute, settingsRoute, jobHistoryRoute, takesRoute, portfolioRoute, coinbaseMarketRoute, searchMarketRoute, robinhoodMarketRoute, strategyRoute, activityRoute, basketsRoute]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
