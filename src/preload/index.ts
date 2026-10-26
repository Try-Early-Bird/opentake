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
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AiConnectionsAPI } from '../shared/ai-connections';
import type { SettingsAPI } from '../shared/settings';
import type { ConnectionsAPI } from '../shared/connections';
import type { ActivityAPI } from '../shared/activity';

const settings: SettingsAPI = {
  search: () => ipcRenderer.invoke('settings:search:get'),
  saveSearch: value => ipcRenderer.invoke('settings:search:set', value),
  appVersion: () => ipcRenderer.invoke('settings:app-version'),
  checkForUpdates: includePrereleases => ipcRenderer.invoke('settings:check-updates', includePrereleases),
  updateState: () => ipcRenderer.invoke('settings:update-state'),
  onUpdateState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('settings:update-state', handler);
    return () => { ipcRenderer.removeListener('settings:update-state', handler); };
  },
  downloadUpdate: () => ipcRenderer.invoke('settings:download-update'),
  installUpdate: () => ipcRenderer.invoke('settings:install-update'),
  openUpdateDownload: () => ipcRenderer.invoke('settings:open-update'),
  jobRetention: () => ipcRenderer.invoke('settings:job-retention:get'),
  setJobRetention: days => ipcRenderer.invoke('settings:job-retention:set', days),
  financialRetention: () => ipcRenderer.invoke('settings:financial-retention:get'),
  setFinancialRetention: days => ipcRenderer.invoke('settings:financial-retention:set', days),
  aiAuditRetention: () => ipcRenderer.invoke('settings:ai-audit-retention:get'),
  setAiAuditRetention: days => ipcRenderer.invoke('settings:ai-audit-retention:set', days),
  loginItem: () => ipcRenderer.invoke('settings:login-item:get'),
  setLoginItem: enabled => ipcRenderer.invoke('settings:login-item:set', enabled),
  migrationHistory: () => ipcRenderer.invoke('settings:migrations'),
  listCredentials: () => ipcRenderer.invoke('settings:credentials:list'),
  saveCredential: input => ipcRenderer.invoke('settings:credentials:save', input),
  removeCredential: id => ipcRenderer.invoke('settings:credentials:remove', id),
  securityStatus: () => ipcRenderer.invoke('settings:security'),
  logRetention: () => ipcRenderer.invoke('settings:log-retention:get'),
  setLogRetention: days => ipcRenderer.invoke('settings:log-retention:set',days),
  logs: () => ipcRenderer.invoke('settings:logs'),
  memoryStats: () => ipcRenderer.invoke('settings:memory'),
  exportDatabase: password => ipcRenderer.invoke('settings:export', password),
  chooseImport: () => ipcRenderer.invoke('settings:choose-import'),
  importDatabase: (token, password, allowLegacy) => ipcRenderer.invoke('settings:import', token, password, allowLegacy),
};
contextBridge.exposeInMainWorld('settings', settings);
const connections: ConnectionsAPI = {
  toolSchemas: () => ipcRenderer.invoke('connections:tool-schemas'),
  cryptoToolSchemas: () => ipcRenderer.invoke('connections:crypto-tool-schemas'),
  status: () => ipcRenderer.invoke('connections:status'),
  connect: () => ipcRenderer.invoke('connections:connect'),
  refresh: () => ipcRenderer.invoke('connections:refresh'),
  cancel: () => ipcRenderer.invoke('connections:cancel'),
  reopenSignIn: () => ipcRenderer.invoke('connections:reopen'),
  disconnect: () => ipcRenderer.invoke('connections:disconnect'),
  selectAccount: id => ipcRenderer.invoke('connections:select', id),
};
contextBridge.exposeInMainWorld('connections', connections);
const activity: ActivityAPI = {
  list: () => ipcRenderer.invoke('activity:list'),
  history: cursor => ipcRenderer.invoke('activity:history', cursor),
  details: id => ipcRenderer.invoke('activity:details', id),
  retry: id => ipcRenderer.invoke('activity:retry', id),
  hostStatus: () => ipcRenderer.invoke('host:status'),
  quitCompletely: () => ipcRenderer.invoke('host:quit'),
};
contextBridge.exposeInMainWorld('activity', activity);
window.addEventListener('online', () => { void ipcRenderer.invoke('host:wake').catch(() => {}); });

