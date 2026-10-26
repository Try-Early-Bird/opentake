import {z} from 'zod';
import type {TradingResponse,TradingVenue} from '../../shared/trading';
export interface BrokerTradingAdapter {
 review(input:unknown):Promise<TradingResponse>;
 current(id:string):Promise<TradingResponse>;
 submit(id:string):Promise<TradingResponse>;
 refresh(id:string):Promise<TradingResponse>;
 reserve?(id:string):Promise<TradingResponse>;
 cancel?(id:string):Promise<TradingResponse>;
}
const command=z.object({venue:z.enum(['robinhood','coinbase']),action:z.enum(['review','current','reserve','submit','refresh','cancel']),input:z.unknown()}).strict();
/** Account identity comes from stored reviews, never a current portfolio selector at submission. */
export function createTradingService(adapters:Record<TradingVenue,BrokerTradingAdapter>){
 return {async execute(raw:unknown):Promise<TradingResponse>{
  const {venue,action,input}=command.parse(raw),adapter=adapters[venue];
  const operation=adapter[action];if(!operation)throw new Error(`This broker does not support ${action}.`);
  const result=action==='review'?await adapter.review(input):await (operation as (id:string)=>Promise<TradingResponse>)(z.uuid().parse(input));
  if(result.venue!==venue)throw new Error('Trading adapter returned another venue.');
  return result;
 }};
}
