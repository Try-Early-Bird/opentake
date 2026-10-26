import {brokerResponseDetails} from '../shared/broker-response';
import {randomUUID} from 'node:crypto';
import {brokerOperations,brokerStates,brokerErrors} from '../shared/broker-diagnostics';
import type {createDiagnostics} from './diagnostics';
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function brokerResponseSummary(value:unknown){
 const outer=object(value),data=outer.data??value,r=object(data),summary:Record<string,string|number|boolean>={};
 if(Array.isArray(data))summary.resultCount=data.length;
 for(const [field,label] of Object.entries({results:'resultCount',orders:'ordersCount',fills:'fillsCount',positions:'positionsCount',spot_positions:'positionsCount',candles:'candlesCount',wallets:'walletsCount',errs:'errorCount',warning:'warningCount'}))if(Array.isArray(r[field]))summary[label]=(r[field] as unknown[]).length;
 if(Array.isArray(data)){summary.errorCount=data.reduce((n,item)=>n+(Array.isArray(object(item).errs)?(object(item).errs as unknown[]).length:0),0);}
 if(Array.isArray(object(r.breakdown).spot_positions))summary.positionsCount=(object(r.breakdown).spot_positions as unknown[]).length;
 const state=r.state??r.status;
 if(brokerStates.includes(state as never))summary.responseState=state as string;
 if(typeof value==='boolean')summary.accepted=value;
 if(typeof r.has_next==='boolean')summary.hasMore=r.has_next;
 else if(typeof r.cursor==='string'||r.cursor===null)summary.hasMore=!!r.cursor;
 return summary;
}
/** Observe service calls without logging raw requests, credentials, or provider payloads. */
export function instrumentBroker<T extends object>(target:T,venue:'coinbase'|'robinhood',diagnostics:ReturnType<typeof createDiagnostics>):T{
 const names:Record<string,string>={readTool:'read_tool',readChat:'read_chat',readHistory:'read_history',readActivity:'read_activity',readTradingRules:'read_trading_rules',readPositionDetails:'read_position_details',readProductMetadata:'read_product_metadata',previewOrders:'preview_orders',submitOrder:'submit_order',cancelOrder:'cancel_order',equityOrder:'review_equity_order'};
 return new Proxy(target,{get(obj,key,receiver){
  const original=Reflect.get(obj,key,receiver);if(typeof key!=='string'||!names[key]||typeof original!=='function')return original;
  return async(...args:unknown[])=>{
   const requested=key==='readTool'?args[0]:key==='readChat'?args[1]:key==='readActivity'&&['spot_orders','spot_fills','order'].includes(String(object(args[1]).resource))?'read_'+object(args[1]).resource:key==='previewOrders'&&Array.isArray(args[1])&&!args[1].length?'check_trading_permission':key==='equityOrder'&&args[0]==='place'?'place_equity_order':names[key];
   const operation=brokerOperations.includes(requested as never)?requested as string:names[key];
   const callId=randomUUID(),started=Date.now();
   const scope=object(args[0]),account=key==='readTool'||key==='equityOrder'?args[2]:scope.accountRef;
   const input=object(key==='readTool'?args[1]:key==='readChat'?args[2]:args[1]);
   const symbols=[...(typeof args[1]==='string'&&['readTradingRules','readProductMetadata'].includes(key)?[args[1]]:[]),...(key==='previewOrders'&&Array.isArray(args[1])?args[1].map(o=>object(o).product):[]),input.product_id,input.product,input.symbol,...(Array.isArray(input.symbols)?input.symbols:[]),...(Array.isArray(input.product_ids)?input.product_ids:[])].filter((s):s is string=>typeof s==='string'&&/^[A-Z][A-Z0-9.-]{0,39}$/.test(s)).slice(0,20);
   const context={venue,operation,callId,...(typeof account==='string'&&/^[a-f0-9-]{36}$/i.test(account)?{accountId:account}:{}),symbols,...(key==='previewOrders'&&Array.isArray(args[1])?{requestCount:args[1].length}:{})};
   diagnostics.record('broker.called',{...context,request:brokerResponseDetails(key==='previewOrders'?args[1]:input)});
   try{const result=await Reflect.apply(original,obj,args);diagnostics.record('broker.returned',{...context,durationMs:Date.now()-started,...brokerResponseSummary(result),response:brokerResponseDetails(result)});return result;}
   catch(error){const code=object(error).code;diagnostics.record('broker.failed',{...context,durationMs:Date.now()-started,errorCode:brokerErrors.includes(code as never)?code:'unknown'});throw error;}
  };
 }});
}
