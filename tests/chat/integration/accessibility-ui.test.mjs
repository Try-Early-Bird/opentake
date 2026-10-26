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
test('chat history, menus and long content remain accessible at narrow widths',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-accessibility-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   const id='00000000-0000-4000-8000-000000000001',createdAt='2026-10-02T12:30:00Z',selection={provider:'claude',model:'sonnet'};
   const first={id:'00000000-0000-4000-8000-000000000002',parentId:null,role:'assistant',text:'Original evidence stays here.\n\n'+ 'longword'.repeat(80)+'\n\n| Column | Data |\n| --- | --- |\n| one | '+ 'wide'.repeat(100)+' |\n\n```text\n'+ 'code'.repeat(200)+'\n```',images:[],createdAt,selection,state:'completed',tools:[]};
   const last={...first,id:'00000000-0000-4000-8000-000000000003',parentId:first.id,text:'Answer with condensed context.',context:{condensedMessages:4}};
   const take={id,title:'Context fixture',updatedAt:createdAt,archivedAt:null,headId:last.id,draft:'',draftImages:[],instructions:'',instructionProfileId:null,permissionMode:'auto',selection,messages:[first,last]};
   ipcMain.removeHandler('takes:snapshot');ipcMain.handle('takes:snapshot',(_e,selected)=>({revision:'context-fixture',running:false,takes:[{id,title:take.title,updatedAt:createdAt,archivedAt:null}],take:selected===id?take:null}));
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:390,height:720});
  const history=page.getByRole('button',{name:'Open take history',exact:true});
  await history.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Take history',exact:true});await dialog.waitFor();
  for(let i=0;i<8;i++){await page.keyboard.press('Tab');await page.waitForFunction(()=>document.querySelector('[role=dialog]')?.contains(document.activeElement));assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);}
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await history.evaluate(el=>el===document.activeElement),true);
  await history.click();await dialog.getByRole('button',{name:'Archived',exact:true}).click();
  await dialog.getByRole('button',{name:'Back to takes',exact:true}).click();
  await dialog.getByRole('button',{name:'Context fixture',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByText('Answer with condensed context.',{exact:true}).waitFor();
  for(const width of [390,640,1024]){
   await page.setViewportSize({width,height:720});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const send=await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();
   assert.ok(send.x>=0&&send.x+send.width<=width&&send.y+send.height<=720);
   const region=page.getByRole('region',{name:'Conversation',exact:true});await region.focus();
   assert.equal(await region.evaluate(el=>el===document.activeElement),true);
  }
  await page.getByRole('status').filter({hasText:'Response completed.'}).waitFor();
  await page.getByRole('button',{name:'Copy',exact:true}).last().click();
  await page.getByRole('status').filter({hasText:'Message copied.'}).waitFor();
  const composer=page.getByRole('textbox',{name:'Message Claude',exact:true});
  assert.equal(await composer.getAttribute('aria-describedby'),'composer-help');
  await composer.fill('First line');await composer.press('Shift+Enter');await composer.press('a');
  assert.equal(await composer.inputValue(),'First line\na');
  const ai=page.getByRole('button',{name:'Choose AI model',exact:true});await ai.focus();await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Choose AI model');
  assert.equal(await ai.evaluate(el=>el===document.activeElement),true);
  for(const name of ['AI instructions','Tool approvals']){
   const trigger=page.getByRole('combobox',{name,exact:true});await trigger.focus();await page.keyboard.press('ArrowDown');
   await page.getByRole('listbox').waitFor();await page.keyboard.press('Escape');await page.getByRole('listbox').waitFor({state:'hidden'});
   assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  }
  const usage=page.getByRole('button',{name:'Response usage',exact:true}).last();await usage.focus();await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Response usage',exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Response usage',exact:true}).waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Response usage');
  assert.equal(await usage.evaluate(el=>el===document.activeElement),true);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
