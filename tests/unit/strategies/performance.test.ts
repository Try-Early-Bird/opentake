import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {importStrategyPortfolio} from '../../../src/main/allocations/portfolio-import';
import {actualLine,createStrategyPerformance,dividendYields} from '../../../src/main/strategies/performance';
import type {MarketSeries,SymbolSeries} from '../../../src/shared/market-series';
const now=Date.parse('2026-10-03T14:00:00Z');
const vti=(interval:SymbolSeries['interval'],points:[string,string][],baseline:string|null=null):SymbolSeries=>({symbol:'VTI',interval,bounds:'regular',baseline:baseline===null?null:{price:baseline,kind:'previous_close'},price:null,extendedPrice:null,extendedSession:null,change:null,extendedChange:null,points:points.map(([t,c])=>({t,c,s:'regular'}))});

async function fixture(){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-hash','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:'20',mark_price:'10',average_buy_price:'8'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const sourceConnection=randomUUID(),sourceStrategy=randomUUID();
 const input={format:'opentake-strategy-portfolio-v1',exportedAt:new Date(now).toISOString(),source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-hash`).digest('hex')},
  strategies:[{id:sourceStrategy,title:'Imported strategy',description:'Synthetic',rebalance:null,versions:[{id:randomUUID(),sequence:1,weights:[{symbol:'VTI',weightPercent:80}],cashPercent:20}]}],
  allocations:[{id:randomUUID(),strategyId:sourceStrategy,status:'active',appliedSequence:1,entries:[
   {id:randomUUID(),sequence:1,entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',unitCost:null,currency:'USD',sourceKind:'reconciliation',sourceRef:'fixture1',occurredAt:'2026-10-01T14:00:00Z'},
   {id:randomUUID(),sequence:2,entryType:'fill',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',currency:'USD',sourceKind:'strategy_execution',sourceRef:'fixture2',occurredAt:'2026-10-02T15:00:00Z'},
  ],history:[]}]};
 await importStrategyPortfolio(database,input,undefined,now,{externalRef:'synthetic-hash',connectionId:sourceConnection,accountRefHash:input.source.accountRefHash});
 const strategyId=(await sync.snapshot()).strategies![0].strategyId;
 const requests:{range:string;symbols:string[]}[]=[];
 const series=async(request:{accountId:string;range:string;symbols:string[]}):Promise<MarketSeries>=>{
  requests.push({range:request.range,symbols:request.symbols});
  const data=request.range==='1d'
   ?[vti('5minute',[['2026-10-02T19:55:00Z','12.5']],'12')]
   :[vti('day',[['2026-09-30T00:00:00Z','9'],['2026-10-01T00:00:00Z','10'],['2026-10-02T00:00:00Z','12']])];
  return {venue:'robinhood_agentic',range:request.range as MarketSeries['range'],asOf:new Date(now).toISOString(),staleSymbols:[],pendingSymbols:[],refreshingSymbols:[],series:data};
 };
 const {performance,markers}=createStrategyPerformance(database,series,async()=>new Map(),async()=>accountId,()=>now);
 return {db,sync,strategyId,performance,markers,requests};
}

test('model basis backtests committed weights from daily closes; days before the commit are backtested',async()=>{
 const f=await fixture();try{
  const result=await f.performance(f.strategyId,'1m','model');
  // 80% VTI at 10 (8 units) + 20 cash: 100, then 8 × 12 + 20 = 116 after the 9 → 10 → 12 closes.
  expect(result?.points).toEqual([{day:'2026-09-30',unitValue:'100',source:'backtested',prices:{VTI:9}},{day:'2026-10-01',unitValue:expect.stringMatching(/^108\.88/),source:'backtested',prices:{VTI:10}},{day:'2026-10-02',unitValue:expect.stringMatching(/^126\.66/),source:'backtested',prices:{VTI:12}}]);
  expect(result).toMatchObject({basis:'model',actualAvailable:true,actualSince:'2026-10-02T15:00:00.000Z',dividends:'excluded',rebalance:{schedule:'never'}});
  expect(f.requests).toEqual([{range:'1m',symbols:['VTI']}]);
 }finally{f.sync.cancel();await f.db.close();}
});

test('actual basis chains the allocation ledger with deposits taken out, and prices 1D intraday',async()=>{
 const f=await fixture();try{
  const result=await f.performance(f.strategyId,'1m','actual');
  // Oct 1: 100 cash; Oct 2: 50 cash + 5 × 12 = 110 with no new capital, so +10%.
  // Each day also carries what the allocation was worth and the closes it was marked to.
  expect(result?.points).toEqual([{day:'2026-10-01',unitValue:'100',source:'live',value:100,prices:{VTI:10}},{day:'2026-10-02',unitValue:'110.000000',source:'live',value:110,prices:{VTI:12}}]);
  expect(result?.stats[0]).toMatchObject({source:'live',allTimeReturnPercent:'10.00'});
  const today=await f.performance(f.strategyId,'1d','actual');
  // Opening value 50 + 5 × 12 = 110; at 12.5 it is 112.5.
  expect(today?.intraday?.points).toEqual([{t:'2026-10-02T19:55:00Z',c:(100*(1+2.5/110)).toFixed(6),s:'regular',value:112.5,prices:{VTI:12.5}}]);
  await expect(f.performance(f.strategyId,'2d','actual')).rejects.toThrow('Invalid performance request');
  expect(await f.performance(randomUUID(),'1m','model')).toBeNull();
  // Your own money in, from the imported source ledger.
  expect(await f.markers(f.strategyId,'1m')).toEqual([{at:'2026-10-01T14:00:00.000Z',direction:'in',party:'viewer',members:1,amount:'100.00',kinds:{invested:1},breakdown:[{kind:'invested',members:1,amount:'100.00'}]}]);
 }finally{f.sync.cancel();await f.db.close();}
});

test('a deposit is not a gain, and yields parse like the hosted fundamentals reader',()=>{
 const ledgers=new Map([['a',[
  {entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',occurredAt:'2026-10-01T14:00:00.000Z'},
  {entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',occurredAt:'2026-10-02T14:00:00.000Z'},
 ]]]);
 const closes=new Map([['VTI',[{day:'2026-10-01',close:'10'},{day:'2026-10-02',close:'10'}]]]);
 expect(actualLine(ledgers,closes,null).map(p=>Number(p.unitValue))).toEqual([100,100]);
 expect([...dividendYields(new Map([['A',{dividend_yield:'1.25'}],['B',{dividendYield:2}],['C',{dividend_yield:'n/a'}],['D',{dividend_yield:'120'}]]))]).toEqual([['A',1.25],['B',2]]);
});

test('mixed-platform performance never looks up Coinbase symbols through Robinhood',async()=>{
 const f=await fixture();try{
  const id=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
    SELECT $2,strategy_id,owner_id,sequence+1,schema_version,metadata,jsonb_set(spec,'{target,weights,0,instrument,venue}','"coinbase"'),provenance,verification FROM strategy_versions WHERE strategy_id=$1`,[f.strategyId,id]);
  await f.db.query('UPDATE strategies SET current_version_id=$2 WHERE id=$1',[f.strategyId,id]);
  expect(await f.performance(f.strategyId,'1m','model')).toBeNull();
  expect(await f.performance(f.strategyId,'1d','actual')).toBeNull();
  expect(f.requests).toEqual([]);
 }finally{f.sync.cancel();await f.db.close();}
});
