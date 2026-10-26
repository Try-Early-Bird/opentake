import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {importStrategyPortfolio} from '../../../src/main/allocations/portfolio-import';
import {computeAllocationHistory,createAllocationHistory,dailyClosesFromSeries} from '../../../src/main/allocations/allocation-history';
import type {MarketSeries,SymbolSeries} from '../../../src/shared/market-series';
const now=Date.parse('2026-10-03T14:00:00Z');
const vti=(points:[string,string,'regular'|'post'][]):SymbolSeries=>({symbol:'VTI',interval:'hour',bounds:'regular',baseline:null,price:null,extendedPrice:null,extendedSession:null,change:null,extendedChange:null,points:points.map(([t,c,s])=>({t,c,s}))});

test('daily closes keep the last regular bar of each Eastern day',()=>{
 const closes=dailyClosesFromSeries([vti([['2026-10-01T19:00:00Z','10','regular'],['2026-10-01T20:00:00Z','11','regular'],['2026-10-01T22:00:00Z','99','post'],['2026-10-02T19:00:00Z','12','regular']])]);
 expect(closes.get('VTI')).toEqual([{day:'2026-10-01',close:'11'},{day:'2026-10-02',close:'12'}]);
});

test('history applies entries through each Eastern day and skips days without a close',()=>{
 const entries=[{entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',occurredAt:'2026-10-01T14:00:00.000Z'},{entryType:'fill',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',occurredAt:'2026-10-02T03:30:00.000Z'}];
 // 23:30 Eastern on Oct 1 belongs to Oct 1; QQQ has no close, so a day holding it would be skipped.
 expect(computeAllocationHistory({entries,closesBySymbol:new Map([['VTI',[{day:'2026-10-01',close:'10'},{day:'2026-10-02',close:'12'}]]]),days:['2026-10-01','2026-10-02']}))
  .toEqual([{day:'2026-10-01',totalValue:'100',capitalAllocated:'100'},{day:'2026-10-02',totalValue:'110',capitalAllocated:'100'}]);
 expect(computeAllocationHistory({entries:[...entries,{entryType:'fill',symbol:'QQQ',quantityDelta:'1',cashDelta:'0',occurredAt:'2026-10-02T15:00:00.000Z'}],closesBySymbol:new Map([['VTI',[{day:'2026-10-01',close:'10'},{day:'2026-10-02',close:'12'}]]]),days:['2026-10-01','2026-10-02']}))
  .toEqual([{day:'2026-10-01',totalValue:'100',capitalAllocated:'100'}]);
});

test('imported allocations replay the source ledger without counting the opening claims twice',async()=>{
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-hash','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:'20',mark_price:'10',average_buy_price:'8'}]}:{results:[]},
 },()=>now);
 try{
  await sync.synchronize();
  const sourceConnection=randomUUID(),strategyId=randomUUID();
  const input={format:'opentake-strategy-portfolio-v1',exportedAt:new Date(now).toISOString(),source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-hash`).digest('hex')},
   strategies:[{id:strategyId,title:'Imported strategy',description:'Synthetic',rebalance:null,versions:[{id:randomUUID(),sequence:1,weights:[{symbol:'VTI',weightPercent:80}],cashPercent:20}]}],
   allocations:[{id:randomUUID(),strategyId,status:'active',appliedSequence:1,entries:[
    {id:randomUUID(),sequence:1,entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',unitCost:null,currency:'USD',sourceKind:'reconciliation',sourceRef:'fixture1',occurredAt:'2026-10-01T14:00:00Z'},
    {id:randomUUID(),sequence:2,entryType:'fill',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',currency:'USD',sourceKind:'strategy_execution',sourceRef:'fixture2',occurredAt:'2026-10-02T15:00:00Z'},
   ],history:[]}]};
  await importStrategyPortfolio(database,input,undefined,now,{externalRef:'synthetic-hash',connectionId:sourceConnection,accountRefHash:input.source.accountRefHash});
  const allocationId=(await sync.snapshot()).strategies![0].allocationId;
  let calls=0;
  const series=async({range}:{range:string}):Promise<MarketSeries>=>({venue:'robinhood_agentic',range:range as MarketSeries['range'],asOf:new Date(now).toISOString(),staleSymbols:[],refreshingSymbols:[],
   // The first call is still filling, as the bounded series service reports.
   pendingSymbols:calls++===0?['VTI']:[],series:calls===1?[]:[vti([['2026-09-30T19:00:00Z','9','regular'],['2026-10-01T19:00:00Z','10','regular'],['2026-10-02T19:00:00Z','12','regular']])]});
  const history=await createAllocationHistory(database,series,()=>now)(allocationId,'1m');
  expect(calls).toBe(2);
  // Sep 30 predates the ledger; Oct 2 is 50 cash + 5 × 12, not doubled by the import's opening claims.
  expect(history).toEqual({allocationId,range:'1m',points:[{day:'2026-10-01',totalValue:'100'},{day:'2026-10-02',totalValue:'110'}]});
  await expect(createAllocationHistory(database,series,()=>now)(allocationId,'1d')).rejects.toThrow();
 }finally{sync.cancel();await db.close();}
});
