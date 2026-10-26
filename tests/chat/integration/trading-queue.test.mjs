import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright-core';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const chrome=process.env.CHROME_PATH??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium');
const base={source:'strategy',detail:'Waiting for the open',reason:'market_closed',expectedAt:'2026-10-06T13:30:00Z',createdAt:'2026-10-05T15:00:00Z',link:{kind:'strategy',id:'synthetic'},actions:[]};
const trades=[{...base,id:'approval',state:'needs_you',title:'Invest · Synthetic',actions:['confirm'],approval:{summary:'Buy VTI',strategyName:'Synthetic'}},{...base,id:'withdrawal',state:'waiting',title:'Withdraw $50 · Synthetic',detail:'Waiting to settle',actions:['cancel']},{...base,id:'orders',state:'in_progress',title:'Orders · Synthetic',detail:'Buy BND, placing now'}];
test('Jobs combines trading and sync, routes actions and isolates failures',{skip:!existsSync(chrome),timeout:60000},async()=>{
 const entry='/__queue_test.jsx';
 const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {RouterProvider,createRouter,createRootRoute,createRoute,createMemoryHistory} from '@tanstack/react-router';import {ActivityQueue} from '/src/renderer/src/components/ActivityQueue.tsx';import {noteQueueActed,setWaitingOpen} from '/src/renderer/src/waiting-store.ts';import '/src/renderer/src/index.css';
 window.items=${JSON.stringify(trades)};window.calls=[];window.failAction=false;window.failTrading=false;window.failSync=false;window.refresh=noteQueueActed;window.openQueue=()=>setWaitingOpen(true);
 window.allocations={queueList:async()=>{if(window.failTrading)throw Error('offline');return {ok:true,items:window.items};},queueAct:async(id,action)=>{window.calls.push([id,action]);if(window.failAction)return {ok:false,status:409,message:'Synthetic order changed. Review again.'};window.items=window.items.filter(x=>x.id!==id);return {ok:true,items:window.items};}};
 window.activity={history:async()=>({jobs:[{id:'trade:synthetic',kind:'rebalance',state:'completed',attempts:0,reason:'schedule',errorCode:null,updatedAt:new Date().toISOString(),nextRunAt:new Date().toISOString(),execution:{strategyId:'synthetic',strategyTitle:'Synthetic take',symbol:'VTI',side:'buy',status:'filled'}}],nextCursor:null}),retry:async(id)=>{window.calls.push([id,'retry']);},list:async()=>{if(window.failSync)throw Error('sync offline');return window.syncJobs??[{id:'sync',kind:'portfolio_sync',state:'running',attempts:1,reason:'test',errorCode:null,updatedAt:'2026-10-05T15:00:00Z',nextRunAt:'2026-10-05T15:00:00Z'}];}};
 window.connections={status:async()=>({ok:true,connection:{accounts:[{id:'fixture',maskedNumber:'••••9709',selected:true}]}})};
 const root=createRootRoute({component:()=>React.createElement('div',{style:{position:'fixed',right:20,bottom:20}},React.createElement(ActivityQueue))});const detail=createRoute({getParentRoute:()=>root,path:'/strategies/$strategyId',component:()=>null});const history=createRoute({getParentRoute:()=>root,path:'/job-history',component:()=>null});const router=createRouter({routeTree:root.addChildren([detail,history]),history:createMemoryHistory({initialEntries:['/']})});createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));`;
 const server=await createServer({root,configFile:false,plugins:[react(),tailwind(),{name:'queue-fixture',resolveId(id){if(id===entry)return entry;},load(id){if(id===entry)return code;},configureServer(vite){vite.middlewares.use('/__queue_test',async(req,res,next)=>{if(req.url!=='/'&&req.url!==''){next();return;}try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__queue_test',`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));}catch(e){next(e);}});}}],server:{host:'127.0.0.1',port:0},resolve:{dedupe:['react','react-dom']},logLevel:'error'});
 let browser;
 try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:chrome});const page=await browser.newPage({viewport:{width:1000,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__queue_test`);await page.getByRole('button',{name:'Jobs',exact:true}).waitFor();await page.evaluate(()=>window.openQueue());
  await page.getByText('Buy VTI · needs your OK',{exact:true}).waitFor();await page.getByText('Sync portfolio and orders',{exact:true}).waitFor();assert.equal(await page.getByText('No active jobs.',{exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'Review',exact:true}).getAttribute('href'),'/strategies/synthetic');
  const shots=await mkdtemp(join(tmpdir(),'trading-queue-'));await page.screenshot({path:join(shots,'queue.png')});
  await page.evaluate(()=>{window.failAction=true;});await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic order changed'}).waitFor();assert.equal(await page.getByRole('button',{name:'Approve',exact:true}).count(),1);
  await page.evaluate(()=>{window.failAction=false;});await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByText('Buy VTI · needs your OK',{exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'Cancel: Withdraw $50 · Synthetic',exact:true}).click();await page.getByRole('button',{name:'Cancel: Withdraw $50 · Synthetic',exact:true}).waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.calls),[['approval','confirm'],['approval','confirm'],['withdrawal','cancel']]);
  await page.evaluate(()=>{window.failTrading=true;window.refresh();});await page.getByRole('alert').filter({hasText:'Trading queue is unavailable'}).waitFor();assert.equal(await page.getByText('Sync portfolio and orders',{exact:true}).count(),1);assert.equal(await page.getByText('No active jobs.',{exact:true}).count(),0);
  await page.evaluate(()=>{window.failTrading=false;window.failSync=true;window.refresh();});await page.getByRole('alert').filter({hasText:'Sync jobs are unavailable'}).waitFor();await page.getByRole('alert').filter({hasText:'Trading queue is unavailable'}).waitFor({state:'detached'});assert.equal(await page.getByText('Orders · Synthetic',{exact:true}).count(),1);
  await page.evaluate(()=>{
    document.documentElement.classList.add('dark');
    window.failSync=false;window.items=[];
    window.syncJobs=['portfolio_sync','account_sync'].map(kind=>({id:kind,kind,state:'failed',attempts:5,reason:'test',errorCode:'transient',updatedAt:new Date().toISOString(),nextRunAt:new Date().toISOString()}));
    window.refresh();
  });
  await page.getByRole('button',{name:'Retry Sync Robinhood accounts',exact:true}).waitFor();
  await page.getByRole('alert').waitFor({state:'detached'});
  await page.screenshot({path:join(shots,'compact-jobs.png')});
  await page.getByRole('button',{name:'Retry Sync portfolio and orders',exact:true}).click();
  assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),['portfolio_sync','retry']);
  await page.getByRole('tab',{name:'History',exact:true}).click();
  const completed=page.getByRole('link',{name:'Rebalance · Buy VTI',exact:true});
  await completed.waitFor();assert.equal(await completed.getAttribute('href'),'/strategies/synthetic');
  await page.getByText(/Synthetic take · Filled/).waitFor();
  assert.equal(await page.getByRole('tabpanel').filter({has:completed}).getByRole('button',{name:/Retry/}).count(),0);
  await page.screenshot({path:join(shots,'history.png')});
  assert.deepEqual(errors,[]);console.log(`Trading queue screenshot: ${shots}/compact-jobs.png`);
 }finally{await browser?.close();await server.close();}
});