const aiConnections: AiConnectionsAPI = {
  testGrok: () => ipcRenderer.invoke('ai:grok-test'),
  cancelGrokTest: () => ipcRenderer.invoke('ai:grok-test-cancel'),
  status: () => ipcRenderer.invoke('ai:status'),
  start: provider => ipcRenderer.invoke('ai:start', provider),
  checkOpenCode: () => ipcRenderer.invoke('ai:check-opencode'),
  useCredential: id => ipcRenderer.invoke('ai:use-credential', id),
  connectLocal: baseUrl => ipcRenderer.invoke('ai:connect-local', baseUrl),
  useOpenRouterCredential: id => ipcRenderer.invoke('ai:use-openrouter-credential', id),
  submitCode: (provider, code) => ipcRenderer.invoke('ai:submit-code', provider, code),
  disconnect: provider => ipcRenderer.invoke('ai:disconnect', provider),
  cancel: () => ipcRenderer.invoke('ai:cancel'),
  reopen: () => ipcRenderer.invoke('ai:reopen'),
};
contextBridge.exposeInMainWorld('aiConnections', aiConnections);

const chat: ChatAPI = { models: (provider, refresh) => ipcRenderer.invoke("chat:models", provider, refresh) };
contextBridge.exposeInMainWorld("chat", chat);

async function takeCall(method: string, ...args: unknown[]) { const result = await ipcRenderer.invoke('takes:'+method, ...args); if(result && typeof result === 'object' && 'error' in result) throw new Error(result.error); return result; }
const takes: TakesAPI = {
 document:(action,input)=>takeCall('document',action,input),
 messagesPage:(id,cursor)=>takeCall('messages-page',id,cursor),takesPage:(archived,cursor)=>takeCall('takes-page',archived,cursor),messageVersions:(id,message,cursor)=>takeCall('message-versions',id,message,cursor),
 budgets:()=>takeCall('budgets'),saveBudgets:value=>takeCall('save-budgets',value),automaticLimits:()=>takeCall('automatic-limits'),saveAutomaticLimits:value=>takeCall('save-automatic-limits',value),usageHistory:(id,before)=>takeCall('usage-history',id,before),
 snapshot:(id,archived,revision)=>takeCall('snapshot',id,archived,revision),create:()=>takeCall('create'),exportFile:id=>ipcRenderer.invoke('takes:export-file',id),importFile:()=>ipcRenderer.invoke('takes:import-file'),update:(id,patch)=>takeCall('update',id,patch),remove:id=>takeCall('remove',id),
 send:request=>takeCall('send',request),stop:id=>takeCall('stop',id),upload:(id,name,data)=>takeCall('upload',id,name,data),image:id=>takeCall('image',id),instructions:()=>takeCall('instructions'),instructionProfiles:()=>takeCall('instruction-profiles'),saveInstructionProfile:profile=>takeCall('save-instruction-profile',profile),publishInstructionProfile:id=>takeCall('publish-instruction-profile',id),instructionVersions:id=>takeCall('instruction-versions',id),removeInstructionProfile:id=>takeCall('remove-instruction-profile',id),saveAbout:text=>takeCall('save-about',text),restoreDefaultInstructions:id=>takeCall('restore-default-instructions',id),openLink:url=>ipcRenderer.invoke('takes:open-link',url),
};
contextBridge.exposeInMainWorld('takes',takes);

