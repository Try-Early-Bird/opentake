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

test('platform verification is optional, persists in Settings and uses platform terminology',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-platform-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'MCP servers & tools',exact:true}).click();
  const toggle=page.getByRole('switch',{name:'Verify platform data access',exact:true});
  await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'false');
  await toggle.click();await page.waitForFunction(async()=> (await window.mcp.platformSettings()).verify===true);
  await page.reload();await dismissConnectionPrompt(page,app);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'MCP servers & tools',exact:true}).click();await toggle.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-labelledby="platform-verification-label"]')?.getAttribute('aria-checked')==='true');
  assert.equal(await page.getByText('Opentake platforms',{exact:true}).count(),1);
  assert.equal(await page.getByText('Opentake brokerage',{exact:true}).count(),0);
  await toggle.click();await page.waitForFunction(async()=> (await window.mcp.platformSettings()).verify===false);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});

test('platform verification prompt names the AI provider and handles allow and decline',{timeout:30000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-platform-prompt-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   globalThis.platformFixture={pending:true,decisions:[]};
   ipcMain.removeHandler('mcp:platform-pending');ipcMain.removeHandler('mcp:platform-decide');
   ipcMain.handle('mcp:platform-pending',()=>globalThis.platformFixture.pending?[{id:'synthetic',run_id:'synthetic-run',provider:'claude',expires_at:new Date(Date.now()+120000).toISOString()}]:[]);
   ipcMain.handle('mcp:platform-decide',(_event,id,approved)=>{globalThis.platformFixture.decisions.push({id,approved});globalThis.platformFixture.pending=false;});
  });
  const prompt=page.getByRole('region',{name:'Platform data verification'});
  await prompt.getByText('Share account data with Claude?',{exact:true}).waitFor();
  await prompt.getByRole('button',{name:'Allow for this take',exact:true}).click();await prompt.waitFor({state:'hidden'});
  await app.evaluate(()=>{globalThis.platformFixture.pending=true;});await prompt.waitFor();await prompt.getByRole('button',{name:'Decline',exact:true}).click();await prompt.waitFor({state:'hidden'});
  assert.deepEqual(await app.evaluate(()=>globalThis.platformFixture.decisions),[{id:'synthetic',approved:true},{id:'synthetic',approved:false}]);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
