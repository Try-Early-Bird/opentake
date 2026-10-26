import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { dismissConnectionPrompt } from './helpers/onboarding.mjs';
import { stopHost } from './helpers/host.mjs';

test('Data Retention saves independent job and audit settings through the host',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-retention-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Data Retention',exact:true}).click();
  await page.getByRole('heading',{name:'Data Retention',exact:true}).waitFor();
  await page.locator('#ai-audit-retention').click();await page.getByRole('option',{name:'30 days',exact:true}).click();
  await page.waitForFunction(async()=>await window.settings.aiAuditRetention()===30);
  assert.equal(await page.evaluate(()=>window.settings.jobRetention()),null);
  await page.locator('#job-retention').click();await page.getByRole('option',{name:'7 days',exact:true}).click();
  await page.waitForFunction(async()=>await window.settings.jobRetention()===7);
  await page.reload();await dismissConnectionPrompt(page,app);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Data Retention',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-audit-retention')?.textContent?.includes('30 days'));
  assert.match(await page.locator('#job-retention').innerText(),/7 days/);
  await page.locator('#ai-audit-retention').click();await page.getByRole('option',{name:'Forever',exact:true}).click();
  await page.waitForFunction(async()=>await window.settings.aiAuditRetention()===null);
 }finally{if(app)await app.close();await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
