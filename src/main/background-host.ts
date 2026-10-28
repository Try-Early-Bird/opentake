import {createExecutionLoops,type ExecutionLoops} from './execution-loops';
import {createAccountQueues} from './execution/account-queues';
import {lockedExecutor} from './execution/locked-executor';
import {createActionJobs} from './execution/action-jobs';
import {createVenueRegistry} from './venues/registry';
import {coinbaseVenue} from './venues/coinbase';
import {robinhoodVenueWith} from './venues/robinhood';
import {createRuleAgents} from './strategies/rule-agents';
import {createRuleTrades} from './strategies/rule-trades';
import {createRuleProposals} from './strategies/rule-proposals';
import {ruleReviewRequest} from '../shared/rule-proposals';
import {createRuleSourceAccess} from './data-sources/rule-source-access';
import {createRuleRunner} from './strategies/rule-runner';
import {createRuleDrafts} from './strategies/rule-drafts';
import {createCoinbaseValuationSnapshots} from './coinbase/valuation-snapshots';
import {createDataSourceChat} from './data-sources/chat';
import {createTakeInputChat} from './data-sources/take-input-chat';
import {createTakeInputs} from './data-sources/take-inputs';
import {createCoinbaseStreamPriceWriter} from './coinbase/stream-price-store';
import {inspectPriceMapping} from './data-sources/coinbase-stream/price-mapping-preview';
import {createAccountPollGate} from './data-sources/account-polls';
import {createCoinbaseAccountSettings} from './data-sources/coinbase-account-settings';
import { createCoinbaseSourceSettings } from './data-sources/coinbase-stream/source-settings';
import { createCryptoDustPolicy } from './data-sources/coinbase-stream/dust-policy';
import { createCoinbaseHoldingsStream } from './data-sources/coinbase-stream/holdings';
import { createCoinbasePublicTransport } from './data-sources/coinbase-stream/transport';
import { createCoinbaseStreamHost } from './data-sources/coinbase-stream/host';
import { createSourceDisplays } from './data-sources/display-service';
import { readStoredMarketPrice } from './data-sources/market-price-reader';
import { createManagedSourceSettings } from './data-sources/managed-settings';
import type { ManagedPollSetting } from '../shared/managed-polls';
import { createManagedPolls } from './data-sources/managed-polls';
import { createDataSourceInventory } from './data-sources/inventory';
import { createCustomDataSources } from './data-sources/service';
import { documentDirectory } from './document-files';
import { createTakeDocuments } from './take-documents';
import {createEarningsCalendarSync} from './market-series/earnings-calendar';
import { marketResearchTools } from '../shared/market-research';
import {createCryptoModel} from './assets/crypto-model';
import {createCryptoPriceHistory} from './assets/crypto-price-history';
import {trackedRobinhoodAssets} from './assets/tracker';
import {createCryptoOrderSync} from './orders/crypto-sync';
import {createTakeOrderWriter} from './orders/take-writer';
import {createCryptoTakeWriter} from './orders/crypto-take-writer';
import {createCryptoOrderJournal} from './orders/crypto-journal';
import {createMixedWithdrawals} from './mixed-execution/withdrawal';
import {mixedWithdrawalAdapters} from './mixed-execution/withdrawal-adapters';
import {createMixedInvestments} from './mixed-execution/service';
import {readVersionReview,adoptVersion} from './allocations/version-review';
import {instrumentBroker} from './broker-diagnostics';
import {PriceRefreshFailure} from './market-series/price-store';
import {readActivityPage} from './account-sync/activity-page';
import {createCoinbaseLifecycle} from './coinbase/lifecycle';
import {createCoinbaseScheduler} from './coinbase/scheduler';
import { FILL_WATCH_MS } from './account-sync/cadence';
import {createCoinbaseTakePerformance} from './coinbase/take-performance';
import {createCoinbaseTradingProduct} from './coinbase/trading-product';
import {createCoinbasePreflight} from './coinbase/preflight';
import {createCoinbaseInvestments} from './coinbase/investment';
import {createOrderActivity} from './trading/activity';
import {createTradingService} from './trading/service';
import {createCoinbaseExecution} from './coinbase/execution';
import { createCoinbaseOrderReviews } from './coinbase/order-reviews';
import { createCoinbaseCapital } from './coinbase/capital';
import { createTakeAccountPlans } from './strategies/account-plans';
import { createCoinbasePortfolio } from './coinbase/portfolio';
import { createPlatformPortfolios } from './account-sync/platform-portfolios';
import { createCoinbaseChat } from './coinbase/chat';
import { createCoinbaseConnections } from './coinbase/connections';
import { createCoinbaseSessionFactory } from './coinbase/client';
import { coinbaseError } from './coinbase/errors';
import { SearchMaintenanceError } from './search/previews';
import { createSavedScreens } from './search/saved-screens';
import { createRobinhoodScreening } from './search/robinhood-screening';
import { createSearchAgentService } from './search/agent-service';
import { createSearchSettings } from './search/settings';
import { createSearchService } from './search/service';
import { createLocalSearch } from './search/local';
import { coinbaseSearchAdapter } from './search/coinbase';
import { robinhoodSearchAdapter } from './search/robinhood';
import {synchronizeAndSettle} from './account-sync/settle';
import {createStrategyPortfolioImport,strategyImportResult,StrategyImportError} from './allocations/portfolio-import';
import { createGrokAccess } from './grok-access';
import {createPortfolioSeries} from './market-series/service';
import {createAllocationHistory} from './allocations/allocation-history';
import {createAllocationCore} from './allocations/service';
import {createAttributionSweep} from './allocations/attribution-sweep';
import {createOrderWriter} from './orders/service';
import {summarizeInvestment} from './execution/investment-summary';
import {createToolAccess,ToolAccessError} from './tool-access';
import {createRuleTargetSuggestions} from './strategies/rule-target-suggestions';
import {createRobinhoodRuleTrades} from './strategies/robinhood-rule-trades';
import {createRuleTradeApprovals} from './strategies/rule-trade-approvals';
import {createAllocationResume} from './allocations/resume';
import {createAllocationInstructions, authorResult, InstructionNotFound} from './execution/instructions';
import { createShareEventTracker } from './execution/share-event-repair';
import {createPlanner} from './execution/planner';
import {createExecutor} from './execution/executor';
import {createExecutionScheduler} from './execution/scheduler';
import {bindStrategyLots,ownLotsForSale,taxLotReaderFor} from './execution/sell-lots';
import {bindImportedLots} from './allocations/import-lots';
import {createMarketFacts} from './market-series/market-facts';
import {createPriceStore} from './market-series/price-store';
import {createWatchlists} from './watchlists/service';
import {dividendYields,rangeStartDay} from './strategies/performance';
import {createStrategyPerformance} from './strategies/performance';
import { z } from 'zod';
import { createStrategies } from './strategies/service';
import { createTakeOverview } from './strategies/overview';
import { createBasketVerification } from './strategies/verification';
import {createEligibilityRefresh} from './trading/eligibility-refresh';
import {createRobinhoodEligibility} from './trading/robinhood-eligibility';
import { basketInstructions } from '../shared/strategies';
import { exportTake, importTake } from './take-file';
import { createPortfolioHistoryImport } from './account-sync/history-import';
import { createAccountSync } from './account-sync/service';
import { executeAgentRun } from './agent-run';
import { createNotifications } from './notifications';
import { createNativeNotifications } from './native-notifications';
import { createPlatformAccess } from './platform-access';
import { recordStartupFailure } from './host-startup';
import { type RunBudget, type RunLimits } from './run-budget';
import { readJobHistory, readJobDetails } from './job-history';
import { createMcpManagement } from './mcp-management';
import { createTakes } from './takes';
import { createAiAudit } from './ai-audit';
import { createChatExecutor, chatAdapterIds } from './chat-executors';
import { sweepTemporaryRoots } from './temporary-files';
import { prepareImage } from './take-images';
import { aiCliInstalled } from './ai-runtime';
import { createModelDiscovery } from './ai-models';
import { createRunCapabilities } from './run-capabilities';
import { app, Menu, nativeImage, net, powerMonitor, powerSaveBlocker, safeStorage, shell, Tray } from 'electron';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createDatabaseLifecycle } from './database';
import { createOpenCodeConnection } from './opencode-connection';
import { createLocalModelConnection } from './local-model-connection';
import { createOpenRouterConnection } from './openrouter-connection';
import { createAiConnections } from './ai-connections';
import { createLocalAiLogin } from './ai-login';
import { createConnections } from './connections';
import { createConnectionActions } from './connection-actions';
import { createMaintenance } from './maintenance';
import { createSettingsService } from './settings';
import { createSecretStore, osSecretEncryption } from './secret-store';
import { atomicPrivateWrite, privateDirectory } from './private-files';
import { startHostRpc } from './host-rpc';
import { createDiagnostics } from './diagnostics';
import { connectionFailure } from './connection-errors';
import { callOpentakeTool } from './opentake-mcp/server';
import { readTakesAccount } from './opentake-mcp/catalog';
import icon from '../../resources/icon.png?asset';

export function launchDesktop(profile: string) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), `--user-data-dir=${profile}`];
  if (app.commandLine.hasSwitch('earlybird-test-no-secrets')) args.push('--earlybird-test-no-secrets');
  if (app.commandLine.hasSwitch('no-sandbox')) args.push('--no-sandbox');
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
  child.on('error', () => {}); child.unref();
}

