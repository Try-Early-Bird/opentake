import {expect,test} from 'vitest';
import {summarizeInvestment} from '../../../src/main/execution/investment-summary';
import {callOpentakeTool} from '../../../src/main/opentake-mcp/server';
import {toolCatalog} from '../../../src/main/opentake-mcp/catalog';

const holding=(strategyId:string,status='active')=>({bucket:{id:`b-${strategyId}`,status},strategy:{id:strategyId,displayName:'MAG7'},
 valuation:{currency:'USD',cash:'0.03',totalValue:'102.50'},positions:[{symbol:'NVDA',quantity:'0.01',value:'1.80'}],
 pnl:{capitalAllocated:'100',unrealized:'2.50',realized:'0',allTimeReturn:'2.5'},openExecutions:1,waiting:{reason:'market_closed',until:null},requiresReconciliation:false});

test('the AI reads only this strategy’s money, with its returns, and nothing it could act on',async()=>{
 const asked:string[]=[];
 const summary=await summarizeInvestment({
  holdings:async()=>({holdings:[holding('s1'),holding('s2')]}),
  instructions:async id=>{asked.push(id);return {instructions:[{kind:'contribution',requestedAmount:'5'}]};},
  performance:async(_id,range,basis)=>({strategyId:'s1',range,basis,actualAvailable:basis==='actual',investors:1,actualSince:null,intraday:null,
   rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null},lastRebalancedAt:null,dividends:'excluded',points:[],
   stats:[{source:basis==='model'?'backtested':'live',asOf:'2026-10-02T00:00:00.000Z',startedAt:'2025-10-02T00:00:00.000Z',allTimeReturnPercent:basis==='model'?'14.20':'2.50',oneDayReturnPercent:null}]}),
 },'s1');
 expect(asked).toEqual(['b-s1']);
 expect(summary).toMatchObject({strategyId:'s1',invested:true,investments:[{status:'active',value:'102.50',openOrders:1,waiting:{reason:'market_closed'},pendingInstructions:[{kind:'contribution'}]}],
  performance:{simulatedPastYear:{allTimeReturnPercent:'14.20'},actualSinceInvested:{allTimeReturnPercent:'2.50'}}});
 expect(summary.note).toContain('Read-only');
});

test('the tool is listed read-only and routes to the investment service',async()=>{
 const tool=toolCatalog().find(t=>t.name==='opentake_read_strategy_investment');
 expect(tool?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
 const seen:unknown[]=[];
 const result=await callOpentakeTool({investment:async input=>{seen.push(input);return {invested:false};},status:async()=>{throw new Error('unused');},read:async()=>{throw new Error('unused');}},'opentake_read_strategy_investment',{});
 expect(seen).toEqual([{}]);
 expect(result.content).toEqual([{type:'text',text:JSON.stringify({invested:false})}]);
 const missing=await callOpentakeTool({status:async()=>{throw new Error('unused');},read:async()=>{throw new Error('unused');}},'opentake_read_strategy_investment',{});
 expect(missing.isError).toBe(true);
});

test('a Coinbase allocation is read as an investment with its holdings, cash and current weights',async()=>{
 const none={holdings:async()=>({holdings:[]}),instructions:async()=>({instructions:[]}),performance:async()=>null};
 const summary=await summarizeInvestment({...none,coinbase:async()=>({accountId:'a',accountLabel:'Opentake',takeTitle:'BTC',valuation:{currency:'USD',value:'4.93'},pnl:null,
  balances:[{asset:'BTC',quantity:'0.0000178',reserved:'0',price:'81225.98',value:'1.45'},{asset:'USDC',quantity:'3.48',reserved:'0'},{asset:'USD',quantity:'0',reserved:'0'}]})},'s1');
 expect(summary).toMatchObject({invested:true,investments:[{venue:'coinbase',account:'Opentake',value:'4.93',positions:[{symbol:'BTC',quantity:'0.0000178',value:'1.45'}],
  cash:[{asset:'USDC',quantity:'3.48'}],weights:{BTC:'29.41%',USDC:'70.59%'}}]});
 expect(summary.note).toContain('switching places no orders');
 // No allocation, an empty one, or an unreadable one: not invested there.
 for(const coinbase of [async()=>null,async()=>{throw new Error('No Coinbase account');},async()=>({accountId:'a',accountLabel:'Opentake',takeTitle:'BTC',balances:[{asset:'USDC',quantity:'0',reserved:'0'}]})])
  expect((await summarizeInvestment({...none,coinbase},'s1')).invested).toBe(false);
});
