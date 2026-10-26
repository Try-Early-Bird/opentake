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
const takeId='00000000-0000-4000-8000-000000000003',strategyId='00000000-0000-4000-8000-000000000004',draftId='00000000-0000-4000-8000-000000000005',versionId='00000000-0000-4000-8000-000000000006';
const weight=(symbol,bps)=>({instrument:{venue:'robinhood',symbol},bps});
const draft={id:draftId,strategyId,revision:2,baseVersion:versionId,sourceTakeId:takeId,sourceMessageId:null,sourceRunId:null,producer:'human',producerIdentity:{},createdAt:'2026-10-05T15:00:00Z',acceptedVersion:null,copiedFrom:null,
 verification:{policy:'personal_basket',version:1,checkedAt:'2026-10-05T15:00:00Z',accountRef:null,results:[{instrument:{venue:'robinhood',symbol:'BND'},state:'pass',tradable:true,fractional:true,reason:null},{instrument:{venue:'robinhood',symbol:'VTI'},state:'pass',tradable:true,fractional:true,reason:null}]},
 metadata:{title:'Synthetic take',description:'A synthetic take.',rationale:'Diversification.',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:[weight('BND',9000),weight('VTI',1000)],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]};
const view={strategyId,targetTakeId:takeId,title:'Synthetic take',archivedAt:null,currentVersion:versionId,draft,clean:false,proposals:[draft],versions:[],historyTruncated:false};
const review={investments:1,turnoverPercent:90,highTurnover:true,belowMinimum:1,smallestValueUsd:'5.00',weightThatFitsPercent:20};
test('committing an invested take saves a new version and requires consequence acknowledgement',{skip:!existsSync(chrome),timeout:60000},async()=>{
 const entry='/__commit_review_test.jsx';
 const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {RouterProvider,createRouter,createRootRoute,createRoute,createMemoryHistory} from '@tanstack/react-router';import {BasketPanel} from '/src/renderer/src/strategies/BasketPanel.tsx';import '/src/renderer/src/index.css';
 window.commits=[];
 window.strategies={read:async()=>(${JSON.stringify(view)}),available:async()=>true,commitReview:async()=>(${JSON.stringify(review)}),commit:async input=>{window.commits.push(input);return {ok:false,conflict:false,code:'high_turnover',message:'Synthetic refusal.'};},messageProposals:async()=>[]};
 // The Take panel's Rules section reads its review here; this take has none.
 window.dataSources={configure:async()=>({config:{rules:[]},proposals:[],lifecycle:null})};
 window.portfolio={snapshot:async()=>({strategies:[{strategyId:'${strategyId}',status:'active',value:'5'}]})};
 const root=createRootRoute({component:()=>React.createElement('div',{style:{display:'flex',height:'100vh',justifyContent:'flex-end'}},React.createElement(BasketPanel,{takeId:'${takeId}'}))});const detail=createRoute({getParentRoute:()=>root,path:'/strategies/$strategyId',component:()=>null});const router=createRouter({routeTree:root.addChildren([detail]),history:createMemoryHistory({initialEntries:['/']})});createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));`;
 const server=await createServer({root,configFile:false,plugins:[react(),tailwind(),{name:'commit-review-fixture',resolveId(id){if(id===entry)return entry;},load(id){if(id===entry)return code;},configureServer(vite){vite.middlewares.use('/__commit_review_test',async(req,res,next)=>{if(req.url!=='/'&&req.url!==''){next();return;}try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__commit_review_test',`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));}catch(e){next(e);}});}}],server:{host:'127.0.0.1',port:0},resolve:{dedupe:['react','react-dom']},logLevel:'error'});
 let browser;
 try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:chrome});const page=await browser.newPage({viewport:{width:1000,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commit_review_test`);
  // The panel's Commit opens a confirmation dialog listing both consequences; one acknowledgement covers them.
  await page.getByRole('button',{name:'Commit',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Commit changes?',exact:true}).waitFor();
  await dialog.getByText('Committing saves a new version. Your investment keeps its accepted version until you review and switch on the Take page.',{exact:true}).waitFor();
  await dialog.getByText('1 investment is too small for this basket',{exact:true}).waitFor();
  await dialog.getByText('The new version changes most holdings',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Set smallest weight to 20%',exact:true}).waitFor();
  const commit=dialog.getByRole('button',{name:'Commit changes',exact:true});
  assert.equal(await commit.isDisabled(),true);
  const shots=await mkdtemp(join(tmpdir(),'commit-review-'));await page.screenshot({path:join(shots,'review.png')});
  assert.equal(await dialog.getByRole('checkbox').count(),1);
  await dialog.getByRole('checkbox',{name:'I understand both and want to commit anyway'}).check();assert.equal(await commit.isDisabled(),false);
  await commit.click();await page.getByRole('alert').filter({hasText:'Synthetic refusal.'}).waitFor();
  const sent=await page.evaluate(()=>window.commits);assert.equal(sent.length,1);assert.equal(sent[0].acceptHighTurnover,true);assert.equal(sent[0].acceptStranded,true);
  assert.deepEqual(errors,[]);
  console.log(`Commit review screenshot: ${shots}/review.png`);
 }finally{await browser?.close();await server.close();}
});
