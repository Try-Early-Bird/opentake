import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';
import { closeDesktop } from './helpers/desktop.mjs';
import { stopHost } from './helpers/host.mjs';

test('Portfolio account menu shows saved balances, switches without leaked figures and remembers selection', {timeout:40000}, async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-account-selector-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.','--earlybird-test-no-secrets',`--user-data-dir=${profile}`],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await page.setViewportSize({width:1100,height:850});await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   for(const name of ['portfolio:snapshot','portfolio:refresh','coinbase:list'])ipcMain.removeHandler(name);
   const observedAt=new Date().toISOString();
   const accounts=[{id:'11111111-1111-4111-8111-111111111111',label:'Individual investing',venue:'robinhood',selected:true,available:true,balance:{totalValue:'63020.73',currency:'USD',observedAt}},{id:'22222222-2222-4222-8222-222222222222',label:'MCP',venue:'robinhood',selected:false,available:true,balance:{totalValue:'164.21',currency:'USD',observedAt}}];
   accounts.push({id:'33333333-3333-4333-8333-333333333333',label:'Opentake crypto',venue:'coinbase',selected:false,available:true,balance:{totalValue:'900',currency:'USD',observedAt}});
   ipcMain.handle('portfolio:snapshot',async(_event,id)=>{
    const account=accounts.find(a=>a.id===id)??accounts[0];
    if(globalThis.holdPortfolio && id===accounts[1].id) await new Promise(resolve=>{globalThis.releasePortfolio=resolve;});
    return {account,accounts,portfolio:{totalValue:account.balance.totalValue,currency:'USD',cash:null,buyingPower:null},resources:[{resource:'portfolio',observedAt,stale:false,state:'completed'}],spotPositions:account.venue==='coinbase'?[{instrumentRef:'coinbase:BTC',asset:'BTC',quantity:'0.00000001',marketValue:'900',availableValue:null,currency:'USD',isCash:false}]:[],history:[],positionHistory:[],positions:[],orders:[],executions:[],gaps:[]};
   });
   ipcMain.handle('portfolio:refresh',(_event,id)=>{globalThis.refreshAccount=id;});
   ipcMain.handle('coinbase:list',()=>({ok:true,connections:[{accountId:'33333333-3333-4333-8333-333333333333',label:'Opentake crypto',status:'connected',maskedReference:'••••3333',capabilities:{chat:true,accountRead:true,trading:false},permissions:{view:true,trade:false,transfer:false}}]}));
  });
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  const picker=page.getByRole('combobox',{name:'Select portfolio account'});
  await page.getByRole('heading',{name:'Individual investing',exact:true}).waitFor();
  await picker.click();
  await page.getByRole('option',{name:/MCP/}).waitFor();
  assert.match(await page.getByRole('option',{name:/MCP/}).textContent(),/\$164.21 total balance/);
  assert.match(await page.getByRole('option',{name:/Opentake crypto/}).textContent(),/\$900.00 total balance/);
  await page.screenshot({path:'/tmp/portfolio-account-menu.png'});
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'MCP',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sync latest portfolio'}).isDisabled(),true);
  await picker.click();await page.getByRole('option',{name:/Opentake crypto/}).click();
  await page.getByText('0.00000001 BTC',{exact:true}).waitFor();
  // Only the Coinbase holding row (it opens its details); no Robinhood row or link.
  assert.equal(await page.getByRole('button',{name:/BTC/}).count(),1);
  assert.equal(await page.getByText('$164.21',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Disconnect Robinhood'}).count(),0);
  assert.equal(await page.locator('a[href="/rh/BTC"]').count(),0);
  await page.getByRole('button',{name:'Sync latest portfolio'}).click();
  assert.equal(await app.evaluate(()=>globalThis.refreshAccount),'33333333-3333-4333-8333-333333333333');
  await page.getByText('0.00000001 BTC',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/coinbase-portfolio-holdings.png',fullPage:true});
  await page.getByRole('link',{name:'Opentake home'}).click();await page.getByRole('heading',{name:'Your money’s story starts with one belief.'}).waitFor();await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  await page.getByRole('heading',{name:'Opentake crypto',exact:true}).waitFor();
  // A late response for MCP must not paint over the newly selected Coinbase account.
  await app.evaluate(()=>{globalThis.holdPortfolio=true;});
  await picker.click();await page.getByRole('option',{name:/MCP/}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Loading portfolio"]'));
  await app.evaluate(async()=>{for(let i=0;i<100&&!globalThis.releasePortfolio;i++)await new Promise(r=>setTimeout(r,10));if(!globalThis.releasePortfolio)throw Error('Missing delayed account request');});
  await picker.click();await page.getByRole('option',{name:/Opentake crypto/}).click();
  await app.evaluate(()=>{globalThis.holdPortfolio=false;globalThis.releasePortfolio?.();});
  await page.getByText('0.00000001 BTC',{exact:true}).waitFor();
  // Only the Coinbase holding row (it opens its details); no Robinhood row or link.
  assert.equal(await page.getByRole('button',{name:/BTC/}).count(),1);
  assert.equal(await page.getByText('$164.21',{exact:true}).count(),0);
  await page.setViewportSize({width:520,height:800});await picker.click();
  await page.getByRole('option',{name:/Individual investing/}).waitFor();
  await page.screenshot({path:'/tmp/portfolio-account-menu-mobile.png'});
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
