import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
// The Rules window against a synthetic host (tests/fixtures/rule-review-ui).
const server=await createServer({configFile:false,resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom/client','@base-ui/react/switch','@base-ui/react/dialog','@tanstack/react-router']},plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:0,strictPort:true}});let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1380,height:1000},colorScheme:'dark'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/rule-review-ui/index.html');
 const requests=()=>page.evaluate(()=>window.fixtureRequests);
 const panel=page.getByRole('region',{name:'Take rules'});
 await panel.getByText('Rules',{exact:true}).waitFor();assert.equal(await panel.getByText(/on · 1 off/).count(),0);
 assert.equal(await panel.locator('[data-rule-id]').count(),4);
 await panel.getByText('permission change',{exact:false}).waitFor();
 // A trade waiting for approval shows first, the same on any venue.
 const approval=panel.getByRole('region',{name:'Trade approval'});await approval.getByText('Rule “Cash buffer” wants to reduce by $25').waitFor();
 await approval.getByText('Robinhood · Sell VTI $25.00').waitFor();
 await mkdir('.local/designs/rules-window',{recursive:true});await page.screenshot({path:'.local/designs/rules-window/panel.png'});
 await approval.getByRole('button',{name:'Approve'}).click();await approval.waitFor({state:'detached'});
 assert.equal((await requests()).filter(r=>r.action==='rule-trade-decide').length,1);
 // The Rules window: the list, a rule's tabs and its own switch.
 await panel.getByRole('button',{name:'Open'}).click();
 const dialog=page.getByRole('dialog');await dialog.getByText('BTC rules walkthrough · 3 on · 1 off').waitFor();
 await dialog.getByRole('button',{name:'3 changes to review'}).waitFor();
 const list=dialog.getByRole('navigation',{name:'Rules'});assert.equal(await list.locator('button').count(),4);
 assert.match(await list.locator('button',{hasText:'Old 82,500 alert'}).locator('span').first().getAttribute('class'),/line-through/);
 await list.getByRole('button',{name:/Check BTC moves/}).click();
 await dialog.getByText('On · agent assesses, no trading · Awaiting approval').waitFor();
 await dialog.getByText('1 of 3',{exact:true}).waitFor();await dialog.getByText('Agent ran · read its answer in the thread').waitFor();
 await page.screenshot({path:'.local/designs/rules-window/overview.png'});
 await dialog.getByRole('tab',{name:'Permissions'}).click();await dialog.getByText('Read rules · Read strategy',{exact:true}).waitFor();
 await dialog.getByText('5 min · 20 tool calls · 20 turns · 50k tokens · $1',{exact:true}).waitFor();
 await page.screenshot({path:'.local/designs/rules-window/permissions.png'});
 await dialog.getByRole('tab',{name:'Activity'}).click();await dialog.getByText('Didn’t run · needs a token limit set').waitFor();
 await page.screenshot({path:'.local/designs/rules-window/activity.png'});
 await dialog.getByRole('tab',{name:'Settings'}).click();await dialog.getByRole('button',{name:/Show prompt/}).click();await dialog.getByText(/news-driven/).waitFor();
 await dialog.getByText('No extra conditions, context or hold.').waitFor();
 await page.screenshot({path:'.local/designs/rules-window/settings.png'});
 await list.getByRole('button',{name:/Weekend drift check/}).click();
 const toggle=dialog.getByRole('switch',{name:'Weekend drift check on'});assert.equal(await toggle.isChecked(),false);await toggle.click();
 await dialog.getByText('BTC rules walkthrough · 4 on').waitFor();
 assert.deepEqual((await requests()).filter(r=>r.action==='rule-set-enabled'),[{action:'rule-set-enabled',takeId:'take',ruleId:'44444444-4444-4444-8444-444444444444',enabled:true}]);
 // Review: changed rules first, current against proposed, the permission summary.
 await dialog.getByRole('button',{name:'3 changes to review'}).click();
 await dialog.getByText('Review rule changes',{exact:true}).waitFor();
 const changes=dialog.getByRole('navigation',{name:'Proposed changes'});
 for(const name of ['Check BTC moves','Hedge on spikes','Old 82,500 alert'])await changes.getByRole('button',{name:new RegExp(name)}).waitFor();
 await dialog.getByText('Permission change · 1 rule').waitFor();
 const table=dialog.getByRole('table');await table.getByRole('row',{name:/Per trade/}).getByText('Up to $50').waitFor();await table.getByRole('row',{name:/Accounts/}).waitFor();
 await page.screenshot({path:'.local/designs/rules-window/review.png'});
 await dialog.getByRole('button',{name:'Accept 3 changes'}).click();
 await dialog.getByText('Rules',{exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:/changes to review/}).count(),0);
 assert.equal(await list.locator('button',{hasText:'Hedge on spikes'}).count(),1);
 // Deleting warns about the approval it cancels.
 await list.getByRole('button',{name:/Check BTC moves/}).click();await dialog.getByText('On · trades after you approve · Awaiting approval').waitFor();
 await dialog.getByRole('button',{name:'Delete rule'}).click();
 const confirm=page.getByRole('dialog',{name:'Delete “Check BTC moves”?'});await confirm.getByText('A rebalance is waiting for your approval').waitFor();
 await page.screenshot({path:'.local/designs/rules-window/delete.png'});
 await confirm.getByRole('button',{name:'Delete rule'}).click();await confirm.waitFor({state:'detached'});
 assert.equal(await list.locator('button',{hasText:'Check BTC moves'}).count(),0);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
 assert.deepEqual(errors,[]);
 console.log('Rules window: panel summary, tabs, per-rule switch, review and accept, delete with warning passed.');
}finally{await browser?.close();await server.close();}