async function mcpCall(method:string,...args:unknown[]){const value=await ipcRenderer.invoke('mcp:'+method,...args);if(value?.error)throw new Error(value.error);return value;}
const mcp:McpManagementAPI={metadataHistory:(id,before)=>mcpCall('metadata-history',id,before),metadataRevision:id=>mcpCall('metadata-revision',id),oauthStatus:id=>mcpCall('oauth-status',id),oauthStart:id=>mcpCall('oauth-start',id),oauthCancel:id=>mcpCall('oauth-cancel',id),oauthDisconnect:id=>mcpCall('oauth-disconnect',id),serverPolicy:(id,value)=>mcpCall('server-policy',id,value),trustUpdates:(id,value)=>mcpCall('trust-updates',id,value),takePermissions:id=>mcpCall('take-permissions',id),setTakePermission:(take,server,tool,value)=>mcpCall('set-take-permission',take,server,tool,value),history:filter=>mcpCall('history',filter),platformSettings:()=>mcpCall('platform-settings'),configurePlatformAccess:value=>mcpCall('platform-configure',value),platformPending:()=>mcpCall('platform-pending'),decidePlatformAccess:(id,value)=>mcpCall('platform-decide',id,value),list:()=>mcpCall('list'),save:(id,config)=>mcpCall('save',id,config),enable:(id,value)=>mcpCall('enable',id,value),remove:id=>mcpCall('remove',id),discover:id=>mcpCall('discover',id),policy:(id,name,policy)=>mcpCall('policy',id,name,policy),approvals:()=>mcpCall('approvals'),decide:(id,approved)=>mcpCall('decide',id,approved)};
contextBridge.exposeInMainWorld('mcp',mcp);

const notifications: NotificationsAPI = {
  act:(id,action)=>ipcRenderer.invoke('notifications:act',id,action),
  list: cursor => ipcRenderer.invoke('notifications:list', cursor),
  markSeen: value => ipcRenderer.invoke('notifications:seen', value),
  target: id => ipcRenderer.invoke('notifications:target', id),
  navigation: () => ipcRenderer.invoke('notifications:navigation'),
  acknowledge: id => ipcRenderer.invoke('notifications:acknowledge', id),
};
contextBridge.exposeInMainWorld('notifications', notifications);

const allocationCall=(method:string,...args:unknown[])=>ipcRenderer.invoke('allocations:'+method,...args);
const allocations: AllocationsAPI = { versionReview:id=>allocationCall('version-review',id), adoptVersion:(id,from,to)=>allocationCall('adopt-version',id,from,to), review:id=>ipcRenderer.invoke('allocations:review',id), resume:id=>ipcRenderer.invoke('allocations:resume',id), pause:id=>ipcRenderer.invoke('allocations:pause',id), keepReduced:(id,caseId)=>ipcRenderer.invoke('allocations:keep-reduced',id,caseId), coverShortfall:(id,caseId)=>ipcRenderer.invoke('allocations:cover-shortfall',id,caseId), decideShareEvent:(id,eventId,decision)=>ipcRenderer.invoke('allocations:decide-share-event',id,eventId,decision),
 holdings:()=>allocationCall('holdings'), create:input=>allocationCall('create',input), update:(id,input)=>allocationCall('update',id,input), deposit:(id,amount)=>allocationCall('deposit',id,amount),
 redemptionPreview:(id,amount)=>allocationCall('redemption-preview',id,amount), redeem:(id,amount)=>allocationCall('redeem',id,amount), instructions:id=>allocationCall('instructions',id),
 cancelInstruction:(id,instructionId)=>allocationCall('cancel-instruction',id,instructionId), confirmInstruction:(id,instructionId)=>allocationCall('confirm-instruction',id,instructionId),
 resolveOutsideSale:(id,resolution)=>allocationCall('resolve-outside-sale',id,resolution), abandonOrder:(id,legId)=>allocationCall('abandon-order',id,legId), close:(id,sell)=>allocationCall('close',id,sell), plan:id=>allocationCall('plan',id),
 preflight:(target,amount)=>allocationCall('preflight',target,amount), activity:(strategyId,limit,cursor)=>allocationCall('activity',strategyId,limit,cursor),
 queueList:()=>allocationCall('queue-list'), queueAct:(itemId,action)=>allocationCall('queue-act',itemId,action),
 tradingPreferences:()=>allocationCall('trading-preferences'), setTradingPreferences:input=>allocationCall('set-trading-preferences',input) };
