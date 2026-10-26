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
test('earlier messages preserve scroll, take pages append and older versions remain reachable',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-history-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  const hostPages=await page.evaluate(async()=>{for(let i=0;i<35;i++)await window.takes.create();const first=await window.takes.snapshot(null,false);const next=await window.takes.takesPage(false,first.takesNext);return [first.takes.length,next.items.length,next.next];});assert.deepEqual(hostPages,[30,5,null]);
  await app.evaluate(({ipcMain})=>{
   const id='00000000-0000-4000-8000-000000000001',createdAt='2026-10-02T12:30:00Z',selection={provider:'claude',model:'sonnet'};
   const messages=Array.from({length:61},(_,i)=>({id:'message-'+i,parentId:i?'message-'+(i-1):null,role:i%2?'assistant':'user',text:'History message '+i,images:[],createdAt,selection,state:'completed',tools:[],...(i===60?{versionNumber:35,versionCount:35}:{})}));
   let take={id,title:'Paged fixture',updatedAt:createdAt,archivedAt:null,headId:'message-60',draft:'',draftImages:[],instructions:'',instructionProfileId:null,permissionMode:'auto',selection,messages:messages.slice(-30)};let rev=1;
   for(const key of ['takes:snapshot','takes:messages-page','takes:takes-page','takes:message-versions','takes:update'])ipcMain.removeHandler(key);
   ipcMain.handle('takes:snapshot',(_e,selected,_archived,known)=>{const revision='fixture:'+rev+':'+selected;if(known===revision)return null;return {revision,running:false,mode:'replace',takes:[{id,title:take.title,updatedAt:createdAt,archivedAt:null}],takesNext:'older-takes',take:selected===id?take:null,messagesNext:rev===1?'older-messages':null};});
   ipcMain.handle('takes:messages-page',(_e,_id,cursor)=>({messages:cursor==='older-messages'?messages.slice(1,31):messages.slice(0,1),next:cursor==='older-messages'?'oldest':null}));
   ipcMain.handle('takes:takes-page',()=>({items:[{id:'older-take',title:'Older take fixture',updatedAt:createdAt,archivedAt:null}],next:null}));
   ipcMain.handle('takes:message-versions',(_e,_id,_message,cursor)=>({items:Array.from({length:cursor?5:30},(_,i)=>({id:'version-'+(cursor?5-i:35-i),number:cursor?5-i:35-i})),next:cursor?null:'older-versions'}));
   ipcMain.handle('takes:update',(_e,_id,patch)=>{if(patch.headId){take={...take,headId:patch.headId,messages:[{...messages[0],id:patch.headId,text:'Original version'}]};rev++;}});
  });
  await page.getByRole('button',{name:'Paged fixture',exact:true}).click();
  await page.getByText('History message 60',{exact:true}).waitFor();assert.equal(await page.getByText('History message 0',{exact:true}).count(),0);
  const earlier=page.getByRole('button',{name:'Load earlier messages',exact:true});await earlier.scrollIntoViewIfNeeded();const original=await page.getByText('History message 31',{exact:true}).boundingBox();await earlier.click();await page.getByText('History message 1',{exact:true}).waitFor();
  const after=await page.getByText('History message 31',{exact:true}).boundingBox();assert.ok(Math.abs(after.y-original.y)<10,`Scroll anchor moved ${after.y-original.y}px`);
  await earlier.click();await page.getByText('History message 0',{exact:true}).waitFor();assert.equal(await earlier.count(),0);
  await page.getByRole('button',{name:'Load older takes',exact:true}).click();await page.getByRole('button',{name:'Older take fixture',exact:true}).waitFor();
  await page.getByRole('button',{name:'Version 35 of 35',exact:true}).click();await page.getByRole('button',{name:'Older versions',exact:true}).click();await page.getByRole('button',{name:'Choose version 1',exact:true}).click();await page.getByText('Original version',{exact:true}).waitFor();assert.equal(await page.getByText('History message 60',{exact:true}).count(),0);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