export function bootBackgroundHost(profile: string, build: string) {
  // Original userData/app identity is retained for OS-backed safeStorage.
  app.setPath('sessionData', join(profile, 'host-session'));
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  // Leftovers from a crashed run may include plaintext provider auth files.
  sweepTemporaryRoots(profile);
  process.title = 'Opentake Background Host';
  const database = createDatabaseLifecycle(join(profile, 'database'));
  const dataSourceInventory = createDataSourceInventory(database);
  // This switch only disables secret access; it never enables a weaker backend.
  const disabledSecrets = app.commandLine.hasSwitch('earlybird-test-no-secrets');
  const encryption = disabledSecrets ? { available: () => false, encrypt: (): Buffer => { throw new Error('Disabled in tests'); }, decrypt: (): string => { throw new Error('Disabled in tests'); } }
    : osSecretEncryption(safeStorage);
  const secrets = createSecretStore(join(profile, 'secrets'), encryption);
  const dataSources = createCustomDataSources(database, secrets);
  // Activation gate: inject a bounded production transport only once it is proven.
  const coinbaseAccountSettings=createCoinbaseAccountSettings(database);
  const coinbaseSourceSettings=createCoinbaseSourceSettings(database);
  const cryptoDustPolicy=createCryptoDustPolicy(profile);
  const coinbaseStream = createCoinbaseStreamHost({ transport: createCoinbasePublicTransport() });
  const ruleSources=createRuleSourceAccess(dataSources,coinbaseStream,coinbaseSourceSettings,()=>!notificationSuspended&&!settings.busy()&&!quitting&&net.isOnline());
  const takeInputs=createTakeInputs(database,refs=>ruleSources.peek(refs));
  const ruleDrafts=createRuleDrafts(database,takeInputs.snapshot);
  // Strategy execution loops; created at startup, woken by the events below.
  let executionLoops: ExecutionLoops | undefined;
  const ruleRunner=createRuleRunner(database,takeInputs.snapshot,(id,refs)=>ruleSources.demand(id,refs),()=>!notificationSuspended&&!settings.busy()&&!quitting&&net.isOnline(),Date.now,()=>diagnostics.record('background.failed',{stage:'shadow-rules'}),(binding,freshness,timeout,signal)=>ruleSources.fetch(binding,freshness,timeout,signal),{sync:(id,subscriptions)=>dataSources.ruleEvents(id,subscriptions),read:(id,ruleId)=>dataSources.ruleEventBatch(id,ruleId)},()=>executionLoops?.ruleTrades.wake(250));
  const opencode = createOpenCodeConnection(secrets, disabledSecrets ? async () => ({ installed: false }) : undefined);
  const ai = createAiConnections(secrets, createLocalAiLogin(join(profile, 'ai-login-temporary')), url => shell.openExternal(url), disabledSecrets ? () => false : aiCliInstalled);
  const localModels = createLocalModelConnection(secrets, disabledSecrets ? async () => ({ installed: false }) : undefined);
  const openRouter = createOpenRouterConnection(secrets, disabledSecrets ? async () => ({ installed: false }) : undefined);
  const grokAccess = createGrokAccess(secrets, join(profile, 'grok-test-temporary'));
  const aiStatus = async () => [...await ai.status(), await opencode.status(), await openRouter.status(), await localModels.status()];
  const models = createModelDiscovery(secrets, join(profile, 'model-discovery-temporary'), aiStatus, undefined, undefined, () => localModels.models());
  // OpenRouter list prices let OpenCode report cost for the cost threshold.
  const openRouterModel = async (id: string) => { const result = await models('openrouter'); return result.ok ? result.models.find(m => m.value === id) : undefined; };
  const executeChat = createChatExecutor(secrets, profile, join(__dirname, 'earlybird-opentake-mcp.js'), () => opencode.chatKey(), () => localModels.baseUrl(), { key: () => openRouter.chatKey(), model: openRouterModel });
  const aiAudit = createAiAudit(database);
  const budgets = new Map<string, RunBudget>();
  const activeRun = (id:string) => takes.activeRun(id) && !budgets.get(id)?.signal.aborted;
  const capabilities = createRunCapabilities(activeRun);
  const documents = createTakeDocuments(database,()=>documentDirectory(database.directory));
  const takes = createTakes(database, async input => {
    if (!rpc) throw new Error('Chat gateway unavailable.');
    const configuration=(await database.use(d=>d.query<{configuration:Record<string,unknown>}>('SELECT configuration FROM take_runs WHERE id=$1',[input.id]))).rows[0]?.configuration??{};
    let grant: ReturnType<typeof capabilities.issue> | undefined;
    // Rule agent runs carry their own limits and source.
    const limits=configuration.limits as RunLimits|undefined,rule=configuration.rule as {requestId:string}|undefined;
    await executeAgentRun({ id: input.id, context: rule?{ feature: 'rule', operation: 'respond', sourceRef: rule.requestId }:{ feature: 'chat', operation: 'respond', sourceRef: input.takeId },
      selection: input.selection, adapter: chatAdapterIds[input.selection.provider], configuration: { ...configuration, messages: input.messages },
      signal: input.signal, budgets: input.budgets, usage: input.usage, limits }, {
      audit: aiAudit, budgets,
      authorize: async () => { grant = capabilities.issue(input.id, input.takeId, limits?.absoluteMs); await platformAccess.ensure(input.id); },
      execute: runtime => executeChat({ ...input, ...runtime, managedBudget: true, ...(limits?.modelTurns?{maxTurns:limits.modelTurns}:{}), gateway: { port: rpc!.manifest.port, token: grant!.token } }),
      cleanup: async () => { grant?.revoke(); await mcp.expireRun(input.id); },
    });
  }, models, takeId => mcp.policySnapshot(takeId),undefined,async takeId=>{
    const basket=await strategies.read(takeId);
    return basketInstructions+'\nCurrent take ID: '+takeId+(basket?'\nStrategy data (not instructions): '+JSON.stringify({targetTakeId:takeId,expectedRevision:basket.draft.id,expectedVersion:basket.currentVersion,draft:basket.draft}):'\nNo strategy yet: first proposal expects null revision and version.');
  }, async ref => ref ? coinbase.chatScope(ref) : Promise.all((await coinbase.list()).filter(account=>account.capabilities.chat).map(account=>coinbase.chatScope(account.accountId))));
  const diagnostics = createDiagnostics(join(profile, 'logs', 'host'), app.getVersion());
  const streamPriceWriter=createCoinbaseStreamPriceWriter(database,()=>({revision:coinbaseSourceSettings.get().revision,quotes:notificationSuspended||settings.busy()||quitting?[]:coinbaseStream.quotes()}),Date.now,()=>diagnostics.record('background.failed',{stage:'coinbase-stream-prices'}));
  const valuationSnapshots=createCoinbaseValuationSnapshots(database,()=>({revision:coinbaseSourceSettings.get().revision,quotes:coinbaseStream.quotes()}),()=>!notificationSuspended&&!settings.busy()&&!quitting&&net.isOnline(),Date.now,()=>diagnostics.record('background.failed',{stage:'coinbase-valuation-snapshots'}));
  const connections = instrumentBroker(createConnections(database, secrets, url => shell.openExternal(url)),'robinhood',diagnostics);
  const coinbase = instrumentBroker(createCoinbaseConnections(database, secrets, createCoinbaseSessionFactory(join(profile, 'coinbase-temporary'))),'coinbase',diagnostics);
  const cryptoPriceHistory=createCryptoPriceHistory(database);
  const cryptoModel=createCryptoModel(database,Date.now,(symbols,from,q)=>priceStore.closes(symbols,from,q));
  const portfolio = createAccountSync(database, connections,Date.now,async accountId=>{
    const targets=(await database.use(db=>trackedRobinhoodAssets(db,accountId)))
      .filter(asset=>asset.identity.kind==='crypto').map(asset=>asset.identity.reference);
    // Broker holdings are the source of discovery, even before any Take/order
    // exists locally. The transport distinguishes no crypto account from a failed read.
    return connections.cryptoSession(accountId,session=>session.portfolio(targets,async samples=>{await cryptoPriceHistory.record(accountId,samples);await cryptoModel.refresh(accountId);}));
  },(accountId,since,knownOpen)=>connections.cryptoSession(accountId,session=>session.orders(since,knownOpen)));
  const coinbasePortfolio = createCoinbasePortfolio(database, coinbase, Date.now, () => notificationSuspended || settings.busy() || quitting || coinbase.busy() || coinbaseExecution.busy() || !net.isOnline(), product => coinbaseHoldings.price(product), cryptoDustPolicy.get,{backgroundAllowed:accountId=>accountPollDue('coinbase-account-sync',accountId),config:async accountId=>(await coinbaseAccountSettings.load(accountId)).config,
    synced:()=>executionLoops?.coinbaseScheduler.wake(1_000)});
  const coinbaseHoldings = createCoinbaseHoldingsStream(coinbaseStream, () => coinbasePortfolio.heldMarkets(), () => !notificationSuspended && !settings.busy() && !quitting && net.isOnline(),()=>{const source=coinbaseSourceSettings.get();return {collection:source.enabled?source.config.collection:'off',subscriptions:source.config.provider!.subscriptions,priceMappings:source.config.provider!.priceMappings};});
  const tradingEnabled = () => process.env.OPENTAKE_TRADING !== '0';
  const eligibilityRefresh=createEligibilityRefresh();
  const robinhoodEligibility=createRobinhoodEligibility(connections,eligibilityRefresh);
  const coinbaseTradingProduct=createCoinbaseTradingProduct({read:async(scope,id)=>(await coinbase.readChat(scope,'coinbase_products_get',{product_id:id})).data,rules:(scope,id)=>coinbase.readTradingRules(scope,id)},eligibilityRefresh);
  const coinbaseOrders=createCoinbaseOrderReviews(database,{
    enabled:tradingEnabled,
    refresh:id=>coinbasePortfolio.refresh(id),scope:id=>coinbase.chatScope(id),
    product:coinbaseTradingProduct,
    preview:(scope,orders)=>coinbase.previewOrders(scope,orders),
  });
  // One queue per account for money-moving operations; member actions go first.
  // Keep the Mac from napping or idle-sleeping only while money-moving work runs, e.g.
  // between sending an order and recording its result. Lid-close sleep is not prevented.
  let suspensionBlocker:number|undefined;
  const accountQueues=createAccountQueues({busyChanged:busy=>{
    if(busy&&suspensionBlocker===undefined)suspensionBlocker=powerSaveBlocker.start('prevent-app-suspension');
    else if(!busy&&suspensionBlocker!==undefined){powerSaveBlocker.stop(suspensionBlocker);suspensionBlocker=undefined;}
  },report:event=>diagnostics.record('execution.account',{kind:event.kind,label:event.label,...('deadlineMs' in event?{deadlineMs:event.deadlineMs}:{}),...('heldMs' in event?{heldMs:event.heldMs}:{}),...('waitMs' in event?{waitMs:event.waitMs}:{}),accountId:event.accounts[0]})});
  // Orders just went out: check them promptly on a short backoff instead of waiting for the next interval.
  const followUpOrders=(accountId:string)=>{void actionJobs.nudge(accountId).catch(()=>{});for(const delay of [1_000,2_000,4_000,8_000]){executionLoops?.ruleTrades.wake(delay);executionLoops?.coinbaseScheduler.wake(delay);}};
  const coinbaseExecution=createCoinbaseExecution(database,coinbaseOrders,{
    accounts:accountQueues,submitted:accountId=>followUpOrders(accountId),
    validateRuleTrade:(tx,row,manual)=>ruleTrades.validateSubmission(tx,row,manual),
    enabled:()=>tradingEnabled()&&!quitting&&!settings.busy()&&!notificationSuspended&&net.isOnline(),
    refresh:id=>coinbasePortfolio.refresh(id),scope:id=>coinbase.chatScope(id),
    product:coinbaseTradingProduct,
    preview:(scope,orders)=>coinbase.previewOrders(scope,orders),
    submit:(scope,order,before)=>coinbase.submitOrder(scope,order,before),
    cancel:(scope,id,before)=>coinbase.cancelOrder(scope,id,before),
  });
  const ruleTrades=createRuleTrades(database,{
    enabled:()=>tradingEnabled()&&!quitting&&!settings.busy()&&!notificationSuspended&&net.isOnline(),
    snapshot:takeInputs.snapshotInTransaction,
    preview:(takeId,quote,ruleRequestId,phase,action)=>coinbaseOrders.preview({takeId,quote,...(action?.kind==='deploy_cash'?{purchaseOnly:true,deployAmount:action.amount.value}:action?.kind==='reduce'?{withdrawAmount:action.amount.value}:{})},undefined,{scheduledOn:new Date().toISOString().slice(0,10),trigger:'rule',ruleRequestId,phase}),
    view:coinbaseExecution.view,confirm:coinbaseOrders.confirm,submit:id=>coinbaseExecution.submit(id,false),refresh:coinbaseExecution.refresh,cancelPrepared:coinbaseOrders.cancel,
    notifications:{record:(input,origin)=>notifications.record(input,origin),resolve:key=>notifications.resolve(key)},
    report:error=>diagnostics.record('background.failed',{venue:'coinbase',stage:'execution',error}),
    accounts:accountQueues,wake:()=>executionLoops?.ruleTrades.wake(),
  });
  // Every action runs through the shared job core and a venue module.
  // An agent rule's firing starts a bounded background run in its Take.
  const ruleAgents=createRuleAgents(database,{
    ruleRun:input=>takes.ruleRun(input),
    stop:async(takeId,runId)=>{if(takes.activeRun(runId))await takes.stop(takeId);},
    wake:()=>executionLoops?.ruleTrades.wake(),tradingEnabled,automaticLimits:()=>takes.automaticLimits(),
    notify:async({takeId,requestId,title,body,attention})=>{await notifications.record({kind:'rule_notification',context:{takeId},source:{type:'rule',id:requestId},eventKey:'agent_run',
      tier:attention?'act_now':'know_today',requiresAction:attention,occurredAt:new Date().toISOString(),title,body});},
  });
  // A buy/trim/exit rule suggests a new target for the Take instead of trading.
  const ruleTargets=createRuleTargetSuggestions(database,{suggest:input=>strategies.ruleSuggest(input),
    value:async takeId=>{const cb=await coinbaseCapital.view(takeId).catch(()=>null);if(cb?.valuation?.value)return Number(cb.valuation.value);
      const strategyId=(await database.use(db=>db.query<{strategy_id:string|null}>('SELECT strategy_id FROM takes WHERE id=$1',[takeId]))).rows[0]?.strategy_id;
      const h=((await allocationInstructions.holdings()).holdings as {strategy:{id:string};valuation:{totalValue:string|null}}[]).find(x=>x.strategy.id===strategyId);return h?.valuation.totalValue?Number(h.valuation.totalValue):null;},
    notify:async({takeId,requestId,title,body,attention})=>{await notifications.record({kind:'rule_notification',context:{takeId},source:{type:'rule',id:requestId},eventKey:'target_suggestion',
      tier:attention?'act_now':'know_today',requiresAction:attention,occurredAt:new Date().toISOString(),title,body});}});
  // A rule's rebalance or reduce on a Robinhood Take, through the existing planner and executor.
  const robinhoodTrades=createRobinhoodRuleTrades(database,{snapshot:takeInputs.snapshotInTransaction,previewRebalance:(id,options)=>planner.previewAllocation(id,'manual',options),previewReduce:(id,amount)=>allocationInstructions.redemptionPreview(id,amount),
    rebalance:(id,options)=>allocationInstructions.plan(id,true,options),reduce:(id,amount,op)=>allocationInstructions.redeem(id,amount,op,true),tradingEnabled,
    notify:async({takeId,requestId,title,body,attention})=>{await notifications.record({kind:'rule_notification',context:{takeId},source:{type:'rule',id:requestId},eventKey:'robinhood_trade',
      tier:attention?'act_now':'know_today',requiresAction:attention,occurredAt:new Date().toISOString(),title,body});}});
  const venues=createVenueRegistry([coinbaseVenue(ruleTrades),robinhoodVenueWith(robinhoodTrades.adapters)],{agent_run:ruleAgents.adapter});
  // One approval flow for rule trades on both venues.
  const ruleTradeApprovals=createRuleTradeApprovals(database,{robinhood:robinhoodTrades,submitCoinbase:id=>coinbaseExecution.submit(id),
    cancel:async requestId=>{const job=(await database.use(db=>db.query<{id:string}>("SELECT id FROM action_jobs WHERE idempotency_key='rule:'||$1::text",[requestId]))).rows[0];if(job)await actionJobs.cancel(job.id);else await ruleTrades.cancel(requestId);},
    nudge:()=>actionJobs.nudge()});
  const actionJobs=createActionJobs(database,venues,{accounts:accountQueues,wake:()=>executionLoops?.ruleTrades.wake(),
    report:error=>diagnostics.record('background.failed',{venue:'coinbase',stage:'rule_trades',error})});
  const coinbasePreflight=createCoinbasePreflight(database,{scope:id=>coinbase.chatScope(id),product:coinbaseTradingProduct});
  const coinbaseTakePerformance=createCoinbaseTakePerformance(database,coinbasePortfolio.prices,Date.now,undefined,product=>coinbaseHoldings.price(product));
  const coinbaseLifecycle=createCoinbaseLifecycle(database);
  const coinbaseCapital = createCoinbaseCapital(database,Date.now,id=>coinbasePortfolio.refresh(id),coinbaseTakePerformance.summary);

  const coinbaseInvestments=createCoinbaseInvestments(database,coinbaseCapital,coinbaseOrders,coinbaseExecution,async id=>{
    if(!tradingEnabled()||quitting||settings.busy()||notificationSuspended||!net.isOnline())throw new Error('Trading is currently unavailable.');
    await coinbase.previewOrders(await coinbase.chatScope(id),[]);
  });

  const coinbaseScheduler=createCoinbaseScheduler(database,coinbaseOrders,coinbaseExecution,()=>tradingEnabled()&&!quitting&&!settings.busy()&&!notificationSuspended&&net.isOnline()&&!coinbaseInvestments.busy()&&!coinbasePortfolio.busy()&&!coinbase.busy(),Date.now,{record:(input,origin)=>notifications.record(input,origin),resolve:key=>notifications.resolve(key)},(reason,takeId)=>diagnostics.record('rebalance.decision',{venue:'coinbase',reason,takeId}),accountQueues);

  const takeAccountPlans = createTakeAccountPlans(database);
  const platformPortfolios = createPlatformPortfolios(portfolio, coinbasePortfolio, () => maintenance.request(), createOrderActivity(database));
  // Self-hosted market data: quotes and daily closes polled from the member's Robinhood connection.
  const selectedAccountId = async () => (await connections.status()).accounts.find(a => a.selected && a.agenticAllowed)?.id ?? null;
  // Chart series persist in the store; the poller keeps today's series warm for what you hold.
  const priceStore: ReturnType<typeof createPriceStore> = createPriceStore(database, connections, Date.now, async held => {
    const accountId = await selectedAccountId();
    if (accountId === null) return;
    // The series service fills ten symbols per call.
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await portfolioSeries({ accountId, range: '1d', symbols: held });
      if (!result.pendingSymbols.length && !result.refreshingSymbols.length) break;
    }
  }, () => watchlists.quoteSymbols());
  const portfolioSeries = createPortfolioSeries(connections, id => portfolio.snapshot(id), Date.now, priceStore.seriesCache);
  const storedCloses = async (symbols: string[], range: '1d'|'1w'|'1m'|'3m'|'1y'|'3y'|'5y'|'all') => {
    const start = rangeStartDay(range, new Date());
    if (start === null || range === '1d' || range === '3y' || range === '5y' || symbols.length === 0) return null;
    // A week before the range start so the first day carries its previous close.
    const from = new Date(Date.parse(`${start}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    return (await priceStore.covers(symbols, start)) ? priceStore.closes(symbols, from) : null;
  };
  const allocationHistory = createAllocationHistory(database,portfolioSeries,Date.now,storedCloses);
  const marketFacts = createMarketFacts(connections,join(profile,'logos'));
  const earningsCalendar = createEarningsCalendarSync(database, (name, args) => connections.readTool(name,args,undefined,AbortSignal.timeout(20_000)));
  const mixedTakePerformance=createCoinbaseTakePerformance(database,coinbasePortfolio.prices,Date.now,{async series(strategyId,symbols,range){
    const account=await database.use(async db=>(await db.query<{account_id:string}>("SELECT account_id FROM strategy_account_routes WHERE strategy_id=$1 AND venue='robinhood'",[strategyId])).rows[0]);
    if(!account)return [];
    let result=await portfolioSeries({accountId:account.account_id,symbols,range});
    for(let i=0;result.pendingSymbols.length&&i<10;i++)result=await portfolioSeries({accountId:account.account_id,symbols,range});
    if(result.staleSymbols.length)return [];
    return result.series;
  }},product=>coinbaseHoldings.price(product));
  const searchAdapter = robinhoodSearchAdapter(connections);
  const search = createSearchService([searchAdapter, coinbaseSearchAdapter(coinbasePortfolio.prices, coinbasePortfolio.markets, async () => (await coinbase.list()).some(account => account.status === 'connected'))], createLocalSearch(database));
  const strategyPerformance = createStrategyPerformance(database,portfolioSeries,symbols=>marketFacts.fundamentals(symbols),
    async()=>(await connections.status()).accounts.find(a=>a.selected&&a.agenticAllowed)?.id??null,Date.now,storedCloses,{...coinbaseTakePerformance,mixed:mixedTakePerformance},cryptoModel.read);
  const portfolioHistoryImport = createPortfolioHistoryImport(database);
  const strategyPortfolioImport = createStrategyPortfolioImport(database,connections.matchStrategyImport);
  let portfolioUiSeenAt = 0;
  const coinbaseChat = createCoinbaseChat(database, coinbase);
  const platformAccess = createPlatformAccess(database,activeRun,{
    budget:id=>budgets.get(id),
    accounts:async run=>{const state=await connections.status();const scopes=await coinbaseChat.scopes(run);return [...state.accounts.filter(a=>a.selected&&a.agenticAllowed).map(a=>'robinhood:'+a.id),...scopes.map(scope=>'coinbase:'+scope.accountRef)];}
  });
  const strategies=createStrategies(database,{changed:()=>takes.changed(),active:activeRun,ensure:run=>platformAccess.ensure(run),verify:createBasketVerification(connections,Date.now,robinhoodEligibility)});
  const sourceChat=createDataSourceChat(database,refs=>dataSources.peek(refs),()=>notificationSuspended||settings.busy()||quitting?[]:coinbaseStream.quotes(),activeRun);
  const ruleProposals=createRuleProposals(database,activeRun,tradingEnabled);
  const takeInputChat=createTakeInputChat(database,takeInputs.snapshot,activeRun);
  const takeOverview=createTakeOverview(strategies,coinbaseCapital);
  const mcp = createMcpManagement(database,secrets,join(profile,'mcp-temporary'),activeRun,async (name,input,signal,run,call)=>callOpentakeTool({
    dataSourceList:async()=>{if(!run)throw Error('Run required');return sourceChat.list(run);},
    dataSourceRead:async input=>{if(!run)throw Error('Run required');return sourceChat.read(run,input);},
    rules:async(name,input)=>{if(!run)throw Error('Run required');await platformAccess.ensure(run);return name==='opentake_read_rules'?ruleProposals.agentRead(run):name==='opentake_read_rule_activity'?ruleProposals.agentActivity(run,input):name==='opentake_request_trade'?ruleAgents.requestTrade(run,input):ruleProposals.propose(run,input);},
    takeInputs:async()=>{if(!run)throw Error('Run required');return takeInputChat(run);},
    documents:async(input)=>{if(!run)throw new Error('Run required');return documents.tool(run,input,signal);},
    strategy:async(name,input)=>{if(!run)throw new Error('Run required');return name==='opentake_propose_strategy'?strategies.agentPropose(run,input,call):strategies.agentRead(run,z.object({targetTakeId:z.uuid().optional()}).strict().parse(input).targetTakeId);},
    // Read-only: the take's strategy and the member's money in it, after the same access checks as reading the strategy.
    watchlists:input=>watchlists.agentRead(input),
    investment:async(input)=>{if(!run)throw new Error('Run required');const read=await strategies.agentRead(run,z.object({targetTakeId:z.uuid().optional()}).strict().parse(input).targetTakeId) as {targetTakeId:string;basket?:{strategyId:string}|null};
      if(!read.basket)return {invested:false,note:'This take has nothing committed to invest in yet.'};
      return summarizeInvestment({holdings:()=>allocationInstructions.holdings(),instructions:id=>allocationInstructions.instructions(id),performance:(id,range,basis)=>strategyPerformance.performance(id,range,basis),
       // A Take without a Coinbase account or allocation has nothing there to read.
       coinbase:()=>coinbaseCapital.view(read.targetTakeId).catch(()=>null)},read.basket.strategyId);},
    toolAccess:async(name,input)=>{if(!run)throw new Error('Run required');return name==='opentake_list_blocked_tools'?toolAccess.list(run):toolAccess.file(run,input);},
    status:async platform=>{if(platform==='coinbase')return coinbaseChat.status(run);const state=await connections.status();return {...state,accounts:state.accounts.filter(a=>a.selected&&a.agenticAllowed)};},
    stored:async(ref)=>{const state=await connections.status();const selected=state.accounts.find(a=>a.selected&&a.agenticAllowed);if(state.status!=='connected'||!selected||(ref&&ref!==selected.id))throw new Error('Account unavailable');const view=await portfolio.snapshot(selected.id);return {...view,accounts:view.accounts.filter(a=>a.id===selected.id)};},
    read:async(platform,name,args,ref)=>{if(platform==='coinbase')return coinbaseChat.read(run,name,args,ref,signal);const state=await connections.status();const selected=state.accounts.find(a=>a.selected&&a.agenticAllowed);if(ref&&ref!==selected?.id)throw new Error('Account unavailable');return connections.readTool(name,args,readTakesAccount(name)?selected?.id:undefined,signal);}
  },name,input), undefined, { openBrowser:url=>shell.openExternal(url), budget: id=>budgets.get(id), beforeBuiltin:run=>platformAccess.ensure(run) });
  // Chat can ask to turn a tool on; the member approves each request in the thread.
  const toolAccess=createToolAccess({list:()=>mcp.list(),policy:(server,name,value)=>mcp.policy(server,name,value),use:work=>database.use(work),active:activeRun,
    take:async run=>{const takeId=(await database.use(db=>db.query<{take_id:string}>('SELECT take_id FROM take_runs WHERE id=$1',[run]))).rows[0]?.take_id;if(!takeId)throw new Error('Run unavailable');return {takeId,permissions:await mcp.takePermissions(takeId)};}});
  const searchAgent = createSearchAgentService({
    screening: createRobinhoodScreening(profile, connections), savedScreens: createSavedScreens(profile),
    settings: createSearchSettings(profile).read, models, policies: () => mcp.policySnapshot(), budgets: () => takes.budgets(), audit: aiAudit,
    adapter: searchAdapter, execute: executeChat, port: () => { if (!rpc) throw new Error('Gateway unavailable'); return rpc.manifest.port; },
    sharing: async () => {
      const setting = await platformAccess.settings(); const connection = await connections.status();
      return { ...setting, scope: JSON.stringify({ venue: 'robinhood', status: connection.status, checkedAt: connection.checkedAt,
        accounts: connection.accounts.filter(a => a.selected && a.agenticAllowed).map(a => a.id).sort() }) };
    },
  });
  let quitting = false;
  let updateNonce: string | undefined;
  let priceWork: Promise<void> | undefined;
  let notificationTimer: ReturnType<typeof setInterval> | undefined;
  let eventLoopTimer: ReturnType<typeof setInterval> | undefined;
  let notificationSuspended = false;
  let notificationUnreadCount = 0;
  const nativeNotifications = createNativeNotifications(icon);
  const notifications = createNotifications(database, {
    trading:{list:()=>allocationInstructions.queueList(),act:(id,action)=>allocationInstructions.queueAct(id,action)},
    dividendYields: symbols => marketFacts.fundamentals(symbols).then(dividendYields),
    deliver: alert => nativeNotifications.deliver(alert),
    openDesktop: () => launchDesktop(profile),
    badge: count => { notificationUnreadCount = count; app.setBadgeCount(count); },
  });
  const manualActions = createConnectionActions(() => { portfolio.cancel(); connections.cancel(); });
  let ready = false;
  let tray: Tray | undefined;
  let networkTimer: ReturnType<typeof setInterval> | undefined;
  let rpc: Awaited<ReturnType<typeof startHostRpc>> | undefined;
  const settings = createSettingsService(database, () => quitting, secrets, profile, () => app.getAppMetrics(), () => connections.busy() || coinbase.busy() || coinbasePortfolio.busy() || coinbaseExecution.busy() || coinbaseInvestments.busy() || portfolio.busy() || takes.busy() || documents.busy() || search.busy());
  // Every successful sync settles its new fills against the allocation ledger.
  const allocationCore = createAllocationCore(database);
  // Venue queue owns contention and cancellation for tax-lot reads.
  const readTaxLots = taxLotReaderFor((args, accountId) => connections.readTool('get_equity_tax_lots',args,accountId,AbortSignal.timeout(20_000)));
  // The single order writer. On by default; OPENTAKE_TRADING=0 on the host is the off switch.
  const orderWriter = createOrderWriter(database, { equityOrder: (stage, input, accountId, refId) => connections.equityOrder(stage, input, accountId, refId) }, {
    enabled: tradingEnabled,
    // Your own orders may not spend a strategy's cash or sell its shares.
    guardSelfDirected: async ({ accountId, order }) => {
      const quote = (await database.use(db => db.query<{ price: string }>('SELECT price::text FROM market_quotes WHERE symbol=$1', [order.symbol]))).rows[0]?.price;
      const value = order.dollar_amount ?? (quote === undefined ? undefined : String(Number(order.quantity) * Number(quote)));
      if (order.side === 'buy') {
        if (value === undefined) throw new Error(`No price for ${order.symbol} yet; try again after the next sync`);
        await allocationCore.guardSelfDirected({ accountId, side: 'buy', amount: Number(value).toFixed(2) });
      } else {
        const quantity = order.quantity ?? (quote === undefined ? undefined : (Number(order.dollar_amount) / Number(quote)).toFixed(6));
        if (quantity === undefined) throw new Error(`No price for ${order.symbol} yet; try again after the next sync`);
        const instrumentRef = (await database.use(db => db.query<{ ref: string }>(`SELECT p->>'instrumentRef' AS ref FROM account_observations o JOIN position_snapshots s ON s.id=o.position_snapshot_id,
          jsonb_array_elements(s.data) p WHERE o.account_id=$1 AND o.resource='equity_positions' AND upper(p->>'symbol')=$2 ORDER BY o.observed_at DESC LIMIT 1`, [accountId, order.symbol]))).rows[0]?.ref;
        if (instrumentRef === undefined) throw new Error(`You don't hold ${order.symbol}`);
        await allocationCore.guardSelfDirected({ accountId, side: 'sell', amount: quantity, instrumentRef, lotIds: order.tax_lots?.map(l => l.open_lot_id) });
        // Name your own lots so first-in-first-out cannot take a strategy's shares.
        if (order.tax_lots === undefined) {
          const lots = await database.use(db => ownLotsForSale(db, readTaxLots, { accountId, instrumentRef, symbol: order.symbol, quantity }));
          if (lots !== null) {
            if (order.dollar_amount !== undefined) throw new Error(`Sell ${order.symbol} by share quantity: a take also holds it, so your own lots must be named`);
            return { ...order, tax_lots: lots };
          }
        }
      }
    },
    afterPlacement: () => { void maintenance.request().catch(() => {}); },
  });
  const attributionSweep = createAttributionSweep(database, allocationCore, fill => orderWriter.link(fill));
  const allocationResume = createAllocationResume(database);
  // Planner (closes from the price store), executor (through the order writer),
  // member instructions, and the scheduler that keeps strategies on target with the window closed.
  const planner = createPlanner(database, { cryptoModel:cryptoModel.read, closes: (symbols, fromDay, query) => priceStore.closes(symbols, fromDay, query), taxLots: readTaxLots });
  const trading=createTradingService({
    coinbase:{
      review:async input=>({venue:'coinbase',review:await coinbaseOrders.preview(input)}),
      current:async id=>({venue:'coinbase',review:await coinbaseExecution.current(id)}),
      reserve:async id=>({venue:'coinbase',review:await coinbaseOrders.confirm(id)}),
      submit:async id=>({venue:'coinbase',review:await coinbaseExecution.submit(id)}),
      refresh:async id=>({venue:'coinbase',review:await coinbaseExecution.refresh(id)}),
      cancel:async id=>({venue:'coinbase',review:await coinbaseExecution.cancel(id)}),
    },
    robinhood:{
      review:async input=>{
        const selected=(await connections.status()).accounts.find(a=>a.selected&&a.agenticAllowed);
        if(!selected)throw new Error('Select an agentic account in Opentake');
        const result=await orderWriter.review({accountId:selected.id,order:input});
        return {venue:'robinhood',intent:result.intent,preview:result.review};
      },
      current:async id=>({venue:'robinhood',intent:await orderWriter.get(id),preview:null}),
      submit:async id=>{const intent=await orderWriter.get(id);return {venue:'robinhood',intent:await accountQueues.run([intent.accountId],()=>orderWriter.confirm(id),{label:'robinhood order'}),preview:null};},
      refresh:async id=>{
        const intent=await orderWriter.get(id),selected=(await connections.status()).accounts.find(a=>a.selected&&a.agenticAllowed);
        if(selected?.id!==intent.accountId)throw new Error('Select the order’s original account to refresh it.');
        await maintenance.request();
        return {venue:'robinhood',intent:await orderWriter.get(id),preview:null};
      },
    },
  });
  const cryptoTakeWriter=createCryptoTakeWriter(database,{enabled:()=>process.env.OPENTAKE_RH_CRYPTO!=='0'&&tradingEnabled()&&!quitting&&!settings.busy()&&!notificationSuspended&&net.isOnline(),session:(id,work)=>connections.cryptoSession(id,work)});
  const executor = lockedExecutor(createExecutor(database, { orderWriter:createTakeOrderWriter(database,{equity:orderWriter,crypto:cryptoTakeWriter}) }),accountQueues,
    async id=>(await database.use(db=>db.query<{account_id:string}>('SELECT account_id FROM strategy_allocations WHERE id=$1',[id]))).rows[0]?.account_id??null);
  const allocationInstructions = createAllocationInstructions(database, {core: allocationCore, connections, readEligibility:robinhoodEligibility, planner, executor});
  // Splits and share-count changes, read once a trading day before strategies plan.
  const shareEvents = createShareEventTracker(database, (name, args) => connections.readTool(name, args, undefined, AbortSignal.timeout(30_000)));
  const executionScheduler = createExecutionScheduler(database, { planner, executor, busy: () => connections.busy(), instructions: {
    async runDue() {
      const touched: string[] = [];
      for (const due of await allocationInstructions.dueInstructions(20)) {
        await allocationInstructions.runInstruction(due.allocationId, due.instructionId).catch(() => {diagnostics.record('background.failed',{venue:'robinhood',stage:'instructions'});});
        touched.push(due.allocationId);
      }
      await allocationInstructions.settleRedemptions().catch(() => {diagnostics.record('background.failed',{venue:'robinhood',stage:'redemptions'});});
      await allocationInstructions.settleClosures().catch(() => {diagnostics.record('background.failed',{venue:'robinhood',stage:'closures'});});
      return touched;
    },
  } });
  const cryptoOrderSync=createCryptoOrderSync(database,{session:(id,work)=>connections.cryptoSession(id,work),refreshCash:()=>portfolio.synchronize()});
  const synchronizeAndAttribute = () => synchronizeAndSettle(()=>portfolio.synchronize(),async()=>{
    const selected = (await connections.status()).accounts.find(a => a.selected && a.agenticAllowed);
    if (selected) {
      // Resolve intents first so this sync's fills link to the orders that caused them.
      await orderWriter.reconcile(selected.id, Date.now() - 5 * 60_000);
      await cryptoOrderSync.synchronize(selected.id);
      await executor.settleLegs(selected.id);
      await attributionSweep.run(selected.id);
      // Bind new strategy buys to the tax lots they created, so later sells can name them.
      await bindStrategyLots(database, allocationCore, readTaxLots, selected.id).catch(() => {diagnostics.record('background.failed',{venue:'robinhood',stage:'lots'});});
      // Imported takes bind the lots their hosted buys created (migration 43).
      await bindImportedLots(database, readTaxLots, selected.id).catch(() => {diagnostics.record('background.failed',{venue:'robinhood',stage:'import_lots'});});
    }
  });
  const mixedInvestments=createMixedInvestments(database,{
    enabled:()=>tradingEnabled()&&!quitting&&!settings.busy()&&!notificationSuspended&&net.isOnline(),
    refresh:(venue,accountId)=>venue==='coinbase'?coinbasePortfolio.refresh(accountId):synchronizeAndAttribute(),
    usdcRate:()=>coinbasePortfolio.prices.currentSpot('USDC-USD'),
    checkRobinhood:(accountId,symbols)=>allocationInstructions.checkTradability(accountId,symbols),
    coinbaseOrders,coinbaseInvestments,planner,executor,
  });
  const mixedWithdrawals=createMixedWithdrawals(database,mixedWithdrawalAdapters(database,{executor,
    enabled:()=>tradingEnabled()&&!quitting&&!settings.busy()&&!notificationSuspended&&net.isOnline(),
    instructions:allocationInstructions,capital:coinbaseCapital,orders:coinbaseOrders,execution:coinbaseExecution,rate:()=>coinbasePortfolio.prices.currentSpot('USDC-USD'),
  }));
  const maintenance = createMaintenance(database, connections, () => manualActions.busy() || settings.busy() || quitting, Date.now, Math.random, { ...portfolio, synchronize: synchronizeAndAttribute, engaged: () => Date.now()-portfolioUiSeenAt<30_000, continuous:()=>database.use(async db=>(await trackedRobinhoodAssets(db)).some(asset=>asset.identity.kind==='crypto')) }, { externalPolling: true,portfolioBackgroundAllowed:()=>selectedAccountPollDue('robinhood-account-sync') });
  const sourceDisplays = createSourceDisplays({
    market: symbol => marketFacts.detail(symbol),
    series: async (accountId,range,symbols) => (await coinbasePortfolio.accounts()).some(account=>account.id===accountId)
      ? coinbasePortfolio.series({accountId,range,...(symbols===undefined?{}:{symbols})})
      : portfolioSeries({accountId,range,...(symbols===undefined?{}:{symbols})}),
    coinbaseMarkets: coinbasePortfolio.markets,
    storedMarketPrice: market => database.use(db=>readStoredMarketPrice(db,market)),
  });
  // The member's lists, priced per venue on each read.
  const watchlists = createWatchlists(database, {
    robinhoodQuotesReady: async () => (await selectedAccountId()) !== null,
    coinbaseDetail: product => sourceDisplays.coinbaseDetail(product),
    robinhoodLists: {
      connectionId: async () => (await connections.status()).status === 'connected'
        ? (await database.use(db => db.query<{ id: string }>(`SELECT id FROM platform_connections WHERE venue='robinhood' AND owner_id=(SELECT id FROM local_owners LIMIT 1)`))).rows[0]?.id ?? null
        : null,
      read: (name, args) => connections.readTool(name, args, undefined, AbortSignal.timeout(20_000)),
      write: (name, args) => connections.watchlistWrite(name, args, AbortSignal.timeout(20_000)),
    },
    robinhoodCryptoQuotes: async symbols => (await connections.status()).status === 'connected'
      ? connections.readTool('get_crypto_quotes', { symbols }, undefined, AbortSignal.timeout(20_000))
      : null,
  });
  const managedSettings = createManagedSourceSettings(database);
  const accountPollGate=createAccountPollGate(managedSettings);
  function accountPollDue(id:ManagedPollSetting['id'],accountId:string){return accountPollGate.due(id,accountId);}
  async function selectedAccountPollDue(id:ManagedPollSetting['id']){
    const account=(await database.use(db=>db.query<{id:string}>(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE c.venue='robinhood' AND c.status='connected' AND a.selected AND a.available AND a.agentic_allowed LIMIT 1`))).rows[0];
    return account?accountPollDue(id,account.id):false;
  }
  const managedPolls = createManagedPolls([
    { id: 'robinhood-account-sync', intervalMs: FILL_WATCH_MS, run: () => maintenance.tick() },
    { id: 'coinbase-account-sync', intervalMs: FILL_WATCH_MS, run: () => coinbasePortfolio.tick() },
    { id: 'robinhood-earnings', intervalMs: 30_000, run: async () => { try { if(await selectedAccountPollDue('robinhood-earnings'))await earningsCalendar.tick(); } catch { diagnostics.record('background.failed',{venue:'robinhood',stage:'earnings_calendar'}); } } },
    { id: 'robinhood-prices', intervalMs: 30_000, run: async () => {
      if(!await selectedAccountPollDue('robinhood-prices'))return;
      if (!priceWork) priceWork = priceStore.tick(Date.now()-portfolioUiSeenAt<30_000).catch(error => {diagnostics.record('background.failed',{stage:'prices',...(error instanceof PriceRefreshFailure?error.details:{venue:'robinhood',errorCode:'unknown'})});}).finally(() => { priceWork = undefined; });
      await priceWork;
    } },
  ], () => !notificationSuspended && !settings.busy() && !quitting && net.isOnline());
  async function shutdown() {
    if (quitting) return;
    quitting = true;
    sourceDisplays.close();
    maintenance.suspend(); coinbasePortfolio.suspend(); void coinbase.cancel().catch(() => {});
    const managedPollShutdown = managedPolls.close();
    coinbaseHoldings.close();
    coinbaseStream.close();
    const streamPriceShutdown=streamPriceWriter.close();
    const valuationShutdown=valuationSnapshots.close();
    const ruleShutdown=ruleRunner.close();
    const dataSourceShutdown = ruleShutdown.then(()=>dataSources.close()); // Stop admission immediately, drain writes before closing DB.
    eligibilityRefresh.invalidate();
    search.clear();
    clearInterval(networkTimer);
    clearInterval(notificationTimer); clearInterval(eventLoopTimer);
    // Stop starting work and abort what runs; durable state lets it resume next launch.
    const executionShutdown=Promise.all([executionLoops?.close(5_000),accountQueues.close(5_000)]);
    const deadline = setTimeout(() => { diagnostics.record('database.close_failed'); app.exit(1); }, 10_000);
    try {
      await streamPriceShutdown;
      await valuationShutdown;
      await dataSourceShutdown;
      await managedPollShutdown;
      await notifications.stop(); nativeNotifications.close();
      await executionShutdown; await priceWork;
      await mixedWithdrawals.close(); await coinbase.close(); await mixedInvestments.close(); await coinbaseInvestments.close(); await coinbaseExecution.close(); await coinbasePortfolio.close(); await manualActions.cancel(); connections.cancel(); await maintenance.stop(); await searchAgent.close(); await takes.close(); await rpc?.close(false);
      await grokAccess.close(); await mcp.close(); await ai.close(); await connections.close(); await settings.flush(); await database.close();
      await rpc?.unpublish();
      if (updateNonce) await atomicPrivateWrite(join(profile, 'update-shutdown.json'), Buffer.from(JSON.stringify({ nonce: updateNonce, pid: process.pid })));
      app.releaseSingleInstanceLock();
      diagnostics.record('database.closed'); clearTimeout(deadline); tray?.destroy(); app.exit(0);
    } catch { diagnostics.record('database.close_failed'); clearTimeout(deadline); app.exit(1); }
  }
  app.on('before-quit', event => { event.preventDefault(); void shutdown(); });
  app.on('window-all-closed', () => {});
  process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
  process.on('uncaughtException', () => { diagnostics.record('app.fatal'); void shutdown(); });
  process.on('unhandledRejection', () => { diagnostics.record('app.fatal'); void shutdown(); });
  // Reopening Opentake while only the host runs activates the host, and macOS then shows its
  // Dock icon beside the new window's. The host has no windows, so hide it again.
  app.on('activate', () => { if (ready && !quitting) launchDesktop(profile); app.dock?.hide(); });
  void app.whenReady().then(async () => {
    app.dock?.hide(); await privateDirectory(profile); await database.start(); const streamSource=await coinbaseSourceSettings.load();coinbaseStream.configure({revision:streamSource.revision,enabled:streamSource.enabled,collection:streamSource.config.collection,subscriptions:streamSource.config.provider!.subscriptions,priceMappings:streamSource.config.provider!.priceMappings}); await dataSources.start(); await coinbaseExecution.start(); await coinbasePortfolio.start(); await takes.start(); await mcp.start(); await platformAccess.start();
    diagnostics.record('database.ready'); if (quitting) return; await cryptoDustPolicy.load(); coinbaseHoldings.start(); streamPriceWriter.start(); valuationSnapshots.start(); ruleRunner.start();
    rpc = await startHostRpc(profile, build, (method, args, clientId) => accountQueues.member(async () => {
      if (quitting) throw new Error('Host stopping');
      if (method === 'dataSources:inventory') { if (args.length) throw Error('Invalid data source request'); return dataSourceInventory(); }
      if (method === 'dataSources:configure' && args.length === 1 && args[0] && typeof args[0] === 'object') {
        const request = args[0] as {action?: string};
        if(request.action==='rule-evidence-list'||request.action==='rule-evidence-read')return ruleRunner.evidence(request);
        if(request.action==='rule-shadow-status'){const input=z.object({action:z.literal('rule-shadow-status'),takeId:z.uuid()}).strict().parse(request);return ruleRunner.inspect(input.takeId);}
        if(request.action==='rule-shadow-configure'){const input=z.object({action:z.literal('rule-shadow-configure'),setting:z.unknown()}).strict().parse(request);return ruleRunner.configure(input.setting);}
        if(request.action==='rule-review'||request.action==='rule-message-proposals'||request.action==='rule-proposal-decide'||request.action==='rule-set-enabled'||request.action==='rule-remove'||request.action==='rule-activity'||request.action==='rule-trade-approvals'||request.action==='rule-trade-decide'){const input=ruleReviewRequest.parse(request);
          if(input.action==='rule-trade-approvals')return ruleTradeApprovals.list(input.takeId);
          if(input.action==='rule-trade-decide')return ruleTradeApprovals.decide(input.takeId,input.requestId,input.approve);
          if(input.action==='rule-review')return ruleProposals.read(input.takeId);
          if(input.action==='rule-message-proposals')return ruleProposals.message(input.messageId);
          if(input.action==='rule-proposal-decide')return ruleProposals.decide(input.id,input.decision);
          if(input.action==='rule-set-enabled')return ruleProposals.setRuleEnabled(input.takeId,input.ruleId,input.enabled);
          if(input.action==='rule-activity')return ruleProposals.activity(input.takeId,input.ruleId);
          // Deleting a rule first cancels what it started that has not gone out: trade
          // reviews release their reservations; a running agent is stopped. Filled orders stay.
          const open=(await database.use(db=>db.query<{id:string}>(`SELECT j.id FROM action_jobs j JOIN strategy_rule_action_requests r ON r.id=j.origin_id
           WHERE j.origin='rule' AND r.take_id=$1 AND r.rule_id=$2 AND j.state IN ('queued','running','waiting')`,[input.takeId,input.ruleId]))).rows;
          for(const job of open)await actionJobs.cancel(job.id);
          return ruleProposals.removeRule(input.takeId,input.ruleId);
        }
        if(request.action==='rule-drafts-load'||request.action==='rule-drafts-preview'){
          const input=z.object({action:z.enum(['rule-drafts-load','rule-drafts-preview']),takeId:z.uuid()}).strict().parse(request);
          return input.action==='rule-drafts-load'?ruleDrafts.load(input.takeId):ruleDrafts.preview(input.takeId);
        }
        if(request.action==='rule-drafts-save'){const input=z.object({action:z.literal('rule-drafts-save'),setting:z.unknown()}).strict().parse(request);return ruleDrafts.save(input.setting);}
        if(request.action==='take-inputs-load'||request.action==='take-inputs-snapshot'){
          const input=z.object({action:z.enum(['take-inputs-load','take-inputs-snapshot']),takeId:z.uuid()}).strict().parse(request);
          return input.action==='take-inputs-load'?takeInputs.load(input.takeId):takeInputs.snapshot(input.takeId);
        }
        if(request.action==='take-inputs-save'){const input=z.object({action:z.literal('take-inputs-save'),setting:z.unknown()}).strict().parse(request);return takeInputs.save(input.setting);}

        if(request.action==='coinbase-account-source'){
          const input=z.object({action:z.literal('coinbase-account-source'),accountId:z.uuid()}).strict().parse(request);return coinbaseAccountSettings.load(input.accountId);
        }
        if(request.action==='coinbase-account-save'){
          const input=z.object({action:z.literal('coinbase-account-save'),setting:z.unknown()}).strict().parse(request);
          if(coinbasePortfolio.busy())throw Error('Account sync is running; retry after it finishes');
          return coinbaseAccountSettings.save(input.setting);
        }
        if (request.action === 'managed-list') { const input=z.object({action:z.literal('managed-list'),accountId:z.uuid().optional()}).strict().parse(request); return managedSettings.list(input.accountId); }
        if (request.action === 'managed-save') {
          const input = z.object({action:z.literal('managed-save'),setting:z.unknown()}).strict().parse(request);
          const saved = await managedSettings.save(input.setting);
          // Revision comparisons keep concurrent saves from rolling the active policy back.
          if(saved.accountId)accountPollGate.changed(saved.id,saved.accountId);
          return saved;
        }
      }
      if (method === 'dataSources:stream') {
        if (args.length !== 1) throw Error('Invalid stream request');
        if(args[0]&&typeof args[0]==='object'&&'action' in args[0]&&args[0].action==='dust-policy'){
          const request=z.object({action:z.literal('dust-policy'),policy:z.unknown()}).strict().parse(args[0]);
          await cryptoDustPolicy.save(request.policy);void coinbaseHoldings.tick();return null;
        }
        if(args[0]&&typeof args[0]==='object'&&'action' in args[0]){
          if(args[0].action==='inspect-mappings'){z.object({action:z.literal('inspect-mappings')}).strict().parse(args[0]);const inspection=coinbaseStream.dispatch({action:'inspect'},clientId) as import('../shared/coinbase-stream').CoinbaseStreamInspection;return inspectPriceMapping(inspection.messages);}
          if(args[0].action==='preview-mappings'){const input=z.object({action:z.literal('preview-mappings'),config:z.unknown()}).strict().parse(args[0]);const inspection=coinbaseStream.dispatch({action:'inspect'},clientId) as import('../shared/coinbase-stream').CoinbaseStreamInspection;return coinbaseSourceSettings.preview(input.config,inspection.messages);}
          if(args[0].action==='source'){z.object({action:z.literal('source')}).strict().parse(args[0]);return coinbaseSourceSettings.get();}
          if(args[0].action==='save-source'){
            const input=z.object({action:z.literal('save-source'),revision:z.number().int().positive(),config:z.unknown()}).strict().parse(args[0]);
            const saved=await coinbaseSourceSettings.save({revision:input.revision,config:input.config});
            const active=coinbaseSourceSettings.get();coinbaseStream.configure({revision:active.revision,enabled:active.enabled,collection:active.config.collection,subscriptions:active.config.provider!.subscriptions,priceMappings:active.config.provider!.priceMappings});
            coinbaseHoldings.invalidate();await coinbaseHoldings.tick();return saved;
          }
        }
        return coinbaseStream.dispatch(args[0], clientId);
      }
      if (method === 'dataSources:drop-client' && args.length === 0) coinbaseStream.dropClient(clientId);
      if (method.startsWith('dataSources:')) return dataSources.dispatch(method, args, clientId);
      if (method.startsWith('coinbase:')) {
        if (['coinbase:import-key','coinbase:refresh','coinbase:disconnect'].includes(method)) { sourceDisplays.invalidate(); eligibilityRefresh.invalidate(); }
        if (method === 'coinbase:cancel') { await coinbase.cancel(); return null; }
        if (settings.busy()) return { ok: false, message: 'Database maintenance is in progress.' };
        try {
          if (method === 'coinbase:import-progress') return coinbase.importProgress();
          if (method === 'coinbase:list') return { ok: true, connections: await coinbase.list() };
          if (method === 'coinbase:import-key') {
            const connected = await coinbase.importKey(args[0], args[1]);
            void coinbasePortfolio.tick().catch(() => {});
            return { ok: true, connections: connected };
          }
          if (method === 'coinbase:refresh') return { ok: true, connections: await coinbase.refresh(args[0]) };
          if (method === 'coinbase:rename') return { ok: true, connections: await coinbase.rename(args[0], args[1]) };
          if (method === 'coinbase:disconnect') return { ok: true, connections: await coinbase.disconnect(args[0]) };
          throw new Error('Unknown Coinbase operation');
        } catch (error) { return { ok: false, message: coinbaseError(error).message }; }
      }
      if (method.startsWith('search:agent:')) {
        if (settings.busy() || quitting) throw new Error('Search is unavailable during database maintenance.');
        if (['search:agent:export-backup', 'search:agent:preview-backup', 'search:agent:import-backup', 'search:agent:preview-recovery', 'search:agent:confirm-recovery'].includes(method)) {
          try {
            if (method === 'search:agent:export-backup') return { value: await searchAgent.exportBackup() };
            if (method === 'search:agent:preview-backup') return { value: await searchAgent.previewBackup(args[0], clientId) };
            if (method === 'search:agent:import-backup') return { value: await searchAgent.importBackup(args[0], clientId) };
            if (method === 'search:agent:preview-recovery') return { value: await searchAgent.previewRecovery(clientId) };
            return { value: await searchAgent.confirmRecovery(args[0], clientId) };
          } catch (error) {
            return { error: error instanceof SearchMaintenanceError ? error.message : 'Search maintenance failed. Check the selected Robinhood account and try again.' };
          }
        }
        if (method === 'search:agent:saved') return searchAgent.saved();
        if (method === 'search:agent:save') return searchAgent.save(args[0], args[1], clientId, args[2]);
        if (method === 'search:agent:remove-saved') return searchAgent.removeSaved(args[0]);
        if (method === 'search:agent:replay') return searchAgent.replay(args[0], clientId);
        if (method === 'search:agent:start') return searchAgent.start(args[0], clientId);
        if (method === 'search:agent:snapshot') return searchAgent.snapshot(args[0], clientId);
        if (method === 'search:agent:stop') return searchAgent.stop(args[0], clientId);
        if (method === 'search:agent:decide') return searchAgent.decide(args[0], args[1], args[2], clientId);
        throw new Error('Unknown search operation');
      }
      if (method.startsWith('search:')) {
        if (settings.busy()) throw new Error('Database busy');
        if (method === 'search:sources') return search.sources();
        if (method === 'search:start') return search.start(args[0], clientId);
        if (method === 'search:snapshot') return search.snapshot(args[0], clientId);
        if (method === 'search:cancel') return search.cancel(args[0], clientId);
        if (method === 'search:resolve') return search.resolve(args[0]);
        throw new Error('Unknown search operation');
      }
      if (method === 'notifications:act') {if(settings.busy())throw new Error('Database busy');await notifications.act(args[0],args[1]);return null;}
      if (method === 'notifications:list') return notifications.list(args[0]);
      if (method === 'notifications:seen') { await notifications.markSeen(args[0]); return null; }
      if (method === 'notifications:target') return notifications.target(args[0]);
      if (method === 'notifications:navigation') return notifications.navigation();
      if (method === 'notifications:acknowledge') { await notifications.acknowledge(args[0]); return null; }
      if (method === 'notifications:presence') { notifications.presence(clientId, args[0] === true); return notificationUnreadCount; }
      if (method.startsWith('gateway:') && searchAgent.has(String(args[0]))) return searchAgent.gateway(method, String(args[0]), String(args[1]), args[2]);
      if(method==='gateway:instructions') return mcp.instructions(String(args[0]));
      if(method==='gateway:list') return mcp.catalog(String(args[0]));
      if(method==='gateway:call') return mcp.call(String(args[0]),String(args[1]),args[2]);
      // The member's answer to chat's tool request; its own reasons are shown, nothing else.
      if(method==='mcp:tool-access-decide'){try{return await toolAccess.decide(z.uuid().parse(args[0]),args[1]);}catch(error){return {error:error instanceof ToolAccessError?error.message:'Could not save your answer. Try again.'};}}
      if(method.startsWith('mcp:')) { try {
        if(method==='mcp:platform-settings')return await platformAccess.settings();
        if(method==='mcp:platform-configure')return await platformAccess.configure(args[0]);
        if(method==='mcp:platform-pending')return await platformAccess.pending();
        if(method==='mcp:platform-decide')return await platformAccess.decide(args[0],args[1]);
        if(method==='mcp:server-policy')return await mcp.serverPolicy(args[0],args[1]);
        if(method==='mcp:trust-updates')return await mcp.trustUpdates(args[0],args[1]);
        if(method==='mcp:take-permissions')return await mcp.takePermissions(args[0]);
        if(method==='mcp:set-take-permission')return await mcp.setTakePermission(args[0],args[1],args[2],args[3]);
        if(method==='mcp:history')return await mcp.history(args[0]);
        if(method==='mcp:metadata-history')return await mcp.metadataHistory(args[0],args[1]);
        if(method==='mcp:metadata-revision')return await mcp.metadataRevision(args[0]);
        if(method==='mcp:oauth-status')return await mcp.oauthStatus(args[0]);
        if(method==='mcp:oauth-start')return await mcp.oauthStart(args[0]);
        if(method==='mcp:oauth-cancel')return await mcp.oauthCancel(args[0]);
        if(method==='mcp:oauth-disconnect')return await mcp.oauthDisconnect(args[0]);
        if(method==='mcp:list')return await mcp.list();
        if(method==='mcp:save')return await mcp.save(args[0],args[1]);
        if(method==='mcp:enable')return await mcp.enable(args[0],args[1]);
        if(method==='mcp:remove')return await mcp.remove(args[0]);
        if(method==='mcp:discover')return await mcp.discover(args[0]);
        if(method==='mcp:policy')return await mcp.policy(args[0],args[1],args[2]);
        if(method==='mcp:approvals')return await mcp.approvals();
        if(method==='mcp:decide')return await mcp.decide(args[0],args[1]);
        if(method==='mcp:tool-access-requests')return await toolAccess.forMessage(args[0]);
      }catch {return {error:'Could not complete the MCP action. Check configuration, connection, and credentials.'};} }
      if(method.startsWith('strategies:')){
        if(settings.busy())return {error:'Database maintenance is in progress.'};
        try{
          if(method==='strategies:coinbase-orders')return await coinbaseExecution.current(z.uuid().parse(args[0]));
          if(method==='strategies:preview-coinbase-orders')return await coinbaseOrders.preview(args[0]);
          if(method==='strategies:submit-coinbase-orders')return await coinbaseExecution.submit(z.uuid().parse(args[0]));
          if(method==='strategies:refresh-coinbase-orders')return await coinbaseExecution.refresh(z.uuid().parse(args[0]));
          if(method==='strategies:confirm-coinbase-orders')return await coinbaseOrders.confirm(z.uuid().parse(args[0]));
          if(method==='strategies:cancel-coinbase-orders')return await coinbaseExecution.cancel(z.uuid().parse(args[0]));
          if(method==='strategies:coinbase-investment')return await coinbaseInvestments.current(z.uuid().parse(args[0]));
          if(method==='strategies:invest-coinbase')return await coinbaseInvestments.invest(args[0]);
          if(method==='strategies:act-coinbase-investment'){const id=z.uuid().parse(args[0]),action=z.enum(['continue','confirm','cancel','refresh']).parse(args[1]);return action==='continue'||action==='confirm'?await coinbaseInvestments.continue(id,action==='confirm'):await coinbaseInvestments[action](id);}
          if(method==='strategies:save-coinbase-risk')return await coinbaseCapital.saveRisk(args[0]);
          if(method==='strategies:coinbase-withdrawal-band')return await coinbaseOrders.withdrawalBand(args[0]);
          if(method==='strategies:coinbase-preflight')return await coinbasePreflight(args[0]);
          if(method==='strategies:coinbase-lifecycle'){const id=z.uuid().parse(args[0]);if(z.boolean().nullish().parse(args[1])){const current=await coinbaseLifecycle.view(id);await coinbasePortfolio.refresh(current.accountId);}return await coinbaseLifecycle.view(id);}
          if(method==='strategies:decide-coinbase-lifecycle')return await coinbaseLifecycle.decide(args[0] as never);
          if(method==='strategies:coinbase-capital')return await coinbaseCapital.view(z.uuid().parse(args[0]),true);
          if(method==='strategies:preview-coinbase-capital')return await coinbaseCapital.preview(args[0]);
          if(method==='strategies:confirm-coinbase-capital')return await coinbaseCapital.confirm(z.uuid().parse(args[0]));
          if(method==='strategies:mixed-withdrawal-limits')return await mixedWithdrawals.limits(z.uuid().parse(args[0]),z.enum(['USD','USDC']).parse(args[1]));
          if(method==='strategies:mixed-withdrawal-preview')return await mixedWithdrawals.preview(args[0]);
          if(method==='strategies:mixed-withdrawal-end')return await mixedWithdrawals.end(z.uuid().parse(args[0]));
          if(method==='strategies:mixed-withdrawal-confirm')return await mixedWithdrawals.confirm(z.uuid().parse(args[0]));
          if(method==='strategies:mixed-withdrawal')return await mixedWithdrawals.current(z.uuid().parse(args[0]));
          if(method==='strategies:mixed-preview')return await mixedInvestments.preview(args[0]);
          if(method==='strategies:mixed-invest')return await mixedInvestments.invest(args[0]);
          if(method==='strategies:mixed-investment')return await mixedInvestments.current(z.uuid().parse(args[0]));
          if(method==='strategies:account-plan')return await takeAccountPlans.read(z.uuid().parse(args[0]));
          if(method==='strategies:save-account-plan')return await takeAccountPlans.save(args[0]);
          if(method==='strategies:overview')return await takeOverview(args[0]===true);
          if(method==='strategies:list')return await strategies.list(args[0]===true);
          if(method==='strategies:source')return await strategies.source(z.uuid().parse(args[0]));
          if(method==='strategies:history')return await strategies.history(z.uuid().parse(args[0]),z.number().int().positive().parse(args[1]));
          if(method==='strategies:read')return await strategies.read(z.uuid().parse(args[0]));
          if(method==='strategies:propose')return await strategies.propose(args[0]);
          if(method==='strategies:use-revision')return await strategies.useRevision(args[0]);
          if(method==='strategies:dismiss-suggestion')return await strategies.dismissSuggestion(args[0]);
          if(method==='strategies:commit')return await strategies.commit(args[0]);
          if(method==='strategies:verify')return await strategies.verify(z.uuid().parse(args[0]));
          if(method==='strategies:commit-review')return await strategies.commitReview(z.uuid().parse(args[0]));
          if(method==='strategies:performance')return await strategyPerformance.performance(args[0],args[1],args[2]);
          if(method==='strategies:markers')return await strategyPerformance.markers(args[0],args[1]);
          if(method==='strategies:message-proposals')return await strategies.messageProposals(z.uuid().parse(args[0]));
          if(method==='strategies:available'){
            const takeId=z.uuid().parse(args[0]),profileId=args[1]?z.uuid().parse(args[1]):null;
            const tools=await mcp.policySnapshot(takeId);
            const profile=(await database.use(db=>profileId?db.query<{published:{config:{tools:string[]|null}}}>('SELECT published FROM ai_instruction_profiles WHERE id=$1',[profileId]):db.query<{published:{config:{tools:string[]|null}}}>("SELECT published FROM ai_instruction_profiles WHERE builtin='general'"))).rows[0];
            return tools.some(t=>t.name==='opentake_propose_strategy'&&(!profile?.published?.config.tools||profile.published.config.tools.includes(t.server+'/'+t.name)));
          }
          throw new Error('Unknown take action.');
        }catch(error){return {error:error instanceof Error?error.message.slice(0,500):'Strategy action failed.'};}
      }
      if (method.startsWith('takes:')) {
        if (settings.busy()) return { error: 'Database maintenance is in progress.' };
        try {
          if(method==='takes:messages-page')return await takes.messagesPage(args[0],args[1]);
          if(method==='takes:takes-page')return await takes.takesPage(args[0],args[1]);
          if(method==='takes:message-versions')return await takes.messageVersions(args[0],args[1],args[2]);
          if(method==='takes:budgets')return await takes.budgets();
          if(method==='takes:save-budgets')return await takes.saveBudgets(args[0]);
          if(method==='takes:automatic-limits')return await takes.automaticLimits();
          if(method==='takes:save-automatic-limits')return await takes.saveAutomaticLimits(args[0]);
          if(method==='takes:usage-history')return await takes.usageHistory(args[0],args[1]);
          if (method === 'takes:snapshot') return await takes.snapshot(args[0],args[1],args[2]);
          if (method === 'takes:create') return await takes.create();
          if (method === 'takes:export-data') return await exportTake(database, strategies, z.uuid().parse(args[0]));
          if (method === 'takes:import-data') return { takeId: await importTake(database, strategies, args[0], () => takes.changed()) };
          if (method === 'takes:update') return await takes.update(args[0],args[1]);
          if (method === 'takes:remove') { await takes.remove(args[0]); await documents.collect(); return; }
          if (method === 'takes:send') return await takes.send(args[0]);
          if (method === 'takes:stop') return await takes.stop(args[0]);
          if (method === 'takes:publish-instruction-profile') return await takes.publishInstructionProfile(args[0]);
          if (method === 'takes:instruction-versions') return await takes.instructionVersions(args[0]);
          if (method === 'takes:instruction-profiles') return await takes.instructionProfiles();
          if (method === 'takes:save-instruction-profile') return await takes.saveInstructionProfile(args[0]);
          if (method === 'takes:remove-instruction-profile') return await takes.removeInstructionProfile(args[0]);
          if (method === 'takes:instructions') return await takes.instructions();
          if (method === 'takes:save-about') return await takes.saveAbout(args[0]);
          if (method === 'takes:restore-default-instructions') return await takes.restoreDefaultInstructions(args[0]);
          if (method === 'takes:image') return await takes.image(String(args[0]));
          if (method === 'takes:document') return await documents.action(String(args[0]),args[1]);
          if (method === 'takes:upload') { const image=await prepareImage(args[1],args[2]); return await takes.storeImage(String(args[0]),image.metadata,image.base64); }
          throw new Error('Unknown chat action.');
        } catch (error) { return {error: error instanceof Error && !error.message.startsWith('[') ? error.message.slice(0,250) : 'Could not complete this chat action.'}; }
      }
      if (method === 'chat:models') return models(args[0], args[1] === true);
      if (method === 'ai:grok-test') return grokAccess.test();
      if (method === 'ai:grok-test-cancel') { await grokAccess.cancel(); return null; }
      if (method === 'ai:status') return aiStatus();
      if (method === 'ai:check-opencode') { await Promise.all([opencode.checkInstallation(), openRouter.checkInstallation(), localModels.checkInstallation()]); return null; }
      if (method === 'ai:use-credential') return opencode.select(args[0]);
      if (method === 'ai:use-openrouter-credential') return openRouter.select(args[0]);
      if (method === 'ai:connect-local') return localModels.connect(args[0]);
      if (method === 'ai:disconnect') { if (args[0] === 'grok') await grokAccess.cancel(); if (args[0] === 'opencode') await opencode.disconnect(); else if (args[0] === 'openrouter') await openRouter.disconnect(); else if (args[0] === 'local') await localModels.disconnect(); else await ai.disconnect(args[0]); return null; }
      if (method === 'ai:start') { if (args[0] === 'grok') await grokAccess.cancel(); return ai.start(args[0]); }
      if (method === 'ai:submit-code') { ai.submitCode(args[0], args[1]); return null; }
      if (method === 'ai:cancel') { await ai.cancel(); return null; }
      if (method === 'ai:reopen') { await ai.reopen(); return null; }
      if (method === 'host:status') return { pid: process.pid, protocol: 1, build };
      if (method === 'host:shutdown') { setTimeout(() => void shutdown(), 50); return null; }
      if (method === 'host:prepare-update') {
        const nonce = z.string().uuid().parse(args[0]);
        if (settings.busy() || takes.busy() || manualActions.busy() || connections.busy() || coinbase.busy() || coinbasePortfolio.busy() || coinbaseExecution.busy() || coinbaseInvestments.busy() || mixedInvestments.busy() || mixedWithdrawals.busy() || executionLoops?.running() || accountQueues.busy()) throw new Error('Finish active work before updating');
        updateNonce = nonce;
        void shutdown();
        return null;
      }
      if (method === 'host:wake') { void maintenance.wake().catch(() => {}); return null; }
      if (method === 'activity:details') return database.use(db => readJobDetails(db, args[0]));
      if (method === 'activity:list') return maintenance.list();
      if (method === 'activity:history') return database.use(db => readJobHistory(db, args[0]));
      if (method === 'activity:retry') { if (settings.busy()) throw new Error('Database busy'); await maintenance.retry(args[0]); return null; }
      if (method.startsWith('settings:')) {
        if (method === 'settings:import') { const source=await coinbaseSourceSettings.load();coinbaseStream.configure({revision:source.revision,enabled:source.enabled,collection:source.config.collection,subscriptions:source.config.provider!.subscriptions,priceMappings:source.config.provider!.priceMappings});coinbaseHoldings.invalidate();coinbaseStream.suspend(); if (!notificationSuspended && net.isOnline()) coinbaseStream.resume(); sourceDisplays.invalidate(); eligibilityRefresh.invalidate(); search.clear(); await searchAgent.cancelAll(); }
        if (method === 'settings:credentials:save' || method === 'settings:credentials:remove') {
          dataSources.invalidateCredentials();
          try { return await settings.invoke(method, args, clientId); }
          finally { dataSources.invalidateCredentials(); }
        }
        return settings.invoke(method, args, clientId);
      }
      if (method === 'connections:cancel') { await manualActions.cancel(); return null; }
      if (method === 'connections:reopen') { await connections.reopenSignIn(); return null; }
      if (method === 'portfolio:series') return sourceDisplays.series(args[0],args[1],args[2]);
      if (method === 'portfolio:strategy-history') return allocationHistory(args[0],args[1]);
      if (method === 'markets:coinbase:detail') return sourceDisplays.coinbaseDetail(args[0],args[1]);
      if (method === 'markets:coinbase:series') return sourceDisplays.coinbaseSeries(args[0],args[1]);
      if (method === 'portfolio:research') {
        const input = z.object({ tool: z.enum(marketResearchTools), arguments: z.record(z.string(), z.unknown()) }).strict().parse(args[0]);
        return connections.readTool(input.tool, input.arguments, undefined, AbortSignal.timeout(20_000));
      }
      if (method === 'portfolio:market') return sourceDisplays.market(args[0]);
      if (method === 'portfolio:logo') return marketFacts.logo(args[0]);
      if (method === 'portfolio:fundamentals') return Object.fromEntries(await marketFacts.fundamentals(args[0]));
      if (method === 'portfolio:search') return marketFacts.search(args[0]);
      if (method === 'watchlists:lists') return watchlists.lists();
      if (method === 'watchlists:items') return watchlists.items(args[0] as never, args[1] as never, args[2] as never);
      if (method === 'watchlists:membership') return watchlists.membership(args[0] as never);
      if (method === 'watchlists:sync') return watchlists.sync(args[0] === true);
      if (method === 'watchlists:sync-items') return watchlists.syncItems(args[0] as never, args[1] === true);
      if (method === 'watchlists:create') return watchlists.create(args[0] as never);
      if (method === 'watchlists:rename') return watchlists.rename(args[0] as never, args[1] as never);
      if (method === 'watchlists:remove') return watchlists.remove(args[0] as never);
      if (method === 'watchlists:add-item') return watchlists.addItem(args[0] as never, args[1] as never);
      if (method === 'watchlists:remove-item') return watchlists.removeItem(args[0] as never, args[1] as never);
      if (method === 'watchlists:move') return watchlists.move(args[0] as never, args[1] as never);
      if (method === 'watchlists:move-item') return watchlists.moveItem(args[0] as never, args[1] as never, args[2] as never);
      if (method === 'orders:execute') {if(settings.busy()||quitting)throw new Error('Database busy');try{return await trading.execute(args[0]);}finally{await createOrderActivity(database).sync().catch(()=>{});}}
      if (method === 'orders:status') return { enabled: tradingEnabled() };
      if (method.startsWith('orders:')) {
        if (settings.busy()) throw new Error('Database busy');
        const selected = (await connections.status()).accounts.find(a => a.selected && a.agenticAllowed);
        if (!selected) throw new Error('Select an agentic account in Opentake');
        if (method === 'orders:list') return orderWriter.list(selected.id);
        if (method === 'orders:review') return orderWriter.review({ accountId: selected.id, order: args[0] });
        if (method === 'orders:confirm') return orderWriter.confirm(z.uuid().parse(args[0]));
        if (method === 'orders:abandon') return orderWriter.abandon(z.uuid().parse(args[0]));
        throw new Error('Unknown operation');
      }
      if (method.startsWith('allocations:')) {
        if (settings.busy()) throw new Error('Database busy');
        // Member instructions answer in the panel's shapes; writes as { ok, status, body | message, code }.
        const id = () => z.uuid().parse(args[0]);
        const read = async <T,>(work: () => Promise<T>, wrap: (value: T) => Record<string, unknown>) => {
          try { return { status: 200, ...wrap(await work()) }; } catch (error) { return { status: error instanceof InstructionNotFound ? 404 : 409, message: error instanceof Error ? error.message : 'Failed' }; }
        };
        const listed = async <T,>(work: () => Promise<T>, key: string) => {
          try { return { ok: true, [key]: await work() }; } catch (error) { return { ok: false, status: 409, message: error instanceof Error ? error.message : 'Failed' }; }
        };
        if (method === 'allocations:version-review') return database.use(db=>readVersionReview(db,id()));
        if (method === 'allocations:adopt-version') return database.use(db=>db.transaction(tx=>adoptVersion(tx,id(),z.uuid().parse(args[1]),z.uuid().parse(args[2]))));
        if (method === 'allocations:holdings') return allocationInstructions.holdings();
        if (method === 'allocations:create') return authorResult(() => allocationInstructions.create(z.object({ strategyId: z.uuid(), financialAccountId: z.uuid(), allocationValue: z.string() }).parse(args[0])));
        if (method === 'allocations:update') return authorResult(() => allocationInstructions.update(id(), z.object({ status: z.enum(['active', 'paused', 'detached']).optional() }).parse(args[1] ?? {})));
        if (method === 'allocations:deposit') return authorResult(() => allocationInstructions.deposit(id(), z.string().parse(args[1])));
        if (method === 'allocations:redemption-preview') return read(() => allocationInstructions.redemptionPreview(id(), z.string().parse(args[1])), redemption => ({ redemption }));
        if (method === 'allocations:redeem') return authorResult(() => allocationInstructions.redeem(id(), z.string().parse(args[1])));
        if (method === 'allocations:instructions') return allocationInstructions.instructions(id()).catch(() => ({ status: 404, instructions: [] }));
        if (method === 'allocations:cancel-instruction') return authorResult(() => allocationInstructions.cancelInstruction(id(), z.uuid().parse(args[1])));
        if (method === 'allocations:confirm-instruction') return authorResult(() => allocationInstructions.confirmInstruction(id(), z.uuid().parse(args[1])));
        if (method === 'allocations:abandon-order') return authorResult(() => allocationInstructions.abandonUnknownOrder(id(), z.uuid().parse(args[1])));
        if (method === 'allocations:resolve-outside-sale') return authorResult(() => allocationInstructions.resolveOutsideSale(id(), z.enum(['keep', 'detach']).parse(args[1])));
        if (method === 'allocations:close') return authorResult(() => allocationInstructions.close(id(), z.union([z.enum(['none', 'all']), z.array(z.string().max(16)).max(50)]).parse(args[1])));
        if (method === 'allocations:plan') return authorResult(() => allocationInstructions.plan(id()));
        if (method === 'allocations:preflight') return read(() => allocationInstructions.preflight(z.union([z.object({ strategyId: z.uuid() }).strict(), z.object({ bucketId: z.uuid() }).strict()]).parse(args[0]), z.string().parse(args[1])), preflight => ({ preflight }));
        if (method === 'allocations:activity') return allocationInstructions.activity(z.uuid().parse(args[0]), z.number().int().min(1).max(100).optional().parse(args[1]), z.string().nullable().optional().parse(args[2]) ?? null);
        if (method === 'allocations:queue-list') return listed(() => allocationInstructions.queueList(), 'items');
        if (method === 'allocations:queue-act') return listed(() => allocationInstructions.queueAct(z.string().max(200).parse(args[0]), z.enum(['cancel', 'confirm']).parse(args[1])), 'items');
        if (method === 'allocations:trading-preferences') return listed(() => allocationInstructions.tradingPreferences(), 'preferences');
        if (method === 'allocations:set-trading-preferences') return listed(() => allocationInstructions.setTradingPreferences(z.object({ confirmTrades: z.boolean().optional(), blockedSymbols: z.array(z.string().max(16)).max(200).optional() }).strict().parse(args[0])), 'preferences');
        const allocationId = id();
        if (method === 'allocations:review') return allocationResume.review(allocationId);
        if (method === 'allocations:resume') return allocationResume.resume(allocationId);
        if (method === 'allocations:pause') return allocationResume.pause(allocationId);
        if (method === 'allocations:keep-reduced') return allocationResume.keepReduced(allocationId, z.uuid().parse(args[1]));
        if (method === 'allocations:cover-shortfall') return allocationResume.coverShortfall(allocationId, z.uuid().parse(args[1]));
        // A reverse split or unread share change, decided by the member after checking Robinhood.
        if (method === 'allocations:decide-share-event') { await shareEvents.decide(z.uuid().parse(args[1]), z.enum(['apply', 'dismiss']).parse(args[2])); return allocationResume.review(allocationId); }
        throw new Error('Unknown operation');
      }
      if (method === 'portfolio:activity') return database.use(db=>readActivityPage(db,z.uuid().parse(args[0]),args[1]));
      if (method === 'portfolio:snapshot') { portfolioUiSeenAt=Date.now(); const view=await platformPortfolios.snapshot(args[0] === undefined ? undefined : z.uuid().parse(args[0])); return {...view,plannedTakes:view.account?await takeAccountPlans.forAccount(view.account.id):[]}; }
      if (method === 'portfolio:prepare-strategy-import') return strategyImportResult(async()=>{ if(settings.busy())throw new StrategyImportError('Database busy'); return strategyPortfolioImport.prepare(args[0]); });
      if (method === 'portfolio:commit-strategy-import') return strategyImportResult(async()=>{ if(settings.busy())throw new StrategyImportError('Database busy'); const result=await strategyPortfolioImport.commit(args[0]);takes.changed();return result; });
      if (method === 'portfolio:prepare-history-import') { if(settings.busy())throw new Error('Database busy'); return portfolioHistoryImport.prepare(args[0]); }
      if (method === 'portfolio:commit-history-import') { if(settings.busy())throw new Error('Database busy'); return portfolioHistoryImport.commit(args[0]); }
      if (method === 'portfolio:refresh') { if(settings.busy())throw new Error('Database busy'); await platformPortfolios.refresh(args[0] === undefined ? undefined : z.uuid().parse(args[0])); return null; }
      if (method === 'connections:tool-schemas') {
        try { return { ok: true, tools: await connections.toolSchemas(AbortSignal.timeout(30_000)) }; }
        catch { return { ok: false, message: 'Robinhood tool discovery unavailable.' }; }
      }
      if (method === 'connections:crypto-tool-schemas') {
        if (app.isPackaged) return { ok: false, message: 'Tool inspection is available in development only.' };
        if (settings.busy()) return { ok: false, message: 'Database maintenance is in progress.' };
        try {
          return await manualActions.run(method, async signal => ({ ok: true, tools: await connections.cryptoToolSchemas(signal) }));
        } catch {
          return { ok: false, message: 'Could not inspect Robinhood tools. Check the connection and retry.' };
        }
      }
      if (method === 'connections:status') return { ok: true, connection: await connections.status() };
      if (method === 'connections:refresh') {
        sourceDisplays.invalidate();
        if (settings.busy()) throw new Error('Database busy');
        const connection = await connections.status();
        if (connection.status !== 'connected') return { ok: false, message: 'Sign in to Robinhood again before refreshing.' };
        await maintenance.request(); return { ok: true, queued: true, connection };
      }
      if (!['connections:connect', 'connections:disconnect', 'connections:select'].includes(method)) throw new Error('Unknown operation');
      eligibilityRefresh.invalidate();
      search.clear(); await searchAgent.cancelAll();
      if (settings.busy()) return { ok: false, message: 'Database maintenance is in progress. Try again shortly.' };
      try {
        return await manualActions.run(method === 'connections:connect' ? 'connect' : method, async signal => {
          maintenance.cancel(); await maintenance.settled();
          await connections.settled();
          signal.throwIfAborted();
          if (quitting) throw new Error('Host stopping');
          const connection = method === 'connections:connect' ? await connections.connect()
            : method === 'connections:disconnect' ? await connections.disconnect() : await connections.selectAccount(args[0]);
          if (method === 'connections:connect') await maintenance.reconnected();
          if (method !== 'connections:disconnect') await maintenance.request();
          return { ok: true, connection };
        });
      } catch (error) {
        const code = connectionFailure(error).code;
        return { ok: false, message: code === 'cancelled' ? 'Connection cancelled.' : code === 'storage_locked' ? 'Sign in to Robinhood again.'
          : code === 'reauth_required' ? 'Sign in to Robinhood again.' : 'Connection could not finish. Check the network and that port 3119 is available, then retry.' };
      }
    }), (token, method, args) => capabilities.authorize(token, method, args) || searchAgent.authorize(token, method, args));
    await createCryptoOrderJournal(database).recoverInterrupted();
    await notifications.recover();
    await maintenance.start();
    // Account policies are resolved independently when each job checks demand.
    managedPolls.start();
    notificationTimer = setInterval(() => {
      if (!notificationSuspended && !settings.busy() && !quitting) void notifications.tick().catch(() => {});
    }, 1000);
    // Strategy execution: independent loops; events wake them early.
    const tradingReady=()=>!notificationSuspended&&!settings.busy()&&!quitting&&tradingEnabled();
    executionLoops=createExecutionLoops({shareEvents,robinhoodScheduler:executionScheduler,coinbaseScheduler,mixedWithdrawals,mixedInvestments,
      // New firings become jobs, then every due action job advances one step.
      ruleTrades:{tick:async signal=>{await ruleTrades.enqueue();await robinhoodTrades.enqueue();await ruleAgents.enqueue();await ruleTargets.pass();await actionJobs.tick(signal);}}},{
      ready:tradingReady,
      // Account queues replace the old execution check; investments and syncs still pause rule trades.
      ruleTradesReady:()=>!coinbaseInvestments.busy()&&!coinbasePortfolio.busy()&&!coinbase.busy(),
      isolate:work=>accountQueues.detached(work),
      afterRobinhood:()=>diagnostics.record('venue.queue',{venue:'robinhood',...connections.queueStats()}),
      report:report=>report.event==='failed'
        ?diagnostics.record('background.failed',{...(report.venue?{venue:report.venue}:{}),stage:report.stage,error:report.error})
        :diagnostics.record('execution.loop',{worker:report.worker,kind:report.kind,...(report.durationMs!==undefined?{durationMs:report.durationMs}:{}),...(report.deadlineMs!==undefined?{deadlineMs:report.deadlineMs}:{}),...(report.heldMs!==undefined?{heldMs:report.heldMs}:{})}),
    });
    executionLoops.start();
    // A blocked host thread delays every loop; record it when it is noticeable.
    const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
    eventLoopTimer=setInterval(()=>{
      const p99=loopDelay.percentile(99)/1e6,max=loopDelay.max/1e6;loopDelay.reset();
      if(p99>=100)diagnostics.record('execution.event_loop',{delayP99Ms:Math.round(p99),delayMaxMs:Math.round(max)});
    },600_000);eventLoopTimer.unref();
    powerMonitor.on('suspend', () => { notificationSuspended = true; executionLoops?.suspend(); sourceDisplays.invalidate(); managedPolls.suspend(); dataSources.suspend();coinbaseHoldings.invalidate();coinbaseStream.suspend(); maintenance.suspend(); coinbasePortfolio.suspend(); void coinbase.cancel().catch(()=>{}); });
    powerMonitor.on('resume', () => { notificationSuspended = false; executionLoops?.resume(); if (net.isOnline()) { dataSources.resume();coinbaseStream.resume(); managedPolls.resume(); void Promise.allSettled([notifications.recover().then(() => maintenance.wake()),coinbasePortfolio.wake()]); } });
    let online = net.isOnline();
    if (!online) { dataSources.suspend();coinbaseHoldings.invalidate();coinbaseStream.suspend(); managedPolls.suspend(); }
    networkTimer = setInterval(() => {
      const next = net.isOnline();
      if(!next&&online){sourceDisplays.invalidate();managedPolls.suspend();dataSources.suspend();coinbaseHoldings.invalidate();coinbaseStream.suspend();maintenance.suspend();coinbasePortfolio.suspend();void coinbase.cancel().catch(()=>{});}
      if (next && !online && !notificationSuspended) { dataSources.resume();coinbaseStream.resume(); managedPolls.resume(); for(const loop of executionLoops?.loops??[])loop.wake(); }
      if (next && !online && !notificationSuspended) void Promise.allSettled([notifications.recover().then(() => maintenance.wake()),coinbasePortfolio.wake()]);
      online = next;
    }, 5000);
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
    tray.setToolTip('Opentake — background account sync');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Opentake is running in the background', enabled: false },
      { label: 'Open Opentake', click: () => launchDesktop(profile) }, { type: 'separator' },
      { label: 'Quit completely', click: () => void shutdown() },
    ]));
    tray.on('double-click', () => launchDesktop(profile));
    ready = true; diagnostics.record('app.ready');
  }).catch(async error => { diagnostics.record('database.failed'); await recordStartupFailure(profile,error).catch(()=>{}); void shutdown(); });
}