const orders: OrdersAPI = { execute:request=>ipcRenderer.invoke('orders:execute',request), status:()=>ipcRenderer.invoke('orders:status'), list:()=>ipcRenderer.invoke('orders:list'), review:async order=>{const result=await orders.execute({venue:'robinhood',action:'review',input:order});if(result.venue!=='robinhood')throw new Error('Unexpected broker');return {intent:result.intent,review:result.preview};}, abandon:id=>ipcRenderer.invoke('orders:abandon',id), confirm:async id=>{const result=await orders.execute({venue:'robinhood',action:'submit',input:id});if(result.venue!=='robinhood')throw new Error('Unexpected broker');return result.intent;} };
const portfolio: PortfolioAPI = { research:input=>ipcRenderer.invoke('portfolio:research',input), activity:(id,cursor)=>ipcRenderer.invoke('portfolio:activity',id,...(cursor?[cursor]:[])), coinbaseMarkets:{detail:(product,accountId)=>ipcRenderer.invoke("markets:coinbase:detail",product,...(accountId?[accountId]:[])),series:(product,range)=>ipcRenderer.invoke("markets:coinbase:series",product,range)}, fundamentals:symbols=>ipcRenderer.invoke('portfolio:fundamentals',symbols), search:query=>ipcRenderer.invoke('portfolio:search',query), market:symbol=>ipcRenderer.invoke('portfolio:market',symbol), logo:symbol=>ipcRenderer.invoke('portfolio:logo',symbol), strategyHistory:(id,range)=>ipcRenderer.invoke('portfolio:strategy-history',id,range), importStrategies:()=>ipcRenderer.invoke("portfolio:import-strategies"), series:(id,range,symbols)=>ipcRenderer.invoke('portfolio:series',id,range,...(symbols===undefined?[]:[symbols])), snapshot: id => ipcRenderer.invoke('portfolio:snapshot', ...(id === undefined ? [] : [id])), refresh: id => ipcRenderer.invoke('portfolio:refresh', ...(id === undefined ? [] : [id])), importHistory: () => ipcRenderer.invoke('portfolio:import-history') };
contextBridge.exposeInMainWorld('portfolio', portfolio);
const watchlists: WatchlistsAPI = { lists:()=>ipcRenderer.invoke('watchlists:lists'), items:(id,offset,limit)=>ipcRenderer.invoke('watchlists:items',id,offset??0,limit??undefined), membership:target=>ipcRenderer.invoke('watchlists:membership',target), sync:force=>ipcRenderer.invoke('watchlists:sync',force===true), syncItems:(id,force)=>ipcRenderer.invoke('watchlists:sync-items',id,force===true), create:input=>ipcRenderer.invoke('watchlists:create',input), rename:(id,name)=>ipcRenderer.invoke('watchlists:rename',id,name), remove:id=>ipcRenderer.invoke('watchlists:remove',id), addItem:(id,item)=>ipcRenderer.invoke('watchlists:add-item',id,item), removeItem:(id,itemId)=>ipcRenderer.invoke('watchlists:remove-item',id,itemId), move:(id,index)=>ipcRenderer.invoke('watchlists:move',id,index), moveItem:(id,itemId,index)=>ipcRenderer.invoke('watchlists:move-item',id,itemId,index) };
contextBridge.exposeInMainWorld('watchlists', watchlists);
contextBridge.exposeInMainWorld('allocations', allocations);
contextBridge.exposeInMainWorld('orders', orders);

