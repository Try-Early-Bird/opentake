import {test,expect} from 'vitest';
import {instrumentBroker,brokerResponseSummary} from '../../src/main/broker-diagnostics';
import type {createDiagnostics} from '../../src/main/diagnostics';
test('broker calls report concrete method, account, result counts and timing without raw data',async()=>{
 const entries:unknown[]=[];const logs={record:(event:unknown,fields:unknown)=>entries.push({event,...fields as object})} as ReturnType<typeof createDiagnostics>;
 const response={data:{orders:[{token:'secret'}],fills:[],cursor:'secret-cursor'}};
 const broker=instrumentBroker({readChat:async()=>response},'coinbase',logs);
 expect(await broker.readChat()).toBe(response);
 expect(entries).toMatchObject([{event:'broker.called',venue:'coinbase',operation:'read_chat'},{event:'broker.returned',ordersCount:1,fillsCount:0,hasMore:true,durationMs:expect.any(Number)}]);
 expect(JSON.stringify(entries)).not.toContain('secret');
});
test('broker failure preserves the error for callers and logs only its safe code',async()=>{
 const entries:unknown[]=[];const error=Object.assign(new Error('private payload'),{code:'permissions'});
 const logs={record:(event:unknown,fields:unknown)=>entries.push({event,...fields as object})} as ReturnType<typeof createDiagnostics>;
 const broker=instrumentBroker({readTool:async(_name:string)=>{throw error;}},'robinhood',logs);
 await expect(broker.readTool('get_equity_quotes')).rejects.toBe(error);
 expect(entries).toMatchObject([{operation:'get_equity_quotes'},{event:'broker.failed',errorCode:'permissions'}]);expect(JSON.stringify(entries)).not.toContain('private payload');
});
test('response summaries retain outcomes but omit balances, IDs and arbitrary strings',()=>{
 expect(brokerResponseSummary({state:'accepted',providerRef:'private',balance:'100'})).toEqual({responseState:'accepted'});
 expect(brokerResponseSummary([{errs:['private']}])).toEqual({resultCount:1,errorCount:1});
});

test('returned response contains safe order detail and strips credentials and free-form messages',async()=>{
 const {brokerResponseDetails}=await import('../../src/shared/broker-response');
 const result=brokerResponseDetails({data:{orders:[{product_id:'BTC-USDC',side:'BUY',status:'FILLED',filled_size:'0.001',average_filled_price:'83000',total_fees:'0.02',token:'secret',message:'secret',account_number:'secret'}],authorization:'secret'}});
 expect(result).toEqual({data:{orders:[{product_id:'BTC-USDC',side:'BUY',status:'FILLED',filled_size:'0.001',average_filled_price:'83000',total_fees:'0.02'}]}});
 expect(JSON.stringify(result)).not.toContain('secret');
 expect(brokerResponseDetails({content:[{type:'text',text:JSON.stringify({price:'12',token:'secret'})}]})).toEqual({price:'12'});
 expect(brokerResponseDetails({content:[{type:'text',text:'private text'}]})).toEqual({});
});
test('large broker responses are bounded and explicitly marked truncated',async()=>{
 const {brokerResponseDetails}=await import('../../src/shared/broker-response');
 const result=brokerResponseDetails({orders:Array.from({length:1000},()=>({status:'filled',quantity:'1'}))});
 expect(result).toMatchObject({truncated:true,data:{orders:expect.any(Array)}});
 expect(JSON.stringify(result).length).toBeLessThan(2000);
});

test('broker response keeps nested Robinhood quote prices and request symbols',async()=>{
 const {brokerResponseDetails}=await import('../../src/shared/broker-response');
 expect(brokerResponseDetails({symbols:['AAPL','SPY','token=secret']})).toEqual({symbols:['AAPL','SPY']});
 expect(brokerResponseDetails({data:{results:[{quote:{symbol:'AAPL',last_trade_price:'345.5',token:'secret'},close:{price:'344'}}]}})).toEqual({data:{results:[{quote:{symbol:'AAPL',last_trade_price:'345.5'},close:{price:'344'}}]}});
});
