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
const allocationId='00000000-0000-4000-8000-000000000002';
const base={tier:'act_now',requiresAction:true,context,occurredAt:'2026-10-05T15:00:00Z',seen:false,resolvedAt:null};
const ev=(id,kind,extra,takeEvent)=>({...base,...extra,id,sequence:id,kind,eventKey:id,source:{type:'take_event',id},title:kind,body:'',takeEvent:{event:kind,allocationId,strategyName:'Synthetic take',symbol:null,detail:null,...takeEvent}});
const items=[ev('6','strategy_archived',{},{detail:'awaiting'}),ev('5','outside_sale',{},{symbol:'VTI'}),ev('4','take_overspent',{}),ev('3','order_unknown',{},{symbol:'QQQ',detail:'sell'}),
 ev('2','holding_not_bought',{tier:'know_today',requiresAction:false},{symbol:'SPY'}),ev('1','symbol_delisted',{tier:'know_today',requiresAction:false},{symbol:'ABCD'}),
 ev('8','missing_evidence',{},{symbol:'VTI'}),
 {...base,id:'7',sequence:'7',kind:'account_data_stale',eventKey:'7',context:{venue:'robinhood',connectionId:'00000000-0000-4000-8000-000000000009'},source:{type:'take_event',id:'7'},title:'Can’t read your Robinhood account',body:'Opentake has not been able to read your account since Oct 5, 2:00 PM, so your takes wait to trade. Check the connection in Settings.'}];
test('take events show in the bell with their copy, link to the take, and Hold all closes the archived investment',{skip:!existsSync(chrome),timeout:60000},async()=>{
 const entry='/__take_bell_test.jsx';
 const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {RouterProvider,createRouter,createRootRoute,createRoute,createMemoryHistory} from '@tanstack/react-router';import {NotificationCenter} from '/src/renderer/src/components/NotificationCenter.tsx';import {ToastProvider} from '/src/renderer/src/components/ui/action-toast.tsx';import '/src/renderer/src/index.css';
 window.items=${JSON.stringify(items)};window.calls=[];window.seen=[];
 window.notifications={navigation:async()=>null,acknowledge:async()=>{},markSeen:async sequence=>window.seen.push(sequence),list:async()=>({items:window.items,nextCursor:null,throughSequence:'6',unreadCount:6,actionRequiredCount:window.items.filter(i=>i.requiresAction&&!i.resolvedAt).length}),act:async()=>{}};
 window.allocations={holdings:async()=>({status:200,holdings:[],selfDirected:[]}),close:async(id,sell)=>{window.calls.push([id,sell]);window.items=window.items.map(i=>i.kind==='strategy_archived'?{...i,resolvedAt:new Date().toISOString()}:i);return {ok:true,status:200,body:null};}};
 const root=createRootRoute({component:()=>React.createElement('div',{style:{position:'fixed',right:20,top:20}},React.createElement(NotificationCenter))});const detail=createRoute({getParentRoute:()=>root,path:'/strategies/$strategyId',component:()=>null});const router=createRouter({routeTree:root.addChildren([detail]),history:createMemoryHistory({initialEntries:['/']})});createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement(RouterProvider,{router})));`;
 const server=await createServer({root,configFile:false,plugins:[react(),tailwind(),{name:'take-bell-fixture',resolveId(id){if(id===entry)return entry;},load(id){if(id===entry)return code;},configureServer(vite){vite.middlewares.use('/__take_bell_test',async(req,res,next)=>{if(req.url!=='/'&&req.url!==''){next();return;}try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__take_bell_test',`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));}catch(e){next(e);}});}}],server:{host:'127.0.0.1',port:0},resolve:{dedupe:['react','react-dom']},logLevel:'error'});
 let browser;
 try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:chrome});const page=await browser.newPage({viewport:{width:1000,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__take_bell_test`);
  await page.getByRole('button',{name:'Notifications, 6 new',exact:true}).click();
  for(const text of ['You archived Synthetic take · hold or sell its positions','A sale of VTI in Robinhood included shares your Synthetic take investment held.','Synthetic take spent more cash than it held.',
   'Robinhood did not confirm or refuse an order for QQQ in Synthetic take.','SPY could not be bought for your Synthetic take investment','ABCD no longer trades.','A VTI fill could not be matched to Synthetic take'])
   await page.getByRole('link').filter({hasText:text}).first().waitFor();
  await page.getByRole('button').filter({hasText:'Can’t read your Robinhood account'}).waitFor();
  assert.equal(await page.getByRole('link').first().getAttribute('href'),`/strategies/${strategyId}`);
  const shots=await mkdtemp(join(tmpdir(),'take-bell-'));await page.waitForTimeout(400);await page.screenshot({path:join(shots,'bell.png')});
  await page.getByRole('button',{name:'Hold all',exact:true}).click();await page.getByRole('button',{name:'Hold all',exact:true}).waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.calls),[[allocationId,'none']]);assert.deepEqual(errors,[]);
  console.log(`Take bell screenshot: ${shots}/bell.png`);
 }finally{await browser?.close();await server.close();}
});
