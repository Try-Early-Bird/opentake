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

test('Auto and Ask pill defaults to Auto and persists independently for each take',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-permission-mode-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  const pill=page.getByRole('combobox',{name:'Tool approvals',exact:true});await pill.waitFor();assert.equal(await pill.innerText(),'Auto');
  await pill.click();await page.getByText('Use saved permissions. Required approvals still apply.',{exact:true}).waitFor();await page.getByRole('option',{name:/^Ask/}).click();
  await page.waitForFunction(async()=>{const snapshot=await window.takes.snapshot(null,false);return snapshot.takes.length===1;});
  const id=await page.evaluate(async()=>{const s=await window.takes.snapshot(null,false);return s.takes[0].id;});
  await page.waitForFunction(async id=>(await window.takes.snapshot(id,false)).take.permissionMode==='ask',id);await page.waitForFunction(()=>document.getElementById('chat-permissions')?.textContent==='Ask');assert.equal(await pill.innerText(),'Ask');
  await page.evaluate(id=>window.takes.update(id,{title:'Ask fixture'}),id);
  await page.getByRole('button',{name:'Ask fixture',exact:true}).waitFor();
  await page.getByRole('button',{name:'New Take',exact:true}).click();assert.equal(await pill.innerText(),'Auto');
  await page.getByRole('button',{name:'Ask fixture',exact:true}).click();await page.waitForFunction(()=>document.getElementById('chat-permissions')?.textContent==='Ask');
  await page.reload();await dismissConnectionPrompt(page,app);await page.getByRole('button',{name:'Ask fixture',exact:true}).click();await page.waitForFunction(()=>document.getElementById('chat-permissions')?.textContent==='Ask');
  await pill.click();await page.getByRole('option',{name:/^Auto/}).click();await page.waitForFunction(async id=>(await window.takes.snapshot(id,false)).take.permissionMode==='auto',id);
 }finally{
  if(app)await closeDesktop(app);
  await stopHost(profile);
  // Chromium helpers can release the Windows lockfile just after process exit.
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
