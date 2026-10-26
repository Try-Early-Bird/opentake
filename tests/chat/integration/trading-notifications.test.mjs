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
const strategyId='00000000-0000-4000-8000-000000000001';
const context={strategyId};
const items=[{id:'approval',sequence:'2',kind:'orders_need_confirmation',tier:'act_now',requiresAction:true,eventKey:'event',context,source:{type:'trading_queue',id:'orders'},occurredAt:'2026-10-05T15:00:00Z',title:'Invest · Synthetic',body:'Confirm to buy VTI',seen:false,resolvedAt:null,trading:{queueItemId:'orders',actions:['confirm'],summary:'Buy VTI',strategyName:'Synthetic'}},{id:'waiting',sequence:'1',kind:'trading_waiting',tier:'know_today',requiresAction:false,eventKey:'waiting',context,source:{type:'trading_queue',id:'withdraw'},occurredAt:'2026-10-05T15:00:00Z',title:'Withdraw $50',body:'Waiting to settle',seen:false,resolvedAt:null,trading:{queueItemId:'withdraw',actions:['cancel'],summary:'Waiting to settle',strategyName:'Synthetic'}}];
test('trading bell shows hosted CTAs, preserves failed actions and refreshes after decisions',{skip:!existsSync(chrome),timeout:60000},async()=>{
 const entry='/__bell_test.jsx';
 const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {RouterProvider,createRouter,createRootRoute,createRoute,createMemoryHistory} from '@tanstack/react-router';import {NotificationCenter} from '/src/renderer/src/components/NotificationCenter.tsx';import {ToastProvider} from '/src/renderer/src/components/ui/action-toast.tsx';import '/src/renderer/src/index.css';
 window.items=${JSON.stringify(items)};window.calls=[];window.failAction=true;window.seen=[];
 window.notifications={navigation:async()=>null,acknowledge:async()=>{},markSeen:async sequence=>window.seen.push(sequence),list:async()=>({items:window.items,nextCursor:null,throughSequence:'2',unreadCount:2,actionRequiredCount:window.items.filter(i=>i.requiresAction&&!i.resolvedAt).length}),act:async(id,action)=>{window.calls.push([id,action]);if(window.failAction)throw Error('Synthetic item changed. Review again.');window.items=window.items.map(i=>i.id===id?{...i,resolvedAt:new Date().toISOString()}:i);}};
 const root=createRootRoute({component:()=>React.createElement('div',{style:{position:'fixed',right:20,top:20}},React.createElement(NotificationCenter))});const detail=createRoute({getParentRoute:()=>root,path:'/strategies/$strategyId',component:()=>null});const settings=createRoute({getParentRoute:()=>root,path:'/settings',component:()=>null});const router=createRouter({routeTree:root.addChildren([detail,settings]),history:createMemoryHistory({initialEntries:['/']})});createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement(RouterProvider,{router})));`;
 const server=await createServer({root,configFile:false,plugins:[react(),tailwind(),{name:'bell-fixture',resolveId(id){if(id===entry)return entry;},load(id){if(id===entry)return code;},configureServer(vite){vite.middlewares.use('/__bell_test',async(req,res,next)=>{if(req.url!=='/'&&req.url!==''){next();return;}try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__bell_test',`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));}catch(e){next(e);}});}}],server:{host:'127.0.0.1',port:0},resolve:{dedupe:['react','react-dom']},logLevel:'error'});
 let browser;
 try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:chrome});const page=await browser.newPage({viewport:{width:1000,height:700}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__bell_test`);
  await page.getByRole('button',{name:'Notifications, 2 new',exact:true}).click();
  await page.getByRole('button',{name:'Confirm orders for Synthetic',exact:true}).waitFor();assert.equal(await page.getByRole('link').first().getAttribute('href'),`/strategies/${strategyId}`);
  const shots=await mkdtemp(join(tmpdir(),'trading-bell-'));await page.screenshot({path:join(shots,'bell.png')});
  await page.getByRole('button',{name:'Confirm orders for Synthetic',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic item changed'}).waitFor();assert.equal(await page.getByRole('button',{name:'Confirm orders for Synthetic',exact:true}).count(),1);
  await page.evaluate(()=>{window.failAction=false;});await page.getByRole('button',{name:'Confirm orders for Synthetic',exact:true}).click();await page.getByRole('button',{name:'Confirm orders for Synthetic',exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'Cancel: Withdraw $50',exact:true}).click();await page.getByRole('button',{name:'Cancel: Withdraw $50',exact:true}).waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.calls),[['approval','confirm'],['approval','confirm'],['waiting','cancel']]);assert.ok((await page.evaluate(()=>window.seen)).includes('2'));assert.deepEqual(errors,[]);
  console.log(`Trading bell screenshot: ${shots}/bell.png`);
 }finally{await browser?.close();await server.close();}
});
