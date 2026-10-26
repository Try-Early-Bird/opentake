import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from '../../helpers/onboarding.mjs';
import {stopHost} from '../../helpers/host.mjs';
test('usage is accessible beside responses and budgets save across navigation',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-usage-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'AI settings',exact:true}).click();
  const budget=page.getByRole('spinbutton',{name:'Claude cost budget',exact:true});await budget.fill('0.25');await page.getByRole('spinbutton',{name:'Output token threshold',exact:true}).fill('1234');await page.getByRole('spinbutton',{name:'OpenCode cost threshold',exact:true}).fill('0.75');await page.getByRole('button',{name:'Save budget',exact:true}).click();await page.getByText('Budget saved.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.takes.budgets()),{claudeCostUsd:0.25,outputTokens:1234,opencodeCostUsd:0.75});
  await page.getByRole('button',{name:'General',exact:true}).click();await page.getByRole('button',{name:'AI settings',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Claude cost budget"]')?.value==='0.25');assert.equal(await budget.inputValue(),'0.25');assert.equal(await page.getByRole('spinbutton',{name:'Output token threshold',exact:true}).inputValue(),'1234');assert.equal(await page.getByRole('spinbutton',{name:'OpenCode cost threshold',exact:true}).inputValue(),'0.75');
  // Automatic run limits default sensibly, save, and persist across navigation.
  const minutes=page.getByRole('spinbutton',{name:'Run time (minutes)',exact:true});assert.equal(await minutes.inputValue(),'5');
  assert.equal(await page.getByRole('spinbutton',{name:'Model turns',exact:true}).inputValue(),'20');
  await minutes.fill('2');await page.getByRole('spinbutton',{name:'Model turns',exact:true}).fill('8');await page.getByRole('spinbutton',{name:'Output tokens',exact:true}).fill('20000');
  await page.getByRole('button',{name:'Save automatic run limits',exact:true}).click();await page.getByText('Automatic run limits saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'General',exact:true}).click();await page.getByRole('button',{name:'AI settings',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Model turns"]')?.value==='8');
  assert.equal(await minutes.inputValue(),'2');assert.equal(await page.getByRole('spinbutton',{name:'Output tokens',exact:true}).inputValue(),'20000');
  await page.getByRole('heading',{name:'Automatic runs',exact:true}).screenshot({path:'/tmp/automatic-run-limits-heading.png'}).catch(()=>{});
  await app.evaluate(({ipcMain})=>{
   const id='00000000-0000-4000-8000-000000000001',message='00000000-0000-4000-8000-000000000002',createdAt='2026-10-02T12:30:00Z';
   const usage={source:'Claude CLI',costKind:'api-equivalent',partial:true,inputTokens:1234,outputTokens:56,costUsd:0.02};
   const take={id,title:'Usage fixture',updatedAt:createdAt,archivedAt:null,headId:message,draft:'',draftImages:[],instructions:'',instructionProfileId:null,permissionMode:'auto',selection:{provider:'claude',model:'sonnet'},messages:[{id:message,parentId:null,role:'assistant',text:'Synthetic answer',images:[],createdAt,selection:{provider:'claude',model:'sonnet'},state:'failed',tools:[],usage}]};
   ipcMain.removeHandler('takes:snapshot');ipcMain.handle('takes:snapshot',(_e,selected)=>({revision:'usage-fixture',running:false,takes:[{id,title:take.title,updatedAt:createdAt,archivedAt:null}],take:selected===id?take:null}));
  });
  await page.getByRole('link',{name:'Opentake home',exact:true}).click();await page.getByRole('button',{name:'Usage fixture',exact:true}).click();
  await page.getByText('Synthetic answer',{exact:true}).waitFor();
  assert.equal(await page.locator('time[datetime="2026-10-02T12:30:00Z"]').count(),1);
  await page.getByRole('button',{name:'Response usage',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Response usage',exact:true});await dialog.getByText('1,234',{exact:true}).waitFor();await dialog.getByText('$0.02',{exact:true}).waitFor();assert.ok(await dialog.getByText('Unavailable',{exact:true}).count()>0);await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
