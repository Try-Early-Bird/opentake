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

test('reuse a connected Coinbase portfolio across Takes and keep unfunded Takes out of Portfolio', {timeout:45000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-account-plans-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(8000);await page.setViewportSize({width:1400,height:1000});await dismissConnectionPrompt(page,app);
  const fixtures=await page.evaluate(async()=>{
   const values=[];
   for(const title of ['Shared idea one','Shared idea two']){
    const id=await window.takes.create();
    const result=await window.strategies.propose({targetTakeId:id,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID(),metadata:{title,description:'Synthetic account plan',rationale:'Synthetic',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:4000},{instrument:{venue:'robinhood',symbol:'VTI'},bps:6000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});
    if(!result.ok)throw Error(result.message);
    const committed=await window.strategies.commit({targetTakeId:id,expectedRevision:result.view.draft.id,expectedVersion:null,operationId:crypto.randomUUID()});if(!committed.ok)throw Error(committed.message);
    const plan=await window.strategies.accountPlan(id);
    const saved=await window.strategies.saveAccountPlan({takeId:id,draftRevision:plan.draftRevision,revision:plan.revision,routes:[]});
    if(!saved.revision || (await window.strategies.accountPlan(id)).revision!==saved.revision)throw Error('Account plan bridge did not persist');
    values.push({takeId:id,strategyId:result.view.strategyId,draftRevision:result.view.draft.id,title});
   }
   return values;
  });
  await app.evaluate(({ipcMain},fixtures)=>{
   const observedAt=new Date().toISOString();
   const accounts=[{id:'11111111-1111-4111-8111-111111111111',venue:'coinbase',label:'Shared Opentake portfolio',available:true,selected:false,disabledReason:null,otherTakeCount:2,balances:[{asset:'USD',amount:'42.10'},{asset:'USDC',amount:'100'}]},{id:'22222222-2222-4222-8222-222222222222',venue:'robinhood',label:'Individual investing',available:true,selected:true,disabledReason:null,otherTakeCount:0,balances:[{asset:'USD',amount:'312.08'}]}];
   accounts.push({id:'55555555-5555-4555-8555-555555555555',venue:'coinbase',label:'Personal',available:true,disabledReason:null,otherTakeCount:0,balances:[{asset:'USD',amount:'0'}]});
   accounts.push({id:'44444444-4444-4444-8444-444444444444',venue:'coinbase',label:'Trading desk',available:true,disabledReason:'Key can’t trade — read-only',otherTakeCount:0,balances:[{asset:'USD',amount:'0.01'},{asset:'USDC',amount:'50339.39'}]});
   accounts.push({id:'66666666-6666-4666-8666-666666666666',venue:'coinbase',label:'Savings',available:true,disabledReason:null,otherTakeCount:0,balances:[{asset:'USD',amount:'0'}]});
   accounts.push({id:'77777777-7777-4777-8777-777777777777',venue:'coinbase',label:'Reserve',available:true,disabledReason:null,otherTakeCount:0,balances:[{asset:'USD',amount:'0'}]});
   const plans=new Map(fixtures.map(f=>[f.takeId,{...f,revision:null,editable:true,reason:null,accounts,routes:[{venue:'coinbase',accountId:null,assets:[{symbol:'BTC',bps:4000}]},{venue:'robinhood',accountId:null,assets:[{symbol:'VTI',bps:6000}]}]}]));
   globalThis.accountPlanSaves=[];
   for(const name of ['strategies:account-plan','strategies:save-account-plan','portfolio:snapshot','portfolio:refresh'])ipcMain.removeHandler(name);
   ipcMain.handle('strategies:account-plan',(_event,id)=>plans.get(id));
   ipcMain.handle('strategies:save-account-plan',(_event,input)=>{
    globalThis.accountPlanSaves.push(input);const plan=plans.get(input.takeId);
    if(plan.revision!==input.revision)throw Error('Stale plan');
    plan.revision='33333333-3333-4333-8333-333333333333';
    plan.routes=plan.routes.map(r=>({...r,accountId:input.routes.find(item=>item.venue===r.venue)?.accountId??null}));return plan;
   });
   ipcMain.handle('portfolio:refresh',()=>{throw Error('No provider calls expected');});
   ipcMain.handle('portfolio:snapshot',(_event,id)=>{
    const account=accounts.find(a=>a.id===id)??accounts[1];
    const plannedTakes=[...plans.values()].flatMap(plan=>plan.routes.filter(route=>route.accountId===account.id).map(route=>({takeId:plan.takeId,strategyId:plan.strategyId,title:plan.title,venue:route.venue,assets:route.assets})));
    return {account,accounts,plannedTakes,portfolio:{totalValue:'1000',cash:null,buyingPower:null,currency:'USD'},resources:['portfolio','equity_positions','option_positions'].map(resource=>({resource,state:'completed',observedAt,stale:false})),history:[],positions:[],spotPositions:[],positionHistory:[],orders:[],executions:[],gaps:[]};
   });
  },fixtures);
  await page.reload();await dismissConnectionPrompt(page,app);
  const takeList=page.getByRole('navigation',{name:'Takes',exact:true});
  const panel=page.getByRole('complementary',{name:'Take confirmation',exact:true});
  const plan=page.getByRole('region',{name:'Accounts for this take',exact:true});
  const choose=async(venue,label)=>{
   const group=plan.getByRole('group',{name:`${venue==='coinbase'?'Coinbase':'Robinhood'} account`,exact:true});
   await group.getByRole('radio',{name:label,exact:true}).click();
   // The choice saves and closes the picker; Change appears only when the platform has more than one account.
   await group.getByRole('radiogroup').waitFor({state:'detached'});
  };
  for(const title of ['Shared idea one','Shared idea two']){
   await page.getByRole('link',{name:'Opentake home',exact:true}).click();
   await takeList.getByRole('button',{name:new RegExp('^'+title)}).click();
   assert.equal(await panel.getByRole('region',{name:'Accounts for this take',exact:true}).count(),0);
   await panel.getByRole('link',{name:'Invest',exact:true}).click();
   await choose('coinbase','Shared Opentake portfolio');
   if(title==='Shared idea one')await choose('robinhood','Individual investing');
   assert.equal(await plan.getByRole('button',{name:'Save accounts',exact:true}).count(),0);
  }
  assert.equal((await app.evaluate(()=>globalThis.accountPlanSaves)).length,3);
  await page.getByRole('link',{name:'Portfolio',exact:true}).click();
  const picker=page.getByRole('combobox',{name:'Select portfolio account'});
  await picker.click();await page.getByRole('option',{name:/Shared Opentake portfolio/}).click();
  // Takes that hold nothing yet are not listed in Portfolio; funded Takes appear under Positions.
  await page.getByRole('heading',{name:'Positions',exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Planned takes',exact:true}).count(),0);
  assert.equal(await page.getByText('Not funded',{exact:true}).count(),0);
  // Reopen the Take: saved account choices survive component unmounts.
  await page.getByRole('link',{name:'Opentake home',exact:true}).click();
  await takeList.getByRole('button',{name:/^Shared idea one/}).click();
  await panel.getByRole('link',{name:'Invest',exact:true}).click();
  const detailPlan=page.getByRole('region',{name:'Accounts for this take',exact:true});
  await detailPlan.getByRole('button',{name:'Change Coinbase account',exact:true}).waitFor();
  await detailPlan.getByText('USD 42.10 · USDC 100.00',{exact:true}).waitFor();
  await detailPlan.screenshot({path:'/tmp/take-account-plan.png',animations:'disabled'});
  await detailPlan.getByRole('button',{name:'Change Coinbase account',exact:true}).click();
  assert.equal(await detailPlan.getByRole('radio',{name:'Trading desk',exact:true}).isDisabled(),true);
  await detailPlan.getByText('Key is read-only',{exact:true}).waitFor();
  await detailPlan.getByText('USD 0.01 · USDC 50,339.39',{exact:true}).waitFor();
  assert.equal(await detailPlan.getByRole('radio',{name:'Shared Opentake portfolio',exact:true}).getAttribute('aria-checked'),'true');
  const accountList=detailPlan.getByRole('radiogroup',{name:'Coinbase accounts'});
  assert.equal(await accountList.evaluate(el=>el.scrollHeight>el.clientHeight),true);
  await detailPlan.screenshot({path:'/tmp/take-account-plan-expanded.png',animations:'disabled'});
  // Switching Coinbase saves immediately and preserves the Robinhood route.
  await detailPlan.getByRole('radio',{name:'Personal',exact:true}).click();
  await detailPlan.getByRole('button',{name:'Change Coinbase account',exact:true}).waitFor();
  const latest=await app.evaluate(()=>globalThis.accountPlanSaves.at(-1));
  assert.deepEqual(latest.routes,[{venue:'coinbase',accountId:'55555555-5555-4555-8555-555555555555'},{venue:'robinhood',accountId:'22222222-2222-4222-8222-222222222222'}]);
  await detailPlan.getByRole('button',{name:'Change Coinbase account',exact:true}).click();
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await detailPlan.screenshot({path:'/tmp/take-account-plan-dark.png',animations:'disabled'});
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
