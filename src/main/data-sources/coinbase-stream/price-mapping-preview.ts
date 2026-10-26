import {inspectSourceResponse} from '../inspection';
import {z} from 'zod';
import {coinbasePriceMappingSchema,readMappedField} from '../../../shared/coinbase-field-mappings';
import type {WebsocketMessages} from '../../../shared/websocket-sources';
const sample=z.object({product:z.string().regex(/^[A-Z0-9._-]+-USD$/),price:z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(80).refine(value=>Number(value)>0&&Number.isFinite(Number(value))),time:z.iso.datetime({offset:true})});
export function previewPriceMapping(messages:WebsocketMessages,raw:unknown,now=Date.now()){
 const mapping=coinbasePriceMappingSchema.parse(raw);
 for(const message of [...messages.messages].reverse()){
  if(now-message.receivedAt>15000||message.receivedAt>now+2000)continue;
  let frame;try{frame=JSON.parse(message.text);}catch{continue;}
  if(frame.channel!=='market_trades'||!Array.isArray(frame.events))continue;
  for(const event of frame.events){
   if(event.type!=='update'||!Array.isArray(event.trades))continue;
   for(const trade of event.trades){
    const parsed=sample.safeParse({product:readMappedField(trade,mapping.product),price:readMappedField(trade,mapping.price),time:readMappedField(trade,mapping.time)});
    if(!parsed.success)continue;
    if(now-Date.parse(parsed.data.time)>15000||Date.parse(parsed.data.time)>now+2000)continue;
    return parsed.data;
   }
  }
 }
 throw Error('No fresh trade matches these mappings. Enable a market and wait for a trade, then preview again.');
}

/** Return only bounded, sanitized fields from a recent trade; no extra socket. */
export function inspectPriceMapping(messages:WebsocketMessages,now=Date.now()){
 for(const message of [...messages.messages].reverse()){
  if(now-message.receivedAt>15000||message.receivedAt>now+2000)continue;
  let frame;try{frame=JSON.parse(message.text);}catch{continue;}
  if(frame?.channel!=='market_trades'||!Array.isArray(frame.events))continue;
  for(const event of frame.events){
   if(event?.type!=='update'||!Array.isArray(event.trades))continue;
   for(const trade of event.trades){
    if(!trade||typeof trade!=='object'||Array.isArray(trade))continue;
    return inspectSourceResponse(trade);
   }
  }
 }
 throw Error('No recent trade available. Enable a market and wait for a trade, then inspect again.');
}