async function strategyCall(method:string,...args:unknown[]){const value=await ipcRenderer.invoke('strategies:'+method,...args);if(value?.error)throw new Error(value.error);return value;}
const strategies:StrategiesAPI={overview:archived=>strategyCall('overview',archived),mixedWithdrawalEnd:id=>strategyCall('mixed-withdrawal-end',id),mixedWithdrawalLimits:(id,quote)=>strategyCall('mixed-withdrawal-limits',id,quote),mixedWithdrawalPreview:input=>strategyCall('mixed-withdrawal-preview',input),mixedWithdrawalConfirm:id=>strategyCall('mixed-withdrawal-confirm',id),mixedWithdrawal:id=>strategyCall('mixed-withdrawal',id),mixedPreview:input=>strategyCall('mixed-preview',input),mixedInvest:input=>strategyCall('mixed-invest',input),mixedInvestment:id=>strategyCall('mixed-investment',id),coinbaseLifecycle:(id,refresh=false)=>strategyCall('coinbase-lifecycle',id,refresh),decideCoinbaseLifecycle:input=>strategyCall('decide-coinbase-lifecycle',input),coinbaseWithdrawalBand:input=>strategyCall('coinbase-withdrawal-band',input),coinbasePreflight:input=>strategyCall('coinbase-preflight',input),coinbaseInvestment:id=>strategyCall('coinbase-investment',id),investCoinbase:input=>strategyCall('invest-coinbase',input),actCoinbaseInvestment:(id,action)=>strategyCall('act-coinbase-investment',id,action),saveCoinbaseRisk:input=>strategyCall('save-coinbase-risk',input),submitCoinbaseOrders:id=>strategyCall('submit-coinbase-orders',id),refreshCoinbaseOrders:id=>strategyCall('refresh-coinbase-orders',id),coinbaseOrders:id=>strategyCall('coinbase-orders',id),previewCoinbaseOrders:input=>strategyCall('preview-coinbase-orders',input),confirmCoinbaseOrders:id=>strategyCall('confirm-coinbase-orders',id),cancelCoinbaseOrders:id=>strategyCall('cancel-coinbase-orders',id),coinbaseCapital:id=>strategyCall('coinbase-capital',id),previewCoinbaseCapital:input=>strategyCall('preview-coinbase-capital',input),confirmCoinbaseCapital:id=>strategyCall('confirm-coinbase-capital',id),accountPlan:id=>strategyCall('account-plan',id),saveAccountPlan:input=>strategyCall('save-account-plan',input),source:id=>strategyCall('source',id),history:(id,before)=>strategyCall('history',id,before),available:(id,profile)=>strategyCall('available',id,profile),list:archived=>strategyCall('list',archived),read:id=>strategyCall('read',id),propose:input=>strategyCall('propose',input),useRevision:input=>strategyCall('use-revision',input),dismissSuggestion:input=>strategyCall('dismiss-suggestion',input),commit:input=>strategyCall('commit',input),verify:id=>strategyCall('verify',id),commitReview:id=>strategyCall('commit-review',id),messageProposals:id=>strategyCall('message-proposals',id),performance:(id,range,basis)=>strategyCall('performance',id,range,basis),markers:(id,range)=>strategyCall('markers',id,range)};
contextBridge.exposeInMainWorld('strategies',strategies);

const coinbase: CoinbaseConnectionsAPI = {
  list: () => ipcRenderer.invoke('coinbase:list'),
  importProgress: () => ipcRenderer.invoke('coinbase:import-progress'),
  importDroppedKey: (file, input) => ipcRenderer.invoke('coinbase:import-dropped-key', webUtils.getPathForFile(file), input),
  importKey: input => ipcRenderer.invoke('coinbase:import-key', input),
  refresh: id => ipcRenderer.invoke('coinbase:refresh', id),
  rename: (id, label) => ipcRenderer.invoke('coinbase:rename', id, label),
  disconnect: id => ipcRenderer.invoke('coinbase:disconnect', id),
  cancel: () => ipcRenderer.invoke('coinbase:cancel'),
  openPortal: destination => ipcRenderer.invoke('coinbase:open-portal', destination),
};
contextBridge.exposeInMainWorld('coinbase', coinbase);
const search: SearchAPI = { sources: () => ipcRenderer.invoke('search:sources'), start: input => ipcRenderer.invoke('search:start', input), snapshot: id => ipcRenderer.invoke('search:snapshot', id), cancel: id => ipcRenderer.invoke('search:cancel', id), resolve: hit => ipcRenderer.invoke('search:resolve', hit) };
contextBridge.exposeInMainWorld('search', search);

