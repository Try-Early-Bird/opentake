import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from './helpers/onboarding.mjs';
import {closeDesktop} from './helpers/desktop.mjs';
import {stopHost} from './helpers/host.mjs';

test('Coinbase uses amount then Invest and keeps confirmation inline',{timeout:120000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-capital-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(8000);await page.setViewportSize({width:1400,height:1000});await dismissConnectionPrompt(page,app);
  const fixture=await page.evaluate(async()=>{
   const takeId=await window.takes.create();
   const result=await window.strategies.propose({targetTakeId:takeId,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID(),metadata:{title:'Capital review fixture',description:'',rationale:'Synthetic',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});
   if(!result.ok)throw Error(result.message);
   // Omitted refresh must survive JSON RPC as false, not fail boolean validation.
   let lifecycleError='';try{await window.strategies.coinbaseLifecycle(takeId);}catch(e){lifecycleError=e.message;}
   if(!lifecycleError.includes('Coinbase allocation unavailable'))throw Error('Lifecycle bridge failed: '+lifecycleError);
   // Verify the real bridge reaches the service without any connected account.
   let rejected=false;try{await window.strategies.previewCoinbaseCapital({takeId,kind:'assign',asset:'USDC',quantity:'100'});}catch{rejected=true;}
   if(!rejected)throw Error('Unconnected account must not fund');
   const current=await window.orders.execute({venue:'coinbase',action:'current',input:takeId});
   if(current.venue!=='coinbase'||current.review!==null)throw Error('Common trading bridge returned another account');
   let tradeRejected=false;try{await window.orders.execute({venue:'coinbase',action:'review',input:{takeId,quote:'USDC'}});}catch{tradeRejected=true;}
   if(!tradeRejected)throw Error('Unconnected Coinbase account must not preview trades');
   await window.strategies.commit({targetTakeId:takeId,expectedRevision:result.view.draft.id,expectedVersion:null,operationId:crypto.randomUUID()});
   return {takeId,strategyId:result.view.strategyId,draftRevision:result.view.draft.id};
  });
  await app.evaluate(({ipcMain},fixture)=>{
   const accountId='11111111-1111-4111-8111-111111111111';
   const view={accountId,accountLabel:'Synthetic Coinbase portfolio',takeTitle:'Capital review fixture',balances:[],buyingPower:[{asset:'USD',amount:'32.90'},{asset:'USDC',amount:'142.10'}]};
   const plan={...fixture,revision:null,editable:true,reason:null,accounts:[{id:accountId,venue:'coinbase',label:view.accountLabel,available:true}],routes:[{venue:'coinbase',accountId,assets:[{symbol:'BTC',bps:10000}]}]};
   for(const name of ['coinbase-withdrawal-band','coinbase-preflight','account-plan','coinbase-capital','preview-coinbase-capital','confirm-coinbase-capital','save-coinbase-risk','coinbase-investment','invest-coinbase','act-coinbase-investment','coinbase-orders','preview-coinbase-orders','confirm-coinbase-orders','submit-coinbase-orders'])ipcMain.removeHandler('strategies:'+name);
   globalThis.capitalFixture=view;
   globalThis.chartHasFills=false;
   ipcMain.removeHandler('strategies:performance');
   ipcMain.handle('strategies:performance',(_event,strategyId,range,basis)=>({strategyId,range,basis,actualAvailable:globalThis.chartHasFills,actualSince:globalThis.chartHasFills?new Date().toISOString():null,investors:globalThis.chartHasFills?1:0,rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null},lastRebalancedAt:null,dividends:'excluded',intraday:null,points:[],stats:[]}));
   ipcMain.handle('strategies:coinbase-withdrawal-band',()=>({minimumAmount:'2',maximumAmount:'40',possible:true,holdingsValue:'50'}));
   let failedPreview=false;
   ipcMain.handle('strategies:coinbase-preflight',(_event,input)=>{if(!failedPreview){failedPreview=true;throw Error('Synthetic preview failure');}return ({ok:Number(input.quantity)>=2,amount:input.quantity,minimumAmount:'2',legs:Number(input.quantity)>=2?[{symbol:'BTC',notional:input.quantity,weightPercent:100}]:[],retainedCash:'0',reason:null});});
   globalThis.riskSaves=[];
   ipcMain.handle('strategies:save-coinbase-risk',(_event,input)=>{globalThis.riskSaves.push(input);view.risk.policy=input.policy;return view;});
   globalThis.capitalConfirmations=[];globalThis.capitalPreviews=[];
   let investment=null,investedAmount='0',withdrawal=null;
   globalThis.settleInvestment=()=>{globalThis.chartHasFills=true;investment.state='dispatched';investment.review.state='settled';investment.review.orders.forEach(o=>o.execution={state:'filled'});};
   globalThis.withdrawalRequests=[];let previewWasBusy=false;
   ipcMain.handle('strategies:coinbase-orders',()=>withdrawal);
   ipcMain.handle('strategies:preview-coinbase-orders',(_event,input)=>{
    if(!previewWasBusy){previewWasBusy=true;throw Error('Another Coinbase connection operation is running.');}
    globalThis.withdrawalRequests.push(input);
    const positions=view.balances.filter(b=>!['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0);
    const selected=input.sellSymbols??positions.map(b=>b.asset);
    const orders=input.close?positions.filter(b=>selected.includes(b.asset)).map(b=>({product:b.asset+'-'+input.quote,side:'sell',baseSize:b.quantity,notional:'45',fee:'0.10'})):[{product:'BTC-'+input.quote,side:'sell',baseSize:'0.0001',notional:'5',fee:'0.10'}];
    return globalThis.lastWithdrawalPreview={id:'77777777-7777-4777-8777-777777777777',takeId:fixture.takeId,quote:input.quote,state:'preview',withdrawal:{close:input.close,requestedAmount:input.withdrawAmount??'45',estimatedProceeds:orders.length?'4.90':'0',remainingValue:'45'},closePositions:input.close?positions.map(b=>({symbol:b.asset,quantity:b.quantity,value:'45',unrealized:'-1',sellable:true})):undefined,closeCash:view.balances.filter(b=>['USD','USDC'].includes(b.asset)&&Number(b.quantity)>0),orders};
   });
   ipcMain.handle('strategies:confirm-coinbase-orders',()=>({needsConfirmation:false}));
   ipcMain.handle('strategies:submit-coinbase-orders',()=>{
    if(globalThis.lastWithdrawalPreview.withdrawal.close){view.balances=[];return withdrawal={...globalThis.lastWithdrawalPreview,state:'settled',closed:true,orders:globalThis.lastWithdrawalPreview.orders.map(o=>({...o,execution:{state:'filled'}}))};}
    view.balances=view.balances.map(b=>b.asset==='BTC'?{...b,quantity:'0.0009'}:b);
    return withdrawal={id:'77777777-7777-4777-8777-777777777777',takeId:fixture.takeId,quote:'USDC',state:'settled',withdrawal:{requestedAmount:'5',estimatedProceeds:'4.90'},returnedAmount:'4.90',orders:[{product:'BTC-USDC',side:'sell',baseSize:'0.0001',execution:{state:'filled'}}]};
   });
   globalThis.investments=[];globalThis.investmentActions=[];
   ipcMain.handle('strategies:coinbase-investment',()=>investment);
   ipcMain.handle('strategies:invest-coinbase',(_event,input)=>{
    globalThis.investments.push(input);investedAmount=input.quantity;globalThis.capitalConfirmations.push(input.operationId);
    view.risk={allocationId:'66666666-6666-4666-8666-666666666666',policy:{currency:null,maxDailyNotional:null,maxLoss:null}};
    view.balances=[...view.balances.filter(b=>b.asset!==input.asset),{asset:input.asset,quantity:String(Number(view.balances.find(b=>b.asset===input.asset)?.quantity??'0')+Number(input.quantity)),reserved:'0'}];
    return investment={id:input.operationId,state:'ready',capital:view,needsConfirmation:true,error:null,review:{id:'33333333-3333-4333-8333-333333333333',state:'preview',quote:input.asset,orders:[{product:'BTC-USDC',side:'buy',baseSize:'0.001',limitPrice:'50000',fee:'1'}]}};
   });
   ipcMain.handle('strategies:act-coinbase-investment',(_event,id,action)=>{
    globalThis.investmentActions.push({id,action});
    if(action==='confirm'){investment.state='dispatched';investment.needsConfirmation=false;investment.review.state='confirmed';investment.review.orders[0].execution={state:'accepted',cancelState:'none'};}
    if(action==='cancel'){if(investment.state==='ready'){view.balances=view.balances.map(b=>b.asset===investment.review.quote?{...b,quantity:String(Number(b.quantity)-Number(investedAmount))}:b);investment.review.state='cancelled';investment.cashStatus='Unused cash returned to your Coinbase account.';}else{investment.review.orders[0].execution.cancelState='requested';investment.cashStatus='Cancellation pending. Cash stays reserved until orders are resolved.';}investment.state='cancelled';}
    if(action==='refresh'){investment.review.state='settled';investment.review.orders[0].execution.state='cancelled';view.balances=[{asset:'USDC',quantity:'5',reserved:'0'},{asset:'BTC',quantity:'0.001',reserved:'0'}];investment.cashStatus='Unused cash returned to your Coinbase account.';}
    return investment;
   });
   const orderEvent={id:'event',orderId:'44444444-4444-4444-8444-444444444444',venue:'coinbase',accountId,connectionId:'55555555-5555-4555-8555-555555555555',accountLabel:view.accountLabel,strategyId:fixture.strategyId,takeId:fixture.takeId,takeTitle:view.takeTitle,reviewId:'33333333-3333-4333-8333-333333333333',providerRef:'synthetic-order',symbol:'BTC-USDC',side:'buy',execution:{state:'partially_filled',cancelState:'requested'},observedAt:new Date().toISOString()};
   for(const channel of ['notifications:list','notifications:target'])ipcMain.removeHandler(channel);
   ipcMain.handle('notifications:list',()=>({items:[{id:orderEvent.orderId,sequence:'1',seen:false,resolvedAt:null,kind:'order_update',tier:'know_today',requiresAction:false,eventKey:'event',context:{venue:'coinbase',connectionId:orderEvent.connectionId,accountId},source:{type:'order',id:orderEvent.orderId},occurredAt:orderEvent.observedAt,title:'BTC-USDC buy · Partially filled',body:'Coinbase · Synthetic Coinbase portfolio',order:orderEvent}],nextCursor:null,throughSequence:'1',unreadCount:1,actionRequiredCount:0}));
   ipcMain.handle('notifications:target',()=>({type:'order',order:orderEvent}));
   ipcMain.removeHandler('portfolio:series');
   ipcMain.handle('portfolio:series',(_event,_id,range)=>({venue:'coinbase',range,asOf:new Date().toISOString(),series:[{symbol:'BTC',interval:'hour',bounds:'regular',baseline:{price:'400',kind:'first_bar'},price:'500',extendedPrice:null,extendedSession:null,extendedChange:null,change:{amount:'100',percent:'25'},points:[{t:new Date(Date.now()-3600000).toISOString(),c:'400',s:'regular'},{t:new Date().toISOString(),c:'500',s:'regular'}]}],staleSymbols:[],pendingSymbols:[],refreshingSymbols:[]}));
   ipcMain.removeHandler('portfolio:snapshot');
   ipcMain.handle('portfolio:snapshot',()=>{
    const account={id:accountId,venue:'coinbase',label:view.accountLabel,available:true,selected:false};
    return {accountTransactions:[{id:'historical-transfer',asset:'USDC',amount:'25',type:'receive',status:'completed',occurredAt:new Date().toISOString()}],orderActivity:[orderEvent],account,accounts:[account],resources:[{resource:"portfolio",observedAt:new Date().toISOString(),state:"completed",errorCode:null,stale:false}],history:[],positionHistory:[],positions:[],spotPositions:[{instrumentRef:'coinbase:BTC',asset:'BTC',quantity:'0.25',marketValue:'125',availableValue:'125',currency:'USD',isCash:false}],orders:[],executions:[],gaps:[],portfolio:{totalValue:'1000',cash:null,buyingPower:null,currency:'USD'},capitalActivity:globalThis.capitalConfirmations.length?[{id:'confirmed',occurredAt:new Date().toISOString(),kind:'assign',asset:'USDC',quantity:'125.50',takeId:fixture.takeId,takeTitle:view.takeTitle}]:[]};
   });
   ipcMain.handle('strategies:account-plan',()=>plan);
   ipcMain.handle('strategies:coinbase-capital',()=>view);
   ipcMain.handle('strategies:preview-coinbase-capital',(_event,input)=>{
    globalThis.capitalPreviews.push(input);return {...input,id:'22222222-2222-4222-8222-222222222222',accountLabel:view.accountLabel,takeTitle:view.takeTitle,expiresAt:new Date(Date.now()+60000).toISOString()};
   });
   ipcMain.handle('strategies:confirm-coinbase-capital',(_event,id)=>{const preview=globalThis.capitalPreviews.at(-1);if(preview?.kind==='release'){globalThis.capitalConfirmations.push(id);view.balances=view.balances.map(b=>b.asset===preview.asset?{...b,quantity:String(Number(b.quantity)-Number(preview.quantity))}:b);return view;}globalThis.capitalConfirmations.push(id);view.risk={allocationId:'66666666-6666-4666-8666-666666666666',policy:{currency:null,maxDailyNotional:null,maxLoss:null}};view.balances=[{asset:'USDC',quantity:'125.50',reserved:'0'}];plan.editable=false;plan.reason='Funded Takes keep their existing account allocations.';return view;});
  },fixture);
  await page.reload();await dismissConnectionPrompt(page,app);
  await page.getByRole('navigation',{name:'Takes',exact:true}).getByRole('button',{name:/^Capital review fixture/}).click();
  assert.equal(await page.getByRole('region',{name:'Accounts for this take',exact:true}).count(),0);
  await page.getByRole('link',{name:'Invest',exact:true}).click();
  const investmentForm=page.getByRole('region',{name:'Coinbase investment',exact:true});
  await page.locator('[aria-label="Chart basis"] button[aria-pressed="true"]').filter({hasText:'Simulated'}).waitFor();
  await page.getByRole('button',{name:'Actual',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Actual',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Simulated',exact:true}).click();
  await investmentForm.getByRole('button',{name:'Retry preview',exact:true}).click();
  await investmentForm.getByText('Coinbase',{exact:true}).first().waitFor();
  assert.equal(await investmentForm.getByText('Coinbase · BTC 100%',{exact:true}).count(),0);
  assert.equal(await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).getAttribute('placeholder'),'0.00');
  for(const value of [10,20,50,100]){await investmentForm.getByRole('button',{name:'$'+value,exact:true}).click();assert.equal(await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).inputValue(),String(value));}
  await investmentForm.getByRole('button',{name:'Max',exact:true}).click();assert.equal(await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).inputValue(),'142.10');
  await investmentForm.getByRole('group',{name:'Investment currency'}).getByRole('button',{name:'USD',exact:true}).click();
  assert.equal(await investmentForm.getByRole('button',{name:'Invest',exact:true}).isDisabled(),true);
  await investmentForm.getByRole('button',{name:'Max',exact:true}).click();assert.equal(await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).inputValue(),'32.90');
  await investmentForm.getByRole('group',{name:'Investment currency'}).getByRole('button',{name:'USDC',exact:true}).click();
  await investmentForm.getByText('Minimum 2.00 USDC',{exact:true}).waitFor();
  await investmentForm.getByText('This buys',{exact:true}).waitFor();
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.getByLabel('Amount to invest in dollars',{exact:true}).fill('125.50');
  assert.equal(await page.getByRole('button',{name:'Review allocation',exact:true}).count(),0);
  await page.getByRole('button',{name:'Invest',exact:true}).click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.count(),0);
  await page.getByRole('heading',{name:'Investment needs your OK',exact:true}).waitFor();
  assert.equal(await page.locator('details').filter({hasText:'Order details'}).count(),0);
  const investments=await app.evaluate(()=>globalThis.investments);
  assert.equal(investments.length,1);assert.equal(investments[0].quantity,'125.50');assert.equal(investments[0].asset,'USDC');
  assert.equal(investments[0].accountId,'11111111-1111-4111-8111-111111111111');
  assert.equal((await app.evaluate(()=>globalThis.investmentActions)).length,0);
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByRole('heading',{name:'Investment buying',exact:true}).waitFor();
  assert.equal((await app.evaluate(()=>globalThis.investmentActions))[0].action,'confirm');
  assert.equal(await page.getByRole('button',{name:'Risk limits',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Take money out',exact:true}).count(),0);

  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  await page.getByRole('heading',{name:'Investment cancelled',exact:true}).waitFor();
  await page.getByRole('button',{name:'Deposit',exact:true}).click();
  await dialog.getByRole('heading',{name:'Deposit into Capital review fixture',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'$10',exact:true}).click();
  assert.equal(await dialog.getByLabel('Amount to deposit in dollars',{exact:true}).inputValue(),'10');
  await dialog.getByText('This adds',{exact:true}).waitFor();
  await dialog.getByText('Synthetic Coinbase portfolio',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Deposit',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  const deposited=await app.evaluate(()=>globalThis.investments);
  assert.equal(deposited.length,2);assert.equal(deposited[1].accountId,deposited[0].accountId);
  assert.equal(deposited[1].takeId,deposited[0].takeId);assert.equal(deposited[1].quantity,'10');
  assert.notEqual(deposited[1].operationId,deposited[0].operationId);
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByRole('heading',{name:'Investment buying',exact:true}).waitFor();
  await app.evaluate(()=>globalThis.settleInvestment());
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('button',{name:'Take money out',exact:true}).click();
  await dialog.getByRole('button',{name:/Reduce this investment/}).click();
  await dialog.getByText('Minimum 2.00 USDC',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'USDC',exact:true}).getAttribute('aria-pressed'),'true');
  await dialog.getByLabel('Amount to take out',{exact:true}).fill('50');
  await dialog.getByText('Enter no more than 40.00 USDC.',{exact:true}).waitFor();
  assert.equal((await app.evaluate(()=>globalThis.withdrawalRequests)).length,0);
  await dialog.getByLabel('Amount to take out',{exact:true}).fill('5');
  await dialog.getByText('Checking the sale…',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Take out $5',exact:true}).isDisabled(),true);
  await dialog.getByText('Back to Synthetic Coinbase portfolio, after fees',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Take out $5',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  const released=await app.evaluate(()=>globalThis.withdrawalRequests.at(-1));
  assert.equal(released.withdrawAmount,'5');assert.equal(released.quote,'USDC');assert.equal(released.takeId,fixture.takeId);
  assert.equal((await app.evaluate(()=>globalThis.capitalPreviews)).length,0);
  await investmentForm.getByText('0.0009',{exact:true}).waitFor();
  assert.equal(await investmentForm.getByLabel('Withdrawal status',{exact:true}).count(),0);
  assert.equal(await investmentForm.getByText('4.90 USDC returned to Synthetic Coinbase portfolio',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Take money out',exact:true}).click();
  await dialog.getByRole('button',{name:/Close all positions/}).click();
  await dialog.getByRole('checkbox',{name:'Sell BTC',exact:true}).waitFor();
  assert.equal(await dialog.getByRole('checkbox',{name:'Sell BTC',exact:true}).isChecked(),true);
  await dialog.getByRole('button',{name:'USD',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[aria-pressed="true"]')?.textContent==='USD');
  await dialog.getByRole('checkbox',{name:'Sell BTC',exact:true}).uncheck();
  await dialog.getByRole('button',{name:'Keep assets and close',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Keep take',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  // Test cash-only UI state in the disposable fixture; no provider account exists.
  await app.evaluate(()=>{globalThis.settleInvestment();globalThis.capitalFixture.balances=[{asset:'USDC',quantity:'5',reserved:'0'},{asset:'USD',quantity:'2',reserved:'0'}];});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await investmentForm.getByText('Uninvested cash · USD',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Take money out',exact:true}).click();
  await dialog.getByRole('button',{name:/Close and release cash/}).click();
  await dialog.getByText('Cash · USDC',{exact:true}).waitFor();
  await dialog.getByText('Cash · USD',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('group',{name:'Receive currency'}).count(),0);
  await dialog.getByRole('button',{name:'Close and release cash',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).waitFor();
  assert.equal(await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).inputValue(),'10');
  await investmentForm.getByText('This buys',{exact:true}).waitFor();
  await investmentForm.getByRole('button',{name:'Invest',exact:true}).click();
  await page.getByRole('heading',{name:'Investment needs your OK',exact:true}).waitFor();
  const reinvested=await app.evaluate(()=>globalThis.investments);
  assert.equal(reinvested.length,3);
  assert.notEqual(reinvested[2].operationId,reinvested[1].operationId);
  assert.equal(reinvested[2].accountId,reinvested[1].accountId);
  assert.equal(await investmentForm.getByText('Investment closed. Funds are back in Synthetic Coinbase portfolio.',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await investmentForm.getByLabel('Amount to invest in dollars',{exact:true}).waitFor();
  const takeUrl=page.url();
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  const holding=page.locator('li').filter({has:page.getByText('0.25 BTC',{exact:true})});
  await holding.getByRole('img',{name:'Price history',exact:true}).waitFor();
  assert.equal(await holding.locator('img').count(),1);
  assert.match(await holding.innerText(),/\$125\.00/);
  assert.doesNotMatch(await holding.innerText(),/\$500\.00/);
  const activity=page.getByRole('region',{name:'Activity',exact:true});
  await activity.getByText('USDC · Received',{exact:true}).waitFor();
  await activity.getByText('25 USDC',{exact:true}).waitFor();
  await activity.getByText('Funds assigned to Capital review fixture',{exact:true}).waitFor();
  await activity.getByRole('button',{name:/Funds assigned to/}).click();
  await activity.getByText('Opentake · Coinbase allocation',{exact:true}).waitFor();
  assert.equal(await activity.getByText(/shares at/).count(),0);
  await activity.getByRole('button',{name:/BTC-USDC buy · Partially filled/}).click();
  await activity.getByText('synthetic-order',{exact:true}).waitFor();
  await page.getByRole('button',{name:/Notifications, /}).click();
  await page.getByRole('button',{name:/BTC-USDC buy · Partially filled · Coinbase/}).click();
  await dialog.getByRole('heading',{name:'Order details',exact:true}).waitFor();
  await dialog.getByText('Synthetic Coinbase portfolio',{exact:true}).waitFor();
  await dialog.getByText('synthetic-order',{exact:true}).waitFor();

  await dialog.press('Escape');
  // Lifecycle controls use the same Take panel, with synthetic evidence and no provider calls.
  await app.evaluate(({ipcMain},fixture)=>{
   globalThis.settleInvestment();globalThis.capitalFixture.balances=[{asset:'BTC',quantity:'0.1',reserved:'0'}];
   const rules={cashBps:0,schedule:'never',driftBandPoints:5,driftBandRelative:null};
   const value={takeId:fixture.takeId,accountId:globalThis.capitalFixture.accountId,allocationId:'77777777-7777-4777-8777-777777777777',accountLabel:'Synthetic Coinbase portfolio',archived:false,pending:false,funded:true,versionId:'previous',currentVersionId:'latest',driftEnabled:false,canEnableDrift:true,blocked:null,evidence:'a'.repeat(64),changes:[],currentWeights:[{symbol:'BTC',bps:10000}],nextWeights:[{symbol:'BTC',bps:6000},{symbol:'ETH',bps:4000}],currentRules:rules,nextRules:rules};
   globalThis.lifecycleFixture=value;globalThis.lifecycleActions=[];
   for(const name of ['coinbase-lifecycle','decide-coinbase-lifecycle'])ipcMain.removeHandler('strategies:'+name);
   ipcMain.handle('strategies:coinbase-lifecycle',()=>value);
   ipcMain.handle('strategies:decide-coinbase-lifecycle',(_event,input)=>{
    globalThis.lifecycleActions.push(input.action);
    if(input.action==='adopt')value.versionId=value.currentVersionId;
    if(input.action==='enable_drift')value.driftEnabled=true;
    if(input.action==='reconcile')value.changes=[];
    if(input.action==='release'){value.funded=false;globalThis.capitalFixture.balances=[];}
    value.evidence=crypto.randomUUID().replaceAll('-','').repeat(2);return value;
   });
  },fixture);
  await page.goto(takeUrl);await dismissConnectionPrompt(page,app);
  await page.getByRole('navigation',{name:'Takes',exact:true}).getByRole('button',{name:/^Capital review fixture/}).click();
  await page.getByRole('link',{name:'Invest',exact:true}).click();
  await page.locator('[aria-label="Chart basis"] button[aria-pressed="true"]').filter({hasText:'Actual'}).waitFor();
  await investmentForm.getByRole('button',{name:'Review changes',exact:true}).click();
  await dialog.getByRole('heading',{name:'Use new allocations',exact:true}).waitFor();
  await dialog.getByText('100% → 60%',{exact:true}).waitFor();
  await dialog.getByText('Schedule',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Use these allocations',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await investmentForm.getByRole('button',{name:'Enable drift rebalancing',exact:true}).click();
  await dialog.getByRole('button',{name:'Enable',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual(await app.evaluate(()=>globalThis.lifecycleActions),['adopt','enable_drift']);
  await app.evaluate(()=>{globalThis.lifecycleFixture.archived=true;});
  await page.reload();await dismissConnectionPrompt(page,app);
  await page.getByRole('navigation',{name:'Takes',exact:true}).getByRole('button',{name:/^Capital review fixture/}).click();
  await page.getByRole('link',{name:'Invest',exact:true}).click();
  await investmentForm.getByRole('button',{name:'Keep all holdings',exact:true}).click();
  await dialog.getByText('Release this Take’s cash and holdings to Synthetic Coinbase portfolio. Nothing is sold.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Keep and close',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual(await app.evaluate(()=>globalThis.lifecycleActions),['adopt','enable_drift','release']);
  assert.equal(await investmentForm.getByRole('button',{name:'Invest',exact:true}).count(),0);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
