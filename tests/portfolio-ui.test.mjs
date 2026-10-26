import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { loadConfigFromFile } from 'electron-vite';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';
import { stopHost } from './helpers/host.mjs';

test('portfolio navigation, stored observations, freshness and refresh request', {timeout:90000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-portfolio-ui-'));let app; let server;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  if (process.env.PORTFOLIO_TEST_DEV === '1') {
   const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('electron.vite.config.ts'));
   server = await createServer({ ...loaded.config.renderer, configFile: false, root: resolve('src/renderer'),
    cacheDir: join(profile, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
   await server.listen();
   env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0];
  }
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();
  const renderErrors = [];
  page.on('pageerror', error => renderErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Invalid hook call|Cannot read properties of null/.test(message.text())) renderErrors.push(message.text()); });
  page.setDefaultTimeout(15000);await dismissConnectionPrompt(page,app);
  await page.waitForFunction(async()=>{try{return !!(await window.activity.hostStatus()).pid;}catch{return false;}});
  // First exercise the real preload/RPC read with an empty disposable DB.
  assert.equal((await page.evaluate(()=>window.portfolio.snapshot())).account,null);
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByRole('heading',{name:'Connect your Robinhood Agentic account',exact:true}).waitFor();
  await page.getByRole('link',{name:'Opentake home'}).click();
  await app.evaluate(({ipcMain})=>{
   const account={id:'11111111-1111-4111-8111-111111111111',venue:'robinhood',label:'Synthetic account',available:true,selected:true,accountType:'limited_margin',optionLevel:'option_level_2'};
   ipcMain.removeHandler('portfolio:series');
   ipcMain.handle('portfolio:series',(_event,_id,range)=>({venue:'robinhood_agentic',range,asOf:new Date().toISOString(),staleSymbols:[],pendingSymbols:[],refreshingSymbols:[],series:[{symbol:'VTI',interval:'hour',bounds:'regular',baseline:{price:'200',kind:'previous_close'},price:'205',extendedPrice:null,extendedSession:null,extendedChange:null,change:{amount:'5',percent:'2.5'},points:[{t:new Date(Date.now()-3600000).toISOString(),c:'200',s:'regular'},{t:new Date().toISOString(),c:'205',s:'regular'}]}]}));
   // Never reach the logo provider from a test; a 1×1 PNG stands in.
   ipcMain.removeHandler('portfolio:logo');ipcMain.handle('portfolio:logo',()=>'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
   ipcMain.removeHandler('portfolio:market');ipcMain.handle('portfolio:market',(_event,symbol)=>({symbol,displayName:'Vanguard Total Stock Market ETF',fundamentals:{symbol,description:'Synthetic fund description.',market_cap:'400000000000'}}));
   // The strategy page reads the local basket, its performance and your own markers.
   const spec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
   const metadata={title:'Fixture strategy',description:'Imported strategy holdings',rationale:'',holdings:[]};
   const summary={strategyId:'33333333-3333-4333-8333-333333333333',targetTakeId:'44444444-4444-4444-8444-444444444444',title:'Fixture strategy',status:'committed',dirty:false,archivedAt:null};
   for(const name of ['list','read','performance','markers'])ipcMain.removeHandler('strategies:'+name);
   ipcMain.handle('strategies:list',(_event,archived)=>archived?[]:[summary]);
   ipcMain.handle('strategies:read',()=>({strategyId:summary.strategyId,targetTakeId:summary.targetTakeId,title:summary.title,archivedAt:null,currentVersion:'v1',clean:true,historyTruncated:false,proposals:[],
    draft:{metadata,spec,unsupportedRequests:[]},versions:[{id:'v1',sequence:1,proposalId:'p1',createdAt:new Date(Date.now()-90*86400000).toISOString(),acceptedBy:'local',payload:{metadata,spec,unsupportedRequests:[]}}]}));
   ipcMain.handle('strategies:performance',(_event,strategyId,range,basis)=>({strategyId,range,basis:'model',actualAvailable:false,investors:0,actualSince:null,intraday:null,rebalance:spec.rebalance,lastRebalancedAt:null,dividends:'excluded',stats:[],
    points:[{day:new Date(Date.now()-2*86400000).toISOString().slice(0,10),unitValue:'100',source:'backtested'},{day:new Date(Date.now()-86400000).toISOString().slice(0,10),unitValue:'104',source:'live'}]}));
   ipcMain.handle('strategies:markers',()=>[]);
   // The imported allocation reviews clean and resumes.
   const review=status=>({allocationId:'22222222-2222-4222-8222-222222222222',status,restoreRequired:status!=='active',pauseReason:status==='active'?null:'imported',shareEvents:[],reviewedAt:new Date().toISOString(),
    positions:[{instrumentRef:'vti',symbol:'VTI',claimed:'0.5',available:'0.5'}],cash:{claimed:'0',available:'775'},cases:[],blockers:[],ready:true});
   globalThis.resumed=0;
   for(const name of ['review','resume','holdings'])ipcMain.removeHandler('allocations:'+name);
   // The panel's holdings, in the hosted strategy-holdings shape: the imported allocation, paused for review.
   ipcMain.handle('allocations:holdings',()=>({status:200,selfDirected:[{accountId:'11111111-1111-4111-8111-111111111111',asOf:null,reservedCash:'25',positions:[]}],holdings:[{
    bucket:{id:'22222222-2222-4222-8222-222222222222',status:'paused'},strategy:{id:'33333333-3333-4333-8333-333333333333',slug:'fixture',displayName:'Fixture strategy',description:'Imported strategy holdings',iconUrl:null},
    allocation:{sequence:1,weights:[{symbol:'VTI',weightPercent:100}],cashPercent:0},valuation:{complete:true,currency:'USD',cash:'0',totalValue:'100'},positions:[{symbol:'VTI',quantity:'0.5'}],requiresReconciliation:true}]}));
   ipcMain.handle('allocations:review',()=>review('paused'));
   ipcMain.handle('allocations:resume',()=>{globalThis.resumed++;return review('active');});
   for(const name of ['fundamentals','search'])ipcMain.removeHandler('portfolio:'+name);
   ipcMain.handle('portfolio:fundamentals',()=>({VTI:{symbol:'VTI',dividend_yield:'1.3',pe_ratio:'24',market_cap:'1000000000000'}}));
   ipcMain.handle('portfolio:search',()=>[]);
   ipcMain.removeHandler('portfolio:strategy-history');
   ipcMain.handle('portfolio:strategy-history',(_event,allocationId,range)=>({allocationId,range,points:[{day:new Date(Date.now()-2*86400000).toISOString().slice(0,10),totalValue:'90'},{day:new Date(Date.now()-86400000).toISOString().slice(0,10),totalValue:'100'}]}));
   ipcMain.removeHandler('portfolio:refresh');
   ipcMain.handle('portfolio:refresh',(_event,id)=>{if(id!==account.id)throw Error('Wrong refresh account');});
   ipcMain.removeHandler('portfolio:snapshot');
   ipcMain.handle('portfolio:snapshot',()=>({account,accounts:[account],history:[{observedAt:new Date(Date.now()-60000).toISOString(),totalValue:'950.00',currency:'USD'},{observedAt:new Date().toISOString(),totalValue:'1000.00',currency:'USD'}],positionHistory:[],strategies:[{allocationId:'22222222-2222-4222-8222-222222222222',strategyId:'33333333-3333-4333-8333-333333333333',takeId:'44444444-4444-4444-8444-444444444444',title:'Fixture strategy',description:'Imported strategy holdings',status:'paused',requiresReconciliation:true,cash:'0',value:'100',positions:[{instrumentRef:'vti',symbol:'VTI',quantity:'0.5'}],spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},importedAsOf:new Date().toISOString()}],selfDirectedPositions:[{instrumentRef:'vti',symbol:'VTI',quantity:'0.5',markPrice:'200.00',marketValue:'100.00',currency:'USD',assetClass:'equity',averageCost:null,providerUnrealizedPnl:null}],reservedCash:'25',selfDirectedCash:'775',allocationWarnings:[],portfolio:{totalValue:'1000.00',cash:'800.00',buyingPower:'800.00',currency:'USD'},resources:[{resource:'equity_positions',observedAt:'2026-10-02T15:00:00Z',stale:true,state:'completed',errorCode:null}],positions:[{instrumentRef:'vti',symbol:'VTI',quantity:'1',markPrice:'200.00',marketValue:'200.00',currency:'USD',assetClass:'equity',averageCost:'180',providerUnrealizedPnl:'20'}],orders:[],executions:[{providerExecutionRef:'synthetic-fill',orderRef:'synthetic-order',symbol:'VTI',side:'buy',quantity:'1',price:'180',occurredAt:new Date().toISOString(),assetClass:'equity'}],gaps:[]}));
  });
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByRole('heading',{name:'Synthetic account',exact:true}).waitFor();
  const header=page.getByRole('region',{name:'Synthetic account',exact:true});
  // Typography/theme parity across font choices.
  const typography=await page.evaluate(async()=>{
    const root=document.documentElement, originalFont=root.dataset.font, originalDark=root.classList.contains('dark');
    const heading=document.getElementById('portfolio-value-heading');
    const value=heading.closest('section').querySelector('p.font-display');
    const result=[];
    for(const font of ['rubik','inter','geist']){
      root.dataset.font=font;
      await document.fonts.ready;
      for(const dark of [false,true]){
        root.classList.toggle('dark',dark);
        const titleStyle=getComputedStyle(heading),valueStyle=getComputedStyle(value);
        result.push({font,dark,titleSize:titleStyle.fontSize,titleWeight:titleStyle.fontWeight,valueSize:valueStyle.fontSize,valueWeight:valueStyle.fontWeight,background:getComputedStyle(root).getPropertyValue('--background').trim()});
      }
    }
    root.dataset.font=originalFont;root.classList.toggle('dark',originalDark);
    return result;
  });
  for(const style of typography){
    assert.equal(style.titleSize,'26px');assert.equal(style.valueSize,'32px');
    assert.equal(style.titleWeight,style.font==='rubik'?'400':'500');
    assert.equal(style.valueWeight,style.titleWeight);
    const channels=style.background.slice(6,-1).split(/\s+/);
    const lightness=parseFloat(channels[0])/(channels[0].endsWith('%')?100:1);
    assert.ok(Math.abs(lightness-(style.dark?0.141:1))<1e-9);
    assert.deepEqual(channels.slice(1).map(Number),style.dark?[0.005,285.823]:[0,0]);
  }

  await header.getByText('Options level 2',{exact:true}).waitFor();
  await header.getByText('$25.00 held by takes',{exact:true}).waitFor();
  assert.equal(await header.getByRole('button',{name:'Import existing takes',exact:true}).count(),0);
  assert.equal(await header.getByText('Saved data may be stale.',{exact:true}).count(),0);
  await page.getByRole('button').filter({hasText:'VTI'}).first().waitFor();
  await page.getByRole('img',{name:'Portfolio value over time'}).waitFor();
  const positionRow=page.getByRole('button').filter({hasText:'VTI'}).first();
  await positionRow.getByRole('img',{name:'Price history',exact:true}).waitFor();
  assert.ok(await positionRow.locator('svg path').count()>0,'New-profile position row must draw provider history without local observations');
  assert.ok((await positionRow.textContent()).includes('$205.00'));
  assert.ok((await positionRow.textContent()).includes('2.50%'));
  const navigation = await page.getByRole('link',{name:'Portfolio',exact:true}).boundingBox();
  assert.ok(navigation.x < 150, 'Portfolio navigation belongs beside the home logo');
  assert.ok((await page.getByRole('main',{name:'Portfolio'}).textContent()).includes('$1,000.00'));
  await page.getByRole('button',{name:'1y',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'1y',exact:true}).getAttribute('aria-pressed'),'true');
  const strategyRow=page.getByRole('button').filter({hasText:'Fixture strategy'});
  assert.equal(await strategyRow.getByRole('img',{name:'Price history',exact:true}).count(),0,'Reconciliation-required allocations must not show performance history');
  assert.ok((await strategyRow.textContent()).includes('$100.00'));
  assert.ok((await positionRow.textContent()).includes('0.5 shares'),'Stock row must show only the self-directed remainder');
  assert.ok(!(await strategyRow.textContent()).includes('11.11%'),'Unreconciled allocation returns must remain hidden');
  assert.ok((await strategyRow.textContent()).includes('Action required'),'Unreconciled allocation needs attention');
  const chips=page.locator('li').filter({has:strategyRow});
  await chips.getByText('VTI',{exact:true}).waitFor();
  await chips.locator('img[src^="data:image/png"]').waitFor();
  // The row opens the strategy's own page.
  await strategyRow.click();
  await page.getByRole('heading',{name:'Fixture strategy',exact:true}).waitFor();
  const strategyLine=page.getByRole('row').filter({has:page.getByRole('cell',{name:'This take',exact:true})});
  await strategyLine.waitFor();
  assert.ok((await strategyLine.textContent()).includes('4.00%'),'Return comes from the strategy performance');
  await page.getByRole('heading',{name:'Holdings',exact:true}).waitFor();
  await page.getByRole('link',{name:'Vanguard Total Stock Market ETF instrument page'}).or(page.getByRole('link',{name:'VTI instrument page'})).first().waitFor();
  await page.getByText('1.30%',{exact:true}).waitFor();
  // While the review card asks to resume, it is the only action: no deposit or withdrawal buttons.
  await page.getByText('Ready to resume',{exact:true}).waitFor();
  await page.getByText('Paused after import until you confirm it matches your account.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Deposit',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Take money out',exact:true}).count(),0);
  if(process.env.PORTFOLIO_SCREENSHOTS){await page.screenshot({path:process.env.PORTFOLIO_SCREENSHOTS+'/strategy.png'});await page.screenshot({path:process.env.PORTFOLIO_SCREENSHOTS+'/strategy-full.png',fullPage:true});}
  await page.getByRole('button',{name:'Resume take',exact:true}).click();
  for(let tries=0;tries<50&&await app.evaluate(()=>globalThis.resumed)!==1;tries++)await page.waitForTimeout(100);
  assert.equal(await app.evaluate(()=>globalThis.resumed),1,'Resume goes through the allocations bridge');
  await page.getByRole('link',{name:'Portfolio',exact:true}).first().click();
  await page.getByRole('heading',{name:'Synthetic account',exact:true}).waitFor();
  await page.getByRole('img',{name:'Portfolio value over time'}).scrollIntoViewIfNeeded();
  const chart = await page.getByRole('img',{name:'Portfolio value over time'}).boundingBox();
  // The leftmost edge is nearest the earliest point at any time of day.
  await page.mouse.move(chart.x + 1, chart.y + chart.height / 2);
  await page.locator('section[aria-labelledby="portfolio-value-heading"] .sr-only').filter({hasText:'$950.00'}).waitFor();
  await page.mouse.move(5,5);

  assert.ok((await page.getByRole('main',{name:'Portfolio'}).textContent()).includes('stale'));
  assert.equal(await page.getByRole('button',{name:/Import existing takes|Import portfolio history/}).count(),0);
  await page.getByRole('button',{name:'Sync latest portfolio',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Refresh requested'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.getByRole('button').filter({hasText:'VTI'}).first().click();
  await page.getByRole('heading',{name:'Vanguard Total Stock Market ETF',exact:true}).waitFor();
  const holders=page.getByRole('region',{name:'Your position',exact:true});
  await holders.getByText('Held by you',{exact:true}).waitFor();
  // What a take holds sits under its name in Takes holding, not as a Held by row.
  assert.equal(await holders.getByRole('link',{name:'Fixture strategy',exact:true}).count(),0);
  const takes=page.getByRole('region',{name:'Takes holding VTI',exact:true});
  await takes.getByRole('link',{name:'Fixture strategy',exact:true}).waitFor();
  assert.equal(await takes.getByText('Committed',{exact:true}).count(),0);
  await page.getByText('Synthetic fund description.').waitFor();
  if(process.env.PORTFOLIO_SCREENSHOTS)await page.screenshot({path:process.env.PORTFOLIO_SCREENSHOTS+'/market.png'});
  await page.getByRole('link',{name:'Back'}).click();
  await page.getByRole('heading',{name:'Synthetic account',exact:true}).waitFor();
  await page.getByRole('button').filter({hasText:'VTI buy'}).click();
  await page.getByText('Filled notional',{exact:true}).waitFor();
  await page.getByRole('button',{name:'About buying power'}).click();
  await page.getByText('Cash free for your own trades: Robinhood buying power minus what your takes are holding to buy their positions.',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Disconnect Robinhood',exact:true}).click();
  await page.getByRole('dialog',{name:'Disconnect Robinhood?'}).waitFor();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('link',{name:'View all',exact:true}).click();
  await page.getByRole('heading',{name:'Activity',exact:true}).waitFor();
  await page.getByRole('main').getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByRole('heading',{name:'Synthetic account',exact:true}).waitFor();

  assert.equal(await page.getByText('Watchlist',{exact:true}).count(),0);
  await positionRow.getByRole('img',{name:'Price history',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/opentake-portfolio-synthetic.png',fullPage:true});
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('portfolio:series');ipcMain.handle('portfolio:series',()=>{throw new Error('Synthetic price-history outage');});});
  await page.getByRole('button',{name:'1m',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Price history unavailable'}).waitFor();
  await positionRow.getByRole('img',{name:'Price history unavailable',exact:true}).waitFor();
  assert.ok((await positionRow.textContent()).includes('$200.00'),'Fallback uses saved mark, not another range series');
  await app.evaluate(({ipcMain})=>{
   const account={id:'11111111-1111-4111-8111-111111111111',venue:'robinhood',label:'Synthetic account',available:true,selected:true,accountType:'limited_margin',optionLevel:'option_level_2'};
   ipcMain.removeHandler('portfolio:snapshot');
   ipcMain.handle('portfolio:snapshot',()=>({account,accounts:[account],history:[],portfolio:null,resources:[{resource:'portfolio',observedAt:null,stale:true,state:'failed',errorCode:'sync_incomplete'}],positions:[],orders:[],executions:[],gaps:[]}));
  });
  await page.getByRole('link',{name:'Opentake home'}).click();
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByText('Latest sync incomplete. Refresh to retry.',{exact:true}).waitFor();
  await page.getByText('Waiting for positions to sync.',{exact:true}).waitFor();
  // Settings > Trading, against the real host: no test-order panel.
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Trading',exact:true}).click();
  const confirm=page.getByRole('switch',{name:'Confirm every trade'});
  await confirm.waitFor();
  assert.equal(await confirm.getAttribute('aria-checked'),'false','Orders are not held by default');
  await confirm.click();
  for(let tries=0;tries<50&&(await page.evaluate(()=>window.allocations.tradingPreferences()))?.preferences?.confirmTrades!==true;tries++)await page.waitForTimeout(100);
  assert.equal((await page.evaluate(()=>window.allocations.tradingPreferences())).preferences.confirmTrades,true,'The switch is stored');
  await page.getByText('No blocked markets.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Recent orders',{exact:true}).count(),0);
  assert.deepEqual(renderErrors, [], 'Portfolio must render without React hook errors');
 }finally{if(app)await app.close();await stopHost(profile);if(server)await server.close();await rm(profile,{recursive:true,force:true});}
});
