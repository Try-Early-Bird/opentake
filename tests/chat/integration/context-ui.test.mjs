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
test('condensed context is disclosed on its response without replacing the original transcript',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-context-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   const id='00000000-0000-4000-8000-000000000001',createdAt='2026-10-02T12:30:00Z',selection={provider:'claude',model:'sonnet'};
   const first={id:'00000000-0000-4000-8000-000000000002',parentId:null,role:'assistant',text:'Original evidence stays here.',images:[],createdAt,selection,state:'completed',tools:[]};
   const last={...first,id:'00000000-0000-4000-8000-000000000003',parentId:first.id,text:'Answer with condensed context.',context:{condensedMessages:4}};
   const take={id,title:'Context fixture',updatedAt:createdAt,archivedAt:null,headId:last.id,draft:'',draftImages:[],instructions:'',instructionProfileId:null,permissionMode:'auto',selection,messages:[first,last]};
   ipcMain.removeHandler('takes:snapshot');ipcMain.handle('takes:snapshot',(_e,selected)=>({revision:'context-fixture',running:false,takes:[{id,title:take.title,updatedAt:createdAt,archivedAt:null}],take:selected===id?take:null}));
  });
  await page.getByRole('button',{name:'Context fixture',exact:true}).click();
  await page.getByText('Original evidence stays here.',{exact:true}).waitFor();
  const summary=page.getByRole('button',{name:'4 earlier replies condensed',exact:true});assert.equal(await summary.count(),1);
  await summary.focus();await page.keyboard.press('Enter');
  await page.getByText('Excerpts from 4 older replies and their tool results were used.',{exact:false}).waitFor();
  assert.equal(await summary.getAttribute('aria-expanded'),'true');
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
