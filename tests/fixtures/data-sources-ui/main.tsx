import {defaultCoinbaseAccountConfig} from '../../../src/shared/coinbase-field-mappings';
import {defaultCoinbaseSourceConfig,coinbaseSourceId} from '../../../src/shared/coinbase-source';
import { managedPollDefaults } from '../../../src/shared/managed-polls';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryHistory, createRouter, createRootRoute, createRoute, RouterProvider, Outlet } from '@tanstack/react-router';
import { DataSources } from '../../../src/renderer/src/screens/DataSources';
import '../../../src/renderer/src/theme.css';
const saved = []; const wsSaved = []; let requests = [];
window.__fixture = { saved, wsSaved, requests };
window.settings = { listCredentials: async () => ({ok:true,items:[]}) };
window.portfolio = { search: async () => [{symbol:'AAPL',displayName:'Apple Inc.'}] };
let accountPolicies=JSON.parse(sessionStorage.getItem('fixture-account-policies')??'{}');
let accountFeeds=JSON.parse(sessionStorage.getItem('fixture-account-feeds')??'{}');
let coinbaseSource=JSON.parse(sessionStorage.getItem('fixture-coinbase-source')??'null')??{id:coinbaseSourceId,revision:1,enabled:true,validated:true,config:defaultCoinbaseSourceConfig};
const streamEvents = [];
window.__fixture.streamEvents = streamEvents;
window.dataSources = {
 coinbaseStream: {
  inspectMappings:async()=>({fields:[{path:['product_id'],type:'string',sample:'BTC-USD',selectable:true},{path:['price'],type:'string',sample:'100',selectable:true},{path:['alternative','price'],type:'string',sample:'101',selectable:true},{path:['time'],type:'string',sample:new Date().toISOString(),selectable:true}],truncated:false,inferredFrom:'single-response'}),
  previewMappings:async()=>({product:'BTC-USD',price:'100',time:new Date().toISOString()}),
  source:async()=>structuredClone(coinbaseSource),
  saveSource:async(revision,config)=>{if(revision!==coinbaseSource.revision)throw Error('changed');coinbaseSource={...coinbaseSource,revision:revision+1,config,enabled:config.collection!=='off'};sessionStorage.setItem('fixture-coinbase-source',JSON.stringify(coinbaseSource));return structuredClone(coinbaseSource);},
  reconnect: async()=>{window.__fixture.streamIssue=null;},
  inspect: async (after=0)=>({connection:window.__fixture.streamIssue?'retrying':'live',issue:window.__fixture.streamIssue??null,subscriptions:[
   {product:'BTC-USD',channels:['market_trades'],uses:['holdings'],accounts:['Opentake','Default'],lastTick:new Date(Date.now()-1000).toISOString(),confirmed:true},
   {product:'ZEC-USD',channels:['market_trades'],uses:['holdings'],accounts:['Opentake'],lastTick:new Date(Date.now()-3000).toISOString(),confirmed:true},
   {product:'ATOM-USD',channels:['market_trades'],uses:['holdings'],accounts:['Default'],lastTick:new Date(Date.now()-12000).toISOString(),confirmed:true},
   {product:'LINK-USD',channels:['market_trades'],uses:['holdings'],accounts:['Default'],lastTick:new Date(Date.now()-8000).toISOString(),confirmed:true},
   {product:'OMG-USD',channels:['market_trades'],uses:['view'],lastTick:null,confirmed:false},
  ],messages:{cursor:7,total:6,startedAt:Date.now()-3000,messages:[
   {id:1,type:'open',text:'Connected · subscribing to public market data',receivedAt:Date.now()-6000,bytes:46},
   ...Array.from({length:6},(_,index)=>({id:index+2,type:'json',receivedAt:Date.now()-(5-index)*1000,bytes:index%2?202:269,text:JSON.stringify(index%2?{channel:'heartbeats',events:[{heartbeat_counter:String(index)}]}:{channel:'market_trades',events:[{type:'update',trades:[{product_id:index===2?'ZEC-USD':'BTC-USD',side:index===2?'SELL':'BUY',size:index===2?'1.20':'0.0021',price:index===2?'1286.65':'83489.56',time:new Date().toISOString()}]}]})})),
  ].filter(row=>row.id>after)}}),
  acquire: async product => {streamEvents.push('acquire:'+product);return {leaseId:'public-lease',renewAfterMs:10000,expiresInMs:30000};},
  renew: async ids => ids.map(leaseId=>({leaseId,renewAfterMs:10000,expiresInMs:30000})),
  read: async ids => ids.map(leaseId=>({leaseId,snapshot:{connection:'live'}})),
  messages: async (id,after=0)=>({cursor:2,total:1,startedAt:Date.now()-2000,messages:[{id:1,type:'open',text:'Connected · public data',receivedAt:Date.now(),bytes:24},{id:2,type:'json',text:'{"channel":"market_trades","price":"123.45"}',receivedAt:Date.now(),bytes:42}].filter(row=>row.id>after)}),
  release: async ()=>{streamEvents.push('release');},
 },

 configure: async request=>{
  if(!['websocket-list','websocket-messages'].includes(request.action))requests.push(request.action);
  if(request.action==='coinbase-account-source')return structuredClone(accountFeeds[request.accountId]??{accountId:request.accountId,revision:1,config:defaultCoinbaseAccountConfig});
  if(request.action==='coinbase-account-save'){const saved={...request.setting,revision:request.setting.revision+1};accountFeeds[saved.accountId]=saved;sessionStorage.setItem('fixture-account-feeds',JSON.stringify(accountFeeds));return structuredClone(saved);}
  if(request.action==='websocket-list')return structuredClone(wsSaved);
  if(request.action==='websocket-inspect')return request.connection.dataMode==='json'?{fields:[{path:['price'],type:'number',sample:123.45,selectable:true},{path:['symbol'],type:'string',sample:'BTC-USD',selectable:true}],truncated:false,inferredFrom:'single-response'}:{text:'plain text message'};
  if(request.action==='save'){const source={id:'33333333-3333-4333-8333-333333333333',revision:(request.existing?.revision??0)+1,enabled:false,validated:false,config:request.config};wsSaved.splice(0,wsSaved.length,source);return structuredClone(source);}
  if(request.action==='websocket-policy'){const source=wsSaved[0];source.revision++;if(request.collection)source.config.collection=request.collection;for(const feed of source.config.feeds){if(request.storage)feed.storage.mode=request.storage;if(request.sampleEveryMs)feed.storage.sampleEveryMs=request.sampleEveryMs;if(request.retentionDays)feed.storage.retentionDays=request.retentionDays;}return structuredClone(source);}
  if(request.action==='websocket-messages')return {cursor:3,total:2,startedAt:Date.now()-5000,messages:[{id:1,type:'open',text:'Connected · subscription confirmed',receivedAt:Date.now()-3000,bytes:35},{id:2,type:'text',text:'Market open — streaming BTC-USD prices',receivedAt:Date.now()-2000,bytes:40},{id:3,type:'json',text:'{"price":"123.45"}',receivedAt:Date.now()-1000,bytes:18}].filter(row=>row.id>(request.after??0))};
  throw Error('Unknown fixture request');
 },
 managedSettings: async accountId=>{accountPolicies[accountId]??=managedPollDefaults.filter(job=>job.venue===(accountId==='fixture-account'?'robinhood':'coinbase')).map(job=>({id:job.id,accountId,collection:'automatic',intervalMs:job.intervalMs,revision:1}));return structuredClone(accountPolicies[accountId]);},
 saveManagedSetting: async setting=>{const next={...setting,revision:setting.revision+1};accountPolicies[setting.accountId]=accountPolicies[setting.accountId].map(item=>item.id===next.id?next:item);sessionStorage.setItem('fixture-account-policies',JSON.stringify(accountPolicies));return next;},
 inventory: async () => ({sources:[{id:'fixture-account',venue:'robinhood',label:'Fixture account',connected:true,feeds:[{id:'portfolio',name:'Account balance and holdings',description:'Fixture',state:'completed',lastUpdatedAt:new Date().toISOString()}]},...['A','B'].map(label=>({id:'fixture-coinbase-'+label,venue:'coinbase',label:'Account '+label,connected:true,feeds:[]}))]}), customSources: async () => structuredClone(saved),
 inspect: async input => { requests.push('inspect'); return {fields:[{path:['score'],type:'number',sample:62,selectable:true},{path:['category'],type:'string',sample:'Positive',selectable:true},{path:['time'],type:'number',sample:Date.now(),selectable:true}],truncated:false,inferredFrom:'single-response'}; },
 saveSource: async (config, existing) => { requests.push('save'); const source={id:'11111111-1111-4111-8111-111111111111',revision:(existing?.revision??0)+1,config,enabled:false,validated:false};saved.splice(0,saved.length,source);return structuredClone(source); },
 previewSource: async (id) => { requests.push('preview');if(wsSaved.some(item=>item.id===id)){wsSaved[0].validated=true;return {samples:[],destinations:[]};}saved[0].validated=true;return {samples:[],destinations:saved[0].config.feeds[0].destination?.kind === 'market-price' ? [{feedId:'selected',target:'market_quotes:AAPL',outcome:'would-write',current:{price:'200.00',provider:'robinhood',observedAt:new Date(Date.now()-120000).toISOString()},proposed:{price:'201.25',provider:'custom-http',eventTime:new Date().toISOString()}}] : saved[0].config.feeds[0].destination?.kind === 'market-metadata' ? [{feedId:'selected',target:'metadata',outcome:'would-write',current:{},proposed:{score:62}}] : []}; },
 enableSource: async (id,revision,enabled) => { requests.push(enabled?'enable':'pause'); (wsSaved.find(item=>item.id===id)??saved[0]).enabled=enabled; },
 acquire: async () => {requests.push('acquire');return {leaseId:'22222222-2222-4222-8222-222222222222',expiresInMs:30000,renewAfterMs:10000};},
 renew: async ids => ids.map(leaseId=>({leaseId,expiresInMs:30000,renewAfterMs:10000})),
 read: async ids => ids.map(leaseId=>({leaseId,snapshot:{connection:'live',quality:'fresh',issue:null,lastReceivedAt:Date.now(),latest:{receivedAt:Date.now(),payload:{kind:'metric',value:'62'}}}})),
 release: async () => {requests.push('release');}
};
const rootRoute=createRootRoute({component:()=> <div className="bg-background p-8 text-foreground"><Outlet /></div>});
const indexRoute=createRoute({getParentRoute:()=>rootRoute,path:'/',component:DataSources});
const settingsRoute=createRoute({getParentRoute:()=>rootRoute,path:'/settings',component:()=> <div>Fixture settings</div>});
const router=createRouter({history:createMemoryHistory({initialEntries:['/']}),routeTree:rootRoute.addChildren([indexRoute,settingsRoute])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
