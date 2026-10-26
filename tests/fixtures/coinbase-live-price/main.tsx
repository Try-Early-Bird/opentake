import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useCoinbaseLivePrice} from '../../../src/renderer/src/data-sources/useCoinbaseLivePrice';
const events:string[]=[];let product='ETH-USD';
window.__liveFixture={events,stale:false,retrying:false};
window.dataSources={coinbaseStream:{
 acquire:async next=>{product=next;events.push('acquire:'+next);return {leaseId:next,renewAfterMs:10000};},
 renew:async ids=>ids.map(leaseId=>({leaseId,renewAfterMs:10000})),
 release:async ids=>{events.push('release:'+ids[0]);},
 read:async ids=>ids.map(leaseId=>({leaseId,snapshot:{product,connection:window.__liveFixture.retrying?'retrying':'live',continuity:'live',trades:[{product_id:product,origin:'live',price:product==='ETH-USD'?'2345.67':'98765.43',time:new Date(Date.now()-(window.__liveFixture.stale?20000:0)).toISOString()}]}})),
}};
function Price({product}:{product:string}){const live=useCoinbaseLivePrice(product);return <output>{live??'Fetched price'}</output>;}
function App(){const [product,setProduct]=useState('ETH-USD'),[open,setOpen]=useState(true);return <><button onClick={()=>setProduct('BTC-USD')}>Switch product</button><button onClick={()=>setOpen(false)}>Leave</button>{open&&<Price product={product}/>}</>;}
createRoot(document.getElementById('root')!).render(<App/>);
