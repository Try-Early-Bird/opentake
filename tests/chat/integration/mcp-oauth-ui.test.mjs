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

test('remote OAuth configuration and sign-in controls are available without exposing credentials',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-oauth-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  // Browser/keychain actions are synthetic. Config save/list use the real host.
  await app.evaluate(({ipcMain})=>{
   let state='disconnected';
   for(const channel of ['mcp:oauth-status','mcp:oauth-start','mcp:oauth-cancel','mcp:oauth-disconnect'])ipcMain.removeHandler(channel);
   ipcMain.handle('mcp:oauth-status',()=>({state}));
   ipcMain.handle('mcp:oauth-start',()=>{state='connecting';});
   ipcMain.handle('mcp:oauth-cancel',()=>{state='cancelled';});
   ipcMain.handle('mcp:oauth-disconnect',()=>{state='disconnected';});
  });
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'MCP servers & tools',exact:true}).click();
  await page.getByRole('button',{name:'Add server',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('tab',{name:'Local command',exact:true}).click();assert.equal(await dialog.getByRole('tab',{name:'Browser sign-in'}).count(),0);
  await dialog.getByRole('tab',{name:'Remote URL',exact:true}).click();
  await dialog.getByLabel('Name',{exact:true}).fill('Synthetic OAuth');await dialog.getByLabel('Server URL',{exact:true}).fill('https://mcp.example.test/mcp');
  await dialog.getByRole('tab',{name:'Browser sign-in',exact:true}).click();await dialog.locator('summary').filter({hasText:'Advanced OAuth settings'}).click();
  await dialog.getByLabel('Client ID (optional)',{exact:true}).fill('synthetic-client');await dialog.getByLabel('Callback port (optional)',{exact:true}).fill('54321');
  await dialog.getByRole('button',{name:'Connect server',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByText('Waiting for browser sign-in…',{exact:true}).waitFor();
  const config=(await page.evaluate(()=>window.mcp.list())).servers.find(s=>s.config.name==='Synthetic OAuth').config;
  assert.equal(config.oauth,true);assert.equal(config.oauthClientId,'synthetic-client');assert.equal(config.oauthRedirectPort,54321);assert.deepEqual(config.bindings,[]);
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();await page.getByText('Sign-in cancelled or expired',{exact:true}).waitFor();
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('mcp:oauth-status');ipcMain.handle('mcp:oauth-status',()=>({state:'connected'}));});
  await page.getByText('Signed in',{exact:true}).waitFor();await page.getByRole('button',{name:'Load tools & enable',exact:true}).waitFor();await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor();
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('mcp:oauth-status');ipcMain.handle('mcp:oauth-status',()=>({state:'disconnected'}));});
  await page.getByRole('button',{name:'Disconnect sign-in',exact:true}).click();await page.getByText('Not signed in',{exact:true}).waitFor();
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
