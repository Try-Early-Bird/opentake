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

test('server policies persist and Settings controls remain consistent',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-governance-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'General',exact:true}).click();
  const theme=page.getByRole('combobox',{name:'Theme',exact:true});const font=page.getByRole('combobox',{name:'Font',exact:true});
  const themeBox=await theme.boundingBox();const fontBox=await font.boundingBox();
  assert.equal(themeBox.width,fontBox.width);assert.equal(themeBox.height,fontBox.height);
  await theme.click();await page.getByRole('option',{name:'Dark',exact:true}).click();
  assert.equal((await theme.boundingBox()).width,fontBox.width);
  await page.getByRole('button',{name:'MCP servers & tools',exact:true}).click();
  await page.getByRole('combobox',{name:'Opentake platforms server policy',exact:true}).click();
  await page.getByRole('option',{name:'Ask each time',exact:true}).click();
  await page.waitForFunction(async()=> (await window.mcp.list()).servers.some(s=>s.config.name==='Opentake platforms'&&s.policy==='ask'));
  assert.equal(await page.getByRole('button',{name:'Tool-call history',exact:true}).count(),0);
  await page.reload();await dismissConnectionPrompt(page,app);
  assert.equal((await page.evaluate(()=>window.mcp.list())).servers[0].policy,'ask');
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});

test('sharing approvals name the destination and keep invocation details collapsed',{timeout:30000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-history-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   ipcMain.removeHandler('mcp:approvals');ipcMain.handle('mcp:approvals',()=>[{id:'synthetic',tool_name:'analyze',server_name:'Analysis service',destination:'https://example.test',platform_sharing:true,input:{symbols:['SYNTHETIC']},expires_at:new Date(Date.now()+120000).toISOString()}]);
  });
  const approval=page.getByRole('region',{name:'Tool approval'});await approval.getByText(/This conversation can access account data/).waitFor();assert.match(await approval.innerText(),/https:\/\/example.test/);
  assert.equal(await approval.locator('pre').isVisible(),false);
  await approval.getByRole('button',{name:'Details',exact:true}).click();assert.equal(await approval.locator('pre').isVisible(),true);
  assert.match(await approval.locator('pre').innerText(),/SYNTHETIC/);
  await approval.getByRole('button',{name:'Details',exact:true}).click();assert.equal(await approval.locator('pre').isVisible(),false);
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('mcp:approvals');ipcMain.handle('mcp:approvals',()=>[{id:'synthetic-portfolio',server_id:'00000000-0000-4000-8000-000000000001',tool_name:'robinhood_get_portfolio',server_name:'Opentake platforms',destination:'Built-in platform connection',platform_sharing:false,input:{accountRef:'synthetic-account'},expires_at:new Date(Date.now()+120000).toISOString()}]);});
  await approval.getByText('Chat wants to use Portfolio',{exact:true}).waitFor();
  assert.equal(await approval.locator('pre').isVisible(),false);
  // Collapsed, the card summarizes what it will send; the destination and expiry stay under Details.
  assert.doesNotMatch(await approval.innerText(),/Built-in platform connection|Expires/);
  await approval.getByRole('button',{name:'Allow once',exact:true}).waitFor();

 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
