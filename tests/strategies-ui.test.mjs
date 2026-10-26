import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from './helpers/onboarding.mjs';
import {stopHost} from './helpers/host.mjs';

// A take's strategy lives in the persistent panel beside its chat:
// drafts come from the chat or Edit manually (a staged dialog), and are committed,
// revised, restored from history, archived and unarchived through real host RPC.
const spec=(vti,cash)=>({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:vti}],cashBps:cash},
 rebalance:{schedule:'quarterly',driftBandPoints:5,driftBandRelative:null}});
const metadata={title:'Synthetic long-term take',description:'A synthetic long-term portfolio.',rationale:'Diversification.',holdings:[{instrument:{venue:'robinhood',symbol:'VTI'},reason:'Broad exposure'}]};

test('a take’s strategy persists drafts, versions, rebalance settings and archive history through real host RPC', {timeout:120000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-strategies-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await dismissConnectionPrompt(page,app);await page.waitForFunction(async()=>{try{return !!(await window.activity.hostStatus()).pid;}catch{return false;}});
  // From 1280px the take list is a sidebar; below it, a dialog behind 'Open take history'.
  await page.setViewportSize({width:1400,height:900});
  const takes=page.getByRole('navigation',{name:'Takes',exact:true});
  const panel=page.getByRole('complementary',{name:'Take confirmation',exact:true});
  // The header shows "Revision N · date" and the footer the commit status; edit and history are the header's pencil and history icons.
  const status=async(revision,state,archived=false)=>{
   await panel.locator('header p').filter({hasText:new RegExp(`^Revision ${revision} ·.*${archived?' · Archived':''}$`)}).waitFor();
   await panel.locator('footer').getByText(state==='Draft'?'Not committed yet':state==='Committed'?/^Committed as version \d+$/:/^(\d+ uncommitted changes?|Uncommitted changes)$/).waitFor();
  };
  const menu=async name=>panel.getByRole('button',{name,exact:true});
  assert.equal(await page.getByRole('link',{name:'Strategies',exact:true}).count(),0,'The Strategies page is replaced by takes');

  // The first draft arrives as a proposal (manual creation is left out); the panel shows it.
  const take=await page.evaluate(()=>window.takes.create());
  await page.evaluate(async({take,metadata,spec})=>{await window.strategies.propose({targetTakeId:take,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID(),metadata,spec,unsupportedRequests:[]});},{take,metadata,spec:spec(9000,1000)});
  await page.reload();await dismissConnectionPrompt(page,app);
  await takes.getByRole('button',{name:/^Synthetic long-term take|^New Take/}).first().click();
  await status(1,'Draft');
  await panel.getByRole('heading',{name:'Synthetic long-term take',exact:true}).waitFor();
  await panel.getByText('Runs during market hours while you have money in this take.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Commit',exact:true}).click();await status(1,'Committed');
  // Nothing to commit: the button is gone rather than disabled.
  assert.equal(await panel.getByRole('button',{name:'Commit',exact:true}).count(),0);
  await panel.getByRole('link',{name:'Invest',exact:true}).waitFor();

  // Edit manually: the staged dialog keeps the saved values and saves a new draft.
  await (await menu('Edit manually')).click();
  const editor=page.getByRole('dialog');
  assert.equal(await editor.getByLabel('VTI weight',{exact:true}).inputValue(),'90');
  await editor.getByLabel('VTI weight',{exact:true}).fill('80');await editor.getByLabel('Cash weight',{exact:true}).fill('20');
  await editor.getByRole('button',{name:'Rules',exact:true}).last().click();
  assert.equal(await editor.getByLabel('Rebalance schedule').inputValue(),'quarterly');
  await editor.getByRole('button',{name:'Details',exact:true}).last().click();
  await editor.getByRole('button',{name:'Review',exact:true}).last().click();
  await editor.getByRole('button',{name:'Save draft',exact:true}).click();
  await status(2,'Uncommitted changes');
  // Against the committed version, the allocation strikes through the old weights and the footer counts the changes.
  const allocations=panel.getByRole('list',{name:'Proposed allocations',exact:true});
  await allocations.getByText('90%',{exact:true}).waitFor();await panel.locator('footer').getByText('2 uncommitted changes',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Commit',exact:true}).click();await status(2,'Committed');
  assert.equal(await allocations.getByText('90%',{exact:true}).count(),0);

  // History restores revision 1 as a new draft.
  await (await menu('History')).click();
  // History is its own view: each revision lists what changed, and Back returns to the take.
  await panel.getByRole('heading',{name:'History',exact:true}).waitFor();
  const revision2=panel.getByRole('article',{name:'Revision 2',exact:true});
  await revision2.getByText('VTI 90% → 80%',{exact:true}).waitFor();await revision2.getByText('Cash 10% → 20%',{exact:true}).waitFor();
  await panel.getByRole('article',{name:'Revision 1',exact:true}).getByRole('button',{name:'Apply',exact:true}).click();
  await status(3,'Uncommitted changes');
  await (await menu('History')).click();
  await panel.getByRole('article',{name:'Revision 3',exact:true}).getByText('Restored from revision 1',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'Back to take',exact:true}).click();await status(3,'Uncommitted changes');
  const current=await page.evaluate(t=>window.strategies.read(t),take);
  assert.equal(current.versions.length,2);assert.equal(current.draft.spec.target.cashBps,1000);assert.equal(current.draft.spec.rebalance.schedule,'quarterly');

  // Archive and unarchive from the chat header; an archived take's panel is read-only.
  await page.getByRole('button',{name:'Archive take',exact:true}).click();
  await page.getByRole('button',{name:'Archived',exact:true}).click();
  await page.getByRole('navigation',{name:'Archived',exact:true}).getByRole('button').first().click();
  await status(3,'Uncommitted changes',true);
  await (await menu('History')).waitFor();assert.equal(await panel.getByRole('button',{name:'Edit manually',exact:true}).count(),0);
  await page.getByRole('button',{name:'Delete take',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Unarchive take',exact:true}).click();
  await page.getByRole('button',{name:'Back to takes',exact:true}).click();
  await takes.getByRole('button').first().click();await (await menu('Edit manually')).waitFor();

  // The panel sits beside the chat, notices a new revision without navigation, and keeps the composer.
  await page.setViewportSize({width:1200,height:850});
  const conversation=page.getByRole('region',{name:'Conversation',exact:true});
  const panelBounds=await panel.boundingBox(),chatBounds=await conversation.boundingBox();
  assert.ok(panelBounds.x>=chatBounds.x+chatBounds.width-1,'The take panel belongs beside the chat');
  const composer=page.getByRole('textbox',{name:/^Message /});await composer.fill('Keep researching concentration risk');
  await page.evaluate(async t=>{const v=await window.strategies.read(t);await window.strategies.propose({targetTakeId:t,expectedRevision:v.draft.id,expectedVersion:v.currentVersion,operationId:crypto.randomUUID(),metadata:{...v.draft.metadata,description:'An updated proposal'},spec:v.draft.spec,unsupportedRequests:[]});},take);
  await status(4,'Uncommitted changes');
  assert.equal(await composer.inputValue(),'Keep researching concentration risk');
  assert.equal(await page.getByRole('dialog').count(),0);
  await page.setViewportSize({width:640,height:850});
  const compactPanel=await panel.boundingBox(),compactChat=await conversation.boundingBox();
  assert.ok(compactPanel.y>=compactChat.y+compactChat.height-1,'Small windows stack the panel below chat');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.setViewportSize({width:1200,height:850});

  // A synthetic assistant response in another take proposes changes to this one.
  // Keep real strategy reads and writes; stub only the chat response and its card reference.
  const source=await page.evaluate(async()=>{const id=await window.takes.create();await window.takes.update(id,{title:'Cross-chat research'});return id;});
  await page.setViewportSize({width:1400,height:900});
  await takes.getByRole('button',{name:'Cross-chat research',exact:true}).click();
  await page.getByLabel('Take title').waitFor();
  const fixture=await page.evaluate(async({source,target})=>({snapshot:await window.takes.snapshot(source,false),strategy:await window.strategies.read(target)}),{source,target:take});
  await app.evaluate(({ipcMain},{fixture,source,target})=>{
   const messageId='11111111-1111-4111-8111-111111111111';
   const message={id:messageId,parentId:null,role:'assistant',text:'A take fits this idea: broad equity exposure with a 10% cash reserve. Review the suggested allocation alongside our conversation, and we can refine the balance.',images:[],createdAt:new Date().toISOString(),selection:{provider:'claude',model:'synthetic'},state:'running',tools:[]};
   ipcMain.removeHandler('takes:snapshot');ipcMain.handle('takes:snapshot',(_event,id)=>id===source?{...fixture.snapshot,revision:`fixture:1:${source}:false`,mode:'replace',running:false,take:{...fixture.snapshot.take,headId:messageId,messages:[message]}}:null);
   ipcMain.removeHandler('strategies:message-proposals');ipcMain.handle('strategies:message-proposals',(_event,id)=>id===messageId?[{proposal:fixture.strategy.draft,targetTakeId:target},{proposal:fixture.strategy.proposals.at(-1),targetTakeId:target}]:[]);
  },{fixture,source,target:take});
  // A suggestion arriving mid-reply opens its take in the panel beside the chat.
  const cards=page.getByRole('complementary',{name:'Proposed take',exact:true});
  await cards.first().waitFor();
  await status(4,'Uncommitted changes');
  assert.equal(await page.getByLabel('Take title').inputValue(),'Cross-chat research');
  await page.setViewportSize({width:1360,height:850});
  await page.screenshot({path:'/tmp/opentake-strategy-side-panel.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  // The applied suggestion's card is badged and can be undone; an older card makes its suggestion the draft again.
  const first=cards.first();
  await first.getByText('Revision 4',{exact:true}).waitFor();await first.getByText('Applied · not committed',{exact:true}).waitFor();
  assert.equal(await first.getByRole('button',{name:'Apply',exact:true}).count(),0);
  await panel.getByRole('heading',{name:'Synthetic long-term take',exact:true}).waitFor();
  await first.getByRole('button',{name:'Undo',exact:true}).click();
  await status(5,'Uncommitted changes');
  await first.getByRole('button',{name:'Apply',exact:true}).waitFor();assert.equal(await first.getByText('Applied · not committed',{exact:true}).count(),0);
  const older=cards.last();
  await older.getByRole('button',{name:'Apply',exact:true}).click();
  await status(6,'Uncommitted changes');
  await older.getByText('Applied · not committed',{exact:true}).waitFor();
  // The card's performance link opens the take's own page, which leads back to the portfolio.
  await page.getByRole('link',{name:'See performance',exact:true}).first().click();
  await page.getByRole('heading',{name:fixture.strategy.title,exact:true}).waitFor();
  await page.getByRole('link',{name:'Portfolio',exact:true}).last().waitFor();
  assert.deepEqual(errors,[]);
 }finally{if(app){await stopHost(profile);await app.close();}await rm(profile,{recursive:true,force:true});}
});

test('manual review-note correction preserves the rest of the Take',{timeout:45000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-review-notes-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(8000);await page.setViewportSize({width:1400,height:1000});await dismissConnectionPrompt(page,app);
  const fixture=await page.evaluate(async()=>{
   const takeId=await window.takes.create();
   const payload={metadata:{title:'Review note correction',description:'Keep this description',rationale:'Keep this rationale',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:5000},{instrument:{venue:'coinbase',symbol:'ZEC'},bps:5000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:['Budget is entered when investing.','Fees are checked before placing orders.']};
   const result=await window.strategies.propose({...payload,targetTakeId:takeId,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID()});if(!result.ok)throw Error(result.message);
   return {takeId,payload};
  });
  await page.reload();await dismissConnectionPrompt(page,app);
  await page.getByRole('navigation',{name:'Takes',exact:true}).getByRole('button',{name:/^Review note correction/}).click();
  const panel=page.getByRole('complementary',{name:'Take confirmation',exact:true});
  await panel.getByRole('region',{name:'To review',exact:true}).waitFor();
  await panel.getByRole('button',{name:'Edit manually',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Rules',exact:true}).last().click();
  await dialog.getByRole('button',{name:'Details',exact:true}).last().click();
  await dialog.getByRole('button',{name:'Review',exact:true}).last().click();
  await dialog.getByRole('button',{name:'Remove review note 1',exact:true}).click();
  await dialog.getByRole('button',{name:'Remove review note 1',exact:true}).click();
  await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(await panel.getByRole('region',{name:'To review',exact:true}).count(),0);
  const saved=await page.evaluate(id=>window.strategies.read(id),fixture.takeId);
  assert.deepEqual(saved.draft.unsupportedRequests,[]);assert.deepEqual(saved.draft.spec,fixture.payload.spec);assert.deepEqual(saved.draft.metadata,fixture.payload.metadata);
 }finally{if(app){await stopHost(profile);await app.close();}await rm(profile,{recursive:true,force:true});}
});

for(const venues of [['coinbase'],['robinhood'],['coinbase','robinhood']])test(`holdings editor uses the Take venue: ${venues.join('+')}`,{timeout:45000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-editor-venue-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(8000);await page.setViewportSize({width:1400,height:1000});await dismissConnectionPrompt(page,app);
  await page.evaluate(async venues=>{
   const takeId=await window.takes.create();
   const result=await window.strategies.propose({targetTakeId:takeId,expectedRevision:null,expectedVersion:null,operationId:crypto.randomUUID(),metadata:{title:'Editor venue fixture',description:'',rationale:'',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:venues.map(venue=>({instrument:{venue,symbol:venue==='coinbase'?'BTC':'VTI'},bps:10000/venues.length})),cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});if(!result.ok)throw Error(result.message);
  },venues);
  await page.reload();await dismissConnectionPrompt(page,app);
  await page.getByRole('navigation',{name:'Takes',exact:true}).getByRole('button',{name:/^Editor venue fixture/}).click();
  await page.getByRole('button',{name:'Edit manually',exact:true}).click();
  const dialog=page.getByRole('dialog'),venue=dialog.getByLabel('Holding venue',{exact:true});
  assert.equal(await venue.inputValue(),venues.length===1?venues[0]:'');
  await dialog.getByLabel('New holding symbol',{exact:true}).fill('ETH');
  await dialog.getByRole('button',{name:'Add holding',exact:true}).click();
  if(venues.length>1){
   await dialog.getByText('Choose a venue for the new holdings.',{exact:true}).waitFor();
   assert.equal(await dialog.getByLabel('ETH weight',{exact:true}).count(),0);
   await venue.fill('coinbase');await dialog.getByLabel('New holding symbol',{exact:true}).fill('ETH');
   await dialog.getByRole('button',{name:'Add holding',exact:true}).click();
  }
  const added=dialog.locator('li').filter({has:page.getByLabel('ETH weight',{exact:true})});
  await added.getByText(venues[0],{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Paste list',exact:true}).click();
  await dialog.getByLabel('Paste holdings',{exact:true}).fill('SOL 10');
  await dialog.getByRole('button',{name:'Import pasted holdings',exact:true}).click();
  const imported=dialog.locator('li').filter({has:page.getByLabel('SOL weight',{exact:true})});
  await imported.getByText(venues[0],{exact:true}).waitFor();
 }finally{if(app){await stopHost(profile);await app.close();}await rm(profile,{recursive:true,force:true});}
});
