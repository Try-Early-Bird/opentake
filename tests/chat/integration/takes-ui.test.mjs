import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { stopHost } from '../../helpers/host.mjs';

test('Take sidebar opens Archived above connections and returns through the caret', {timeout:30000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-takes-ui-'));
 let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(5000);await dismissConnectionPrompt(page,app);
  await page.evaluate(async()=>{
   const active=await window.takes.create();await window.takes.update(active,{title:'Active synthetic take'});
   const archived=await window.takes.create();await window.takes.update(archived,{title:'Archived synthetic take',archived:true});
  });
  const sidebar=page.getByRole('complementary',{name:'Take history'});
  await sidebar.getByRole('button',{name:'Active synthetic take',exact:true}).waitFor();
  assert.equal(await sidebar.getByText('Show archived takes',{exact:true}).count(),0);
  const action=sidebar.getByRole('button',{name:'Archived',exact:true});
  const connections=sidebar.getByRole('link',{name:'Manage connections ↗',exact:true});
  assert.ok((await action.boundingBox()).y<(await connections.boundingBox()).y);
  await action.click();await sidebar.getByRole('button',{name:'Archived synthetic take',exact:true}).waitFor();
  assert.equal(await sidebar.getByRole('button',{name:'Active synthetic take',exact:true}).count(),0);
  const back=sidebar.getByRole('button',{name:'Back to takes',exact:true});
  assert.equal((await back.textContent()).trim(),'');
  await back.click();await sidebar.getByRole('button',{name:'Active synthetic take',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>typeof window.chat.send),'undefined');
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});

test('chat polling errors use dismissible deduplicated toasts and clear on recovery', {timeout:30000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-toast-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(5000);await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   globalThis.toastFixture={fail:true,takes:0,approvals:0};
   ipcMain.removeHandler('takes:snapshot');ipcMain.removeHandler('mcp:approvals');
   ipcMain.handle('takes:snapshot',()=>{globalThis.toastFixture.takes++;if(globalThis.toastFixture.fail)throw new Error('Synthetic outage');return {revision:'recovered',takes:[],take:null,running:false};});
   ipcMain.handle('mcp:approvals',()=>{globalThis.toastFixture.approvals++;if(globalThis.toastFixture.fail)throw new Error('Synthetic outage');return [];});
  });
  const notices=page.getByRole('complementary',{name:'Notifications'});
  await notices.getByText('Could not load takes. Retrying…',{exact:true}).waitFor();
  await notices.getByText('Could not check tool approvals. Retrying…',{exact:true}).waitFor();
  assert.equal(await page.locator('form [role="alert"]').count(),0);
  await notices.getByRole('button',{name:'Dismiss notification'}).first().click();
  await notices.getByRole('button',{name:'Dismiss notification'}).click();
  const before=await app.evaluate(()=>({...globalThis.toastFixture}));
  // Wait for repeated actual polls, not just one render of the failure state.
  for(let i=0;i<30;i++){
   const value=await app.evaluate(()=>globalThis.toastFixture);
   if(value.takes>=before.takes+3&&value.approvals>=before.approvals+3)break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  const after=await app.evaluate(()=>globalThis.toastFixture);
  assert.ok(after.takes>=before.takes+3&&after.approvals>=before.approvals+3);
  assert.equal(await notices.getByRole('alert').count(),0);
  await app.evaluate(()=>{globalThis.toastFixture.fail=false;});
  await page.getByRole('button',{name:'New Take',exact:true}).first().click();
  await new Promise(resolve=>setTimeout(resolve,1000));
  await app.evaluate(()=>{globalThis.toastFixture.fail=true;});
  await notices.getByText('Could not load takes. Retrying…',{exact:true}).waitFor();
  await app.evaluate(()=>{globalThis.toastFixture.fail=false;});
  await page.waitForFunction(()=>document.querySelectorAll('aside[aria-label="Notifications"] [role="alert"]').length===0);
  await page.locator('input[type=file]').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(2*1024*1024+1)});
  await page.locator('form [role="alert"]').filter({hasText:'Image support is not verified for this model. PDFs are supported separately.'}).waitFor();
  assert.equal(await notices.getByRole('alert').count(),0);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});

