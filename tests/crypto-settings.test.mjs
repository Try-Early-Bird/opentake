import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from './helpers/onboarding.mjs';
import {closeDesktop} from './helpers/desktop.mjs';
import {stopHost} from './helpers/host.mjs';
test('Crypto dust setting defaults on, persists, and never changes portfolio totals',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'crypto-settings-'));let app;
 try {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.','--earlybird-test-no-secrets',`--user-data-dir=${profile}`],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);const initialUrl=page.url();
  await app.evaluate(({ipcMain})=>{
   ipcMain.removeHandler('portfolio:snapshot');ipcMain.handle('portfolio:snapshot',()=>{
    const account={id:'11111111-1111-4111-8111-111111111111',venue:'coinbase',label:'Synthetic Coinbase',available:true,selected:false};
    return {account,accounts:[account],portfolio:{totalValue:'100.19',currency:'USD',cash:null,buyingPower:null},resources:[{resource:'portfolio',observedAt:new Date().toISOString(),stale:false,state:'completed'}],history:[],spotPositions:[{asset:'DUST',instrumentRef:'coinbase:DUST',quantity:'1',marketValue:'0.09',currency:'USD',isCash:false},{asset:'EDGE',instrumentRef:'coinbase:EDGE',quantity:'1',marketValue:'0.10',currency:'USD',isCash:false},{asset:'BTC',instrumentRef:'coinbase:BTC',quantity:'1',marketValue:'100',currency:'USD',isCash:false}],positions:[],positionHistory:[],orders:[],executions:[],gaps:[]};
   });
  });
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();await page.getByText('EDGE',{exact:true}).waitFor();
  assert.equal(await page.getByText('DUST',{exact:true}).count(),0);await page.getByText('$100.19',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Crypto',exact:true}).click();
  const threshold=page.getByRole('textbox',{name:'Minimum holding value (USD)'});
  assert.equal(await threshold.inputValue(),'0.10');
  await threshold.fill('.11');await threshold.press('Enter');
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();await page.getByText('BTC',{exact:true}).waitFor();
  assert.equal(await page.getByText('EDGE',{exact:true}).count(),0);await page.getByText('$100.19',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Crypto',exact:true}).click();
  const toggle=page.getByRole('switch',{name:'Hide small balances'});assert.equal(await toggle.getAttribute('aria-checked'),'true');await toggle.click();
  await page.goto(initialUrl);await dismissConnectionPrompt(page,app);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Crypto',exact:true}).click();await page.getByRole('switch',{name:'Hide small balances'}).waitFor();assert.equal(await page.getByRole('switch',{name:'Hide small balances'}).getAttribute('aria-checked'),'false');
  assert.equal(await page.getByRole('textbox',{name:'Minimum holding value (USD)'}).inputValue(),'0.11');
  await page.screenshot({path:'/tmp/coinbase-crypto-settings.png'});
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();await page.getByText('DUST',{exact:true}).waitFor();await page.getByText('$100.19',{exact:true}).waitFor();
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
