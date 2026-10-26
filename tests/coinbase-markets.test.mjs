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

test('Coinbase assets open from holdings and Takes without Markets navigation',{timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-markets-'));let app;
 try {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(8000);await page.setViewportSize({width:1400,height:1000});await dismissConnectionPrompt(page,app);
  await page.evaluate(async()=>{
   const takeId=await window.takes.create();
   const result=await window.strategies.propose({targetTakeId:takeId,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID(),metadata:{title:'Asset link fixture',description:'',rationale:'Synthetic',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});
   if(!result.ok)throw Error(result.message);
  });
  // Exercise the real desktop/host bridge with invalid input before installing fixtures.
  assert.equal(await page.evaluate(async()=>{try{await window.portfolio.coinbaseMarkets.detail('../invalid');return false;}catch{return true;}}),true);
  await app.evaluate(({ipcMain})=>{
   const accounts=[{id:'11111111-1111-4111-8111-111111111111',venue:'coinbase',label:'Primary',available:true,selected:false},{id:'22222222-2222-4222-8222-222222222222',venue:'coinbase',label:'Second portfolio',available:true,selected:false}];
   globalThis.fixtureAccounts=accounts;
   const markets=['BTC-USD','BTC-USDC'].map(id=>({id,venue:'coinbase',base:'BTC',quote:id.split('-')[1],name:'Bitcoin',price:'500',change24h:'25',volume24h:'200',quoteVolume24h:'114200000',high24h:'520',low24h:'380',status:'online',tradingDisabled:false}));
   const series=symbol=>({symbol,interval:'hour',bounds:'regular',dayStart:new Date(Date.now()-86400000).toISOString(),dayEnd:new Date().toISOString(),baseline:{price:'400',kind:'first_bar'},price:'500',extendedPrice:null,extendedSession:null,extendedChange:null,change:{amount:'100',percent:'25'},points:Array.from({length:24},(_,i)=>({t:new Date(Date.now()-(23-i)*3600000).toISOString(),c:String(400+i*4),s:'regular'}))});
   for(const name of ['markets:coinbase:detail','markets:coinbase:series','portfolio:snapshot','portfolio:series'])ipcMain.removeHandler(name);
   ipcMain.handle('markets:coinbase:detail',(_e,id)=>({market:markets.find(m=>m.id===id),observedAt:new Date().toISOString(),stale:false}));
   ipcMain.handle('markets:coinbase:series',(_e,id)=>({series:series(id),observedAt:new Date().toISOString(),stale:false}));
   ipcMain.handle('portfolio:series',(_e,id,range)=>({venue:'coinbase',range,asOf:new Date().toISOString(),series:[series('BTC')],staleSymbols:[],pendingSymbols:[],refreshingSymbols:[]}));
   ipcMain.handle('portfolio:snapshot',(_e,id)=>({account:accounts.find(a=>a.id===id)??accounts[0],accounts,resources:[{resource:'portfolio',observedAt:new Date().toISOString(),state:'completed',errorCode:null,stale:false}],history:[],positionHistory:[],positions:[],spotPositions:[{instrumentRef:'coinbase:BTC',asset:'BTC',quantity:id===accounts[1]?.id?'2':'0.25',marketValue:id===accounts[1]?.id?'1000':'125',availableValue:'125',currency:'USD',isCash:false,averageEntryPrice:id===accounts[1]?.id?null:'400',unrealizedPnl:id===accounts[1]?.id?null:'25',takeAllocations:[]}],orders:[],executions:[],gaps:[],portfolio:{totalValue:'125',cash:null,buyingPower:null,currency:'USD'}}));
  });
  assert.equal(await page.getByRole('link',{name:'Markets',exact:true}).count(),0);
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByRole('button',{name:/BTC 0.25 BTC/}).click();
  await page.getByRole('heading',{name:'Bitcoin',exact:true}).waitFor();
  await page.getByText('BTC-USD · Coinbase · Spot',{exact:true}).waitFor();
  const position=page.getByRole('region',{name:'Your position',exact:true});
  assert.equal(await position.getByText('Held by you',{exact:true}).count(),0);
  assert.equal(await position.getByText('0.25 · $125.00',{exact:true}).count(),0);
  await position.getByText('0.25 BTC · Avg $400.00',{exact:true}).waitFor();
  assert.equal(await position.getByText('▲ $25.00',{exact:true}).count(),2);
  assert.equal(await page.getByText('24h volume',{exact:true}).count(),0);
  await page.getByText('$114.20M',{exact:true}).waitFor();
  await page.getByText('$520.00',{exact:true}).waitFor();
  await page.getByText('$380.00',{exact:true}).waitFor();
  assert.equal(await page.getByText(/Indicative price|Historical candle close/).count(),0);
  await page.getByRole('region',{name:'Takes holding BTC',exact:true}).getByRole('link',{name:'Asset link fixture',exact:true}).waitFor();

  await page.getByRole('combobox',{name:'Holdings account'}).click();
  assert.equal(await page.getByRole('option',{name:'Select an account',exact:true}).count(),0);
  await page.getByRole('option',{name:'Second portfolio',exact:true}).click();
  await page.getByText('2 BTC · Avg —',{exact:true}).waitFor();await page.getByText('$1,000.00',{exact:true}).waitFor();
  await page.getByRole('combobox',{name:'Holdings account'}).click();
  await page.getByRole('option',{name:'Primary',exact:true}).click();
  await page.getByText('0.25 BTC · Avg $400.00',{exact:true}).waitFor();assert.equal(await page.getByText('2 BTC · Avg —',{exact:true}).count(),0);
  await page.getByRole('button',{name:'1w',exact:true}).click();
  await page.getByText('▲ 25.00% Past week',{exact:true}).waitFor();
  await page.getByRole('img',{name:'BTC-USD price chart',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/coinbase-market-detail.png'});
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:/BTC 0.25 BTC/}).click();
  await page.getByText('BTC-USD · Coinbase · Spot',{exact:true}).waitFor();
  await page.getByText('0.25 BTC · Avg $400.00',{exact:true}).waitFor();
  assert.match(await page.getByRole('combobox',{name:'Holdings account'}).innerText(),/Primary/);
  await page.getByRole('link',{name:'Takes',exact:true}).click();
  await page.getByRole('link',{name:/Asset link fixture/}).click();
  await page.getByRole('link',{name:'BTC instrument page',exact:true}).click();
  await page.getByText('BTC-USD · Coinbase · Spot',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('link',{name:'BTC instrument page',exact:true}).waitFor();
  await app.evaluate(()=>globalThis.fixtureAccounts.splice(1));
  await page.getByRole('link',{name:'BTC instrument page',exact:true}).click();
  await page.getByText('0.25 BTC · Avg $400.00',{exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Holdings account'}).count(),0);
 } finally {if(app)await closeDesktop(app).catch(()=>{});await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