test('current Take chat offers starters, renders tool activity, keeps history and stops replies', { timeout: 30_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'opentake-home-chat-'));
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ executablePath, args: ['.', '--earlybird-test-no-secrets', `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow(); await page.setViewportSize({width:1440,height:900}); page.setDefaultTimeout(5000);
    await dismissConnectionPrompt(page, application);
    await application.evaluate(({ ipcMain }) => {
      for (const name of ['takes:snapshot','takes:create','takes:send','takes:stop','takes:update','chat:models','ai:status']) ipcMain.removeHandler(name);
      ipcMain.handle('ai:status', () => [{ provider: 'claude', status: 'connected' }]);
      const takes=[];let revision=0;let next=0;
      ipcMain.handle('takes:snapshot',(_event,id,archived,known)=>{
        const version=String(revision)+':'+id+':'+archived;if(known===version)return null;
        return {revision:version,takes:takes.filter(t=>!!t.archivedAt===archived),take:takes.find(t=>t.id===id)??null,running:takes.some(t=>t.running)};
      });
      ipcMain.handle('takes:create',()=>{const id='take-'+(++next);takes.unshift({id,title:'New Take',messages:[],headId:null,draft:'',draftImages:[],instructions:'',archivedAt:null,selection:{provider:'claude',model:'claude-discovered'}});revision++;return id;});
      ipcMain.handle('takes:update',(_event,id,patch)=>{Object.assign(takes.find(t=>t.id===id),patch);revision++;});
      ipcMain.handle('chat:models', (_event, provider) => ({ ok: true, source: 'runtime', models: [{ value: provider + '-discovered', label: 'Claude Sonnet fixture', resolvedModel: 'claude-sonnet-fixture', description: 'Synthetic model' }] }));
      ipcMain.handle('takes:send', (_event, request) => {
        if(request.selection.provider!=='claude'||request.selection.model!=='claude-discovered')throw new Error('Unexpected model selection');
        const take=takes.find(t=>t.id===request.takeId);const now=new Date().toISOString();const uid='user-'+(++next);const aid='assistant-'+(++next);
        take.messages.push({id:uid,parentId:take.headId,role:'user',text:request.text,images:[],tools:[],createdAt:now,selection:request.selection,state:'completed'},
          {id:aid,parentId:uid,role:'assistant',text:'Synthetic portfolio response.',images:[],createdAt:now,selection:request.selection,state:'running',tools:[{id:'tool-1',name:'robinhood_get_portfolio',state:'completed',startedAt:now}]});
        take.headId=aid;take.title=request.text;take.running=true;revision++;
      });
      ipcMain.handle('takes:stop',(_event,id)=>{const take=takes.find(t=>t.id===id);take.running=false;const reply=take.messages.at(-1);reply.state='cancelled';reply.error='Response stopped.';revision++;});
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    await page.getByRole('heading', { name: 'Your money’s story starts with one belief.' }).waitFor();
    assert.equal(await page.getByText('Your chats', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Choose AI model', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connect ChatGPT', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: 'Connect Local model', exact: true }).waitFor();
    assert.equal(await page.getByText(/coming soon/i).count(), 0);
    // Connecting from the picker opens the setup modal in place instead of leaving the chat.
    await page.getByRole('menuitem', { name: 'Add key for OpenCode Zen', exact: true }).click();
    await page.getByRole('dialog').getByText('Connect OpenCode Zen', { exact: true }).waitFor();
    assert.doesNotMatch(page.url(), /settings/);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Choose AI model', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Refresh models', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Sonnet fixture', exact: true }).click();
    // Neither Enter in an empty composer nor submitting a form in the connect modal sends a message.
    await page.getByLabel('Message Claude').press('Enter');
    await page.getByRole('button', { name: 'Choose AI model', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connect Local model', exact: true }).click();
    await page.getByRole('button', { name: 'Check and connect', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'Your money’s story starts with one belief.' }).waitFor();
    assert.equal(await page.getByText('Write a message or attach an image.').count(), 0);
    assert.equal(await page.getByText('Synthetic portfolio response.', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'US manufacturing is coming home', exact: true }).click();
    assert.equal(await page.getByLabel('Message Claude').inputValue(), 'US manufacturing is coming home');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Synthetic portfolio response.', { exact: true }).waitFor();
    await page.getByText('Used 1 tool', { exact: true }).click();
    await page.getByRole('listitem').filter({ hasText: 'Robinhood portfolio' }).waitFor();
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'You stopped this reply' }).waitFor();
    await page.getByRole('button', { name: 'New Take', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Your money’s story starts with one belief.' }).waitFor();
    await page.getByRole('navigation', { name: 'Takes', exact: true }).getByRole('button').first().click();
    await page.getByText('Synthetic portfolio response.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Opentake home', exact: true }).click();
    await page.getByRole('navigation', { name: 'Takes', exact: true }).getByRole('button').first().waitFor();
  } finally {
    if (application) await closeDesktop(application);
    await stopHost(userData); await rm(userData, { recursive: true, force: true });
  }
});