const searchAgent: SearchAgentAPI = {
  exportBackup: () => ipcRenderer.invoke('search:agent:export-file'),
  previewBackup: () => ipcRenderer.invoke('search:agent:import-file'),
  importBackup: token => ipcRenderer.invoke('search:agent:import-backup', token),
  previewRecovery: () => ipcRenderer.invoke('search:agent:preview-recovery'),
  confirmRecovery: token => ipcRenderer.invoke('search:agent:confirm-recovery', token), saved: () => ipcRenderer.invoke('search:agent:saved'), save: (run, title, venues) => ipcRenderer.invoke('search:agent:save', run, title, venues), removeSaved: id => ipcRenderer.invoke('search:agent:remove-saved', id), replay: id => ipcRenderer.invoke('search:agent:replay', id), start: request => ipcRenderer.invoke('search:agent:start', request), snapshot: id => ipcRenderer.invoke('search:agent:snapshot', id), stop: id => ipcRenderer.invoke('search:agent:stop', id), decide: (run, approval, allow) => ipcRenderer.invoke('search:agent:decide', run, approval, allow) };
contextBridge.exposeInMainWorld('searchAgent', searchAgent);

const dataSources: DataSourcesAPI = {
  coinbaseStream: {
    inspectMappings:()=>ipcRenderer.invoke('dataSources:stream',{action:'inspect-mappings'}),
    previewMappings:config=>ipcRenderer.invoke('dataSources:stream',{action:'preview-mappings',config}),
    source:()=>ipcRenderer.invoke('dataSources:stream',{action:'source'}),
    saveSource:(revision,config)=>ipcRenderer.invoke('dataSources:stream',{action:'save-source',revision,config}),
    setDustPolicy: policy => ipcRenderer.invoke('dataSources:stream', {action:'dust-policy',policy}).then(() => undefined),
    reconnect: () => ipcRenderer.invoke('dataSources:stream', {action:'reconnect'}).then(() => undefined),
    inspect: after => ipcRenderer.invoke('dataSources:stream', {action:'inspect',after}),
    messages: (leaseId, after) => ipcRenderer.invoke('dataSources:stream', { action: 'messages', leaseId, after }),
    acquire: (product, mode) => ipcRenderer.invoke('dataSources:stream', { action: 'acquire', product, mode }),
    renew: ids => ipcRenderer.invoke('dataSources:stream', { action: 'renew', ids }),
    read: ids => ipcRenderer.invoke('dataSources:stream', { action: 'read', ids }),
    release: ids => ipcRenderer.invoke('dataSources:stream', { action: 'release', ids }).then(() => undefined),
  },
  marketSearch: search,
  marketDetails: portfolio.market,
  marketSeries: portfolio.series,
  coinbaseMarket: portfolio.coinbaseMarkets.detail,
  coinbaseSeries: portfolio.coinbaseMarkets.series,
  managedSettings: accountId => ipcRenderer.invoke('dataSources:configure', { action: 'managed-list',accountId }),
  saveManagedSetting: setting => ipcRenderer.invoke('dataSources:configure', { action: 'managed-save', setting }),
  storedMarketPrice: market => ipcRenderer.invoke('dataSources:configure', { action: 'market-price', market }),
  marketMetadata: market => ipcRenderer.invoke('dataSources:configure', { action: 'market-metadata', market }),
  customSources: () => ipcRenderer.invoke('dataSources:configure', { action: 'list' }),
  saveSource: (config, existing) => ipcRenderer.invoke('dataSources:configure', { action: 'save', config, ...(existing ? { existing } : {}) }),
  previewSource: (id, revision) => ipcRenderer.invoke('dataSources:configure', { action: 'preview', id, revision }),
  enableSource: (id, revision, enabled) => ipcRenderer.invoke('dataSources:configure', { action: 'enable', id, revision, enabled }).then(() => undefined),
  inspect: request => ipcRenderer.invoke('dataSources:configure', { ...request, action: 'inspect' }),
  configure: request => ipcRenderer.invoke('dataSources:configure', request),
  inventory: () => ipcRenderer.invoke('dataSources:inventory'),
  list: () => ipcRenderer.invoke('dataSources:list'),
  acquire: feed => ipcRenderer.invoke('dataSources:acquire', feed),
  renew: ids => ipcRenderer.invoke('dataSources:renew', ids),
  read: ids => ipcRenderer.invoke('dataSources:read', ids),
  release: ids => ipcRenderer.invoke('dataSources:release', ids).then(() => undefined),
};
contextBridge.exposeInMainWorld('dataSources', dataSources);
