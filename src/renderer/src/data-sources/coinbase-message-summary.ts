import type {WebsocketMessage} from '../../../shared/websocket-sources';
const number=(value:unknown)=>{const [whole,...fraction]=String(value??'—').split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction.length?'.'+fraction.join('.'):'');};
export function coinbaseMessageSummary(row:WebsocketMessage):{kind:string;text:string}{
 if(row.type!=='json')return {kind:row.type,text:row.text};
 try{
  const frame=JSON.parse(row.text) as {channel?:string;events?:Array<{trades?:Array<{product_id:string;side:string;size:string;price:string;time:string}>;product_id?:string;type?:string;updates?:unknown[]}>};
  if(frame.channel==='heartbeats')return {kind:'heartbeat',text:'ok'};
  if(frame.channel==='market_trades'){
   const trades=(Array.isArray(frame.events)?frame.events:[]).flatMap(event=>Array.isArray(event.trades)?event.trades:[]);
   if(!trades.length)return {kind:'trade',text:'No trades in frame'};
   const last=trades.reduce((a,b)=>Date.parse(b.time)>Date.parse(a.time)?b:a);
   const products=[...new Set(trades.map(t=>t.product_id))];
   if(trades.length===1)return {kind:'trade',text:`${last.product_id} ${String(last.side).toLowerCase()} ${last.size} @ ${number(last.price)}`};
   return {kind:'trade',text:`${products.join(', ')} · ${trades.length} trades batched · last ${products.length>1?last.product_id+' ':''}${number(last.price)}`};
  }
  if(frame.channel==='subscriptions')return {kind:'subscribed',text:'Subscription confirmation received'};
  if(frame.channel==='l2_data')return {kind:'book',text:(frame.events??[]).map(event=>`${event.product_id} · ${event.type} · ${event.updates?.length??0} updates`).join(' · ')};
  return {kind:'json',text:row.text};
 }catch{return {kind:'json',text:row.text};}
}
export const messageTime=(time:number)=>new Date(time).toLocaleTimeString([], {hour12:false})+'.'+String(time%1000).padStart(3,'0');
export const messageBytes=(bytes:number)=>bytes>=1024?(bytes/1024).toFixed(1)+' KB':bytes+' B';
