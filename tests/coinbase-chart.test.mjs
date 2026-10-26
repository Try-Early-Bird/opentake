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
test('Coinbase chart keeps the left hover time inside the plot and exposes history coverage', {timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'coinbase-chart-'));let app;
 try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
 app=await electron.launch({executablePath,args:['.','--earlybird-test-no-secrets',`--user-data-dir=${profile}`],env});
 const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
 await app.evaluate(({ipcMain})=>{
  ipcMain.removeHandler('portfolio:snapshot');
  ipcMain.handle('portfolio:snapshot',()=>{
   const account={id:'11111111-1111-4111-8111-111111111111',venue:'coinbase',label:'Synthetic Coinbase',available:true,selected:false};
   return {account,accounts:[account],portfolio:{totalValue:'105',currency:'USD',cash:null,buyingPower:null},resources:[{resource:'portfolio',observedAt:new Date().toISOString(),stale:false,state:'completed'}],history:Array.from({length:24},(_,i)=>({observedAt:new Date(Date.now()-(23-i)*3600000).toISOString(),totalValue:String(100+i/5),currency:'USD'})),spotPositions:[],positions:[],positionHistory:[],orders:[],executions:[],gaps:[],coinbaseHistory:{state:'partial',checkedAt:new Date().toISOString(),transactionCount:0,walletCount:1,completedWallets:0,issue:'access'}};
  });
 });
 await page.getByRole('link',{name:'Portfolio',exact:true}).click();await page.getByText('Past 24h',{exact:true}).waitFor();
 for(const width of [1100,520]){
  await page.setViewportSize({width,height:850});
  const chart=page.getByRole('img',{name:'Portfolio value over time'});const box=await chart.boundingBox();
  await page.mouse.move(box.x+2,box.y+box.height/2);
  const label=chart.locator('.recharts-tooltip-wrapper').locator('div').first();await label.waitFor({state:'visible'});
  const labelBox=await label.boundingBox();assert.ok(labelBox.x>=box.x,`Left hover label clipped at ${width}px`);
 }
 await page.screenshot({path:'/tmp/coinbase-chart-left-label.png'});
 await page.mouse.move(5,5);await page.getByRole('button',{name:'About balance change'}).hover();
 await page.getByText('Coinbase did not grant transaction-history access for this key. The chart uses saved balance snapshots.').waitFor();
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
