export const managedPollDefaults = [
  {id:'robinhood-account-sync',venue:'robinhood',name:'Account sync',intervalMs:5000},
  {id:'coinbase-account-sync',venue:'coinbase',name:'Account sync',intervalMs:5000},
  {id:'robinhood-prices',venue:'robinhood',name:'Prices and charts',intervalMs:30000},
  {id:'robinhood-earnings',venue:'robinhood',name:'Earnings calendar',intervalMs:30000},
] as const;
export type ManagedPollId = typeof managedPollDefaults[number]['id'];
export interface ManagedPollSetting { accountId?:string; id: ManagedPollId; collection: 'automatic' | 'off'; intervalMs: number; revision: number }
