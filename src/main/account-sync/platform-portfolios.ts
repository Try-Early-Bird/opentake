import type { createAccountSync } from './service';
import type { createCoinbasePortfolio } from '../coinbase/portfolio';
/** Viewing a portfolio never changes the account authorized for trading or chat. */
export function createPlatformPortfolios(robinhood: Pick<ReturnType<typeof createAccountSync>, 'snapshot'>, coinbase: Pick<ReturnType<typeof createCoinbasePortfolio>, 'accounts' | 'snapshot' | 'refresh'>, refreshRobinhood: () => Promise<unknown>, orderActivity?: {sync():Promise<void>;list(accountId:string):Promise<import('../../shared/order-activity').OrderActivity[]>}) {
  return {
    async snapshot(accountId?: string) {
      const accounts = await coinbase.accounts();
      const isCoinbase = accounts.some(account => account.id === accountId);
      const rh = await robinhood.snapshot();
      const knownRobinhood = rh.accounts.some(account => account.id === accountId);
      const view = isCoinbase ? await coinbase.snapshot(accountId!) : !accountId ? rh : knownRobinhood ? await robinhood.snapshot(accountId) : { account: null, accounts: [], portfolio: null, resources: [], history: [], positionHistory: [], positions: [], orders: [], executions: [], gaps: [] };
      if(orderActivity)await orderActivity.sync();
      const events=view.account&&orderActivity?await orderActivity.list(view.account.id):[];
      return { ...view, orderActivity:events, accounts: [...rh.accounts, ...accounts] };
    },
    async refresh(accountId?: string) {
      const accounts = await coinbase.accounts();
      if (accountId && accounts.some(account => account.id === accountId)) { await coinbase.refresh(accountId); return; }
      const view = await robinhood.snapshot(accountId);
      if ((accountId && view.account?.id !== accountId) || !view.account?.selected || !view.account.available || view.account.venue !== 'robinhood') throw new Error('Select an eligible Robinhood account in Connections to sync it.');
      await refreshRobinhood();
    },
  };
}
