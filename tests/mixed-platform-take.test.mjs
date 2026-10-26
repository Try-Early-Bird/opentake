import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from './helpers/onboarding.mjs';
import {closeDesktop} from './helpers/desktop.mjs';
import {stopHost} from './helpers/host.mjs';

test('mixed Take keeps same-ticker assets separate and does not use Robinhood facts for Coinbase', {timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-mixed-take-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(8000);await page.setViewportSize({width:1400,height:900});await dismissConnectionPrompt(page,app);
  await page.evaluate(async()=>{
   const id=await window.takes.create();
   const result=await window.strategies.propose({targetTakeId:id,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID(),metadata:{title:'Mixed venue fixture',description:'Synthetic',rationale:'Synthetic',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:5000},{instrument:{venue:'coinbase',symbol:'VTI'},bps:5000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});
   if(!result.ok)throw Error(result.message);
  });
  await page.reload();await dismissConnectionPrompt(page,app);
  await page.getByRole('navigation',{name:'Takes',exact:true}).getByRole('button',{name:/^Mixed venue fixture|^New Take/}).first().click();
  const panel=page.getByRole('complementary',{name:'Take confirmation',exact:true});
  await panel.getByText(/Research basket · Coinbase/).waitFor();
  await panel.getByRole('button',{name:'Commit',exact:true}).click();
  await panel.getByRole('link',{name:'View take',exact:true}).click();
  await page.getByRole('heading',{name:'Mixed venue fixture',exact:true}).waitFor();
  const holdings=page.getByRole('region',{name:'Holdings',exact:true});
  await holdings.getByText('coinbase',{exact:true}).waitFor();
  assert.equal(await holdings.getByRole('link',{name:'VTI instrument page'}).count(),1);
  assert.equal(await holdings.getByText('VTI',{exact:true}).count(),2);
  await page.getByText('Coinbase and mixed-platform Takes are research baskets. Performance and funding are not available yet.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Invest',exact:true}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Key stats',exact:true}).count(),0);
  await holdings.scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/mixed-platform-take.png',fullPage:true});
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
