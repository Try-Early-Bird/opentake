import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {bindStrategyLots,lotsForAllocationSell,ownLotsForSale} from '../../../src/main/execution/sell-lots';
import {createPlanner} from '../../../src/main/execution/planner';
import type {RobinhoodTaxLot} from '../../../src/main/allocations/tax-lots';
import {instruction} from '../../../src/main/allocations/ledger';

const lot=(openLotId:string,quantity:string,acquiredAt:string,extra:Partial<RobinhoodTaxLot>={}):RobinhoodTaxLot=>({openLotId,quantity,costBasis:null,unitCost:'10',acquiredAt,...extra});

// One account holding 20 VTI; an allocation that bought 5 of them through Opentake.
async function fixture(options:{shares?:string}={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-10-05T15:00:00Z');let shares=options.shares??'20';
 const core=createAllocationCore(database,()=>now);
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,
  [version,strategy,JSON.stringify({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}})]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const invested=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'50',cause:randomUUID()});
 now+=1000;
 // The strategy's buy fill, linked to its instruction, bought 5 at 10 on Oct 5.
 const ref='fill-1',at=new Date(now).toISOString();
 await db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','filled',true,'{}',$3,$3)`,[account,ref,at]);
 await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood',$2,$2,'equity',$3,$4)`,
  [account,ref,JSON.stringify({quantity:'5',price:'10',feeAmount:null,notionalAmount:null,side:'buy',instrumentRef:'VTI',symbol:'VTI',origin:'agentic',orderCreatedAt:at,occurredAt:at}),at]);
 await core.attribute({accountId:account,provider:'robinhood',executionRef:ref},{instruction:{...invested,accountId:account,provider:'robinhood',orderRef:ref}});
 return {db,database,core,account,allocationId:invested.allocationId,clock:()=>now,later:(ms:number)=>{now+=ms;},
  resync:async(next:string)=>{shares=next;now+=1000;await sync.synchronize();},close:async()=>{sync.cancel();await db.close();}};
}
const mine=lot('lot-strategy','5','2026-10-05T14:00:00Z');
const theirs=lot('lot-member','15','2026-01-02T14:00:00Z');

test('a strategy buy binds to the lot it created; sells then name the strategy’s own lots',async()=>{
 const f=await fixture();try{
  await f.db.query(`UPDATE strategy_allocations SET status='active'`);
  // Before binding, sells keep the provider default.
  expect(await f.database.use(db=>lotsForAllocationSell(db,{allocationId:f.allocationId,symbol:'VTI',quantity:'2',live:[mine,theirs],nowMs:f.clock()}))).toEqual({kind:'provider_default'});
  const reads:string[]=[];
  expect(await bindStrategyLots(f.database,f.core,async(_a,symbol)=>{reads.push(symbol);return [theirs,mine];},f.account,f.clock)).toEqual({matched:1,unmatched:0});
  expect(reads).toEqual(['VTI']);
  // The next day the lot has settled: the sell names it.
  f.later(86_400_000);
  expect(await f.database.use(db=>lotsForAllocationSell(db,{allocationId:f.allocationId,symbol:'VTI',quantity:'2',live:[mine,theirs],nowMs:f.clock()})))
   .toEqual({kind:'lots',taxLots:[{open_lot_id:'lot-strategy',quantity:'2'}]});
  // Already bound fills are not read again.
  expect(await bindStrategyLots(f.database,f.core,async()=>{throw new Error('should not read');},f.account,f.clock)).toEqual({matched:0,unmatched:0});
 }finally{await f.close();}
});

test('a lot bought today waits when the position is shared, and sells unnamed when the strategy holds all of it',async()=>{
 const shared=await fixture();try{
  await bindStrategyLots(shared.database,shared.core,async()=>[theirs,mine],shared.account,shared.clock);
  expect(await shared.database.use(db=>lotsForAllocationSell(db,{allocationId:shared.allocationId,symbol:'VTI',quantity:'2',live:[mine,theirs],nowMs:shared.clock()}))).toEqual({kind:'unsettled'});
 }finally{await shared.close();}
 const whole=await fixture({shares:'5'});try{
  await bindStrategyLots(whole.database,whole.core,async()=>[mine],whole.account,whole.clock);
  // A sync after the buy: the 5 shares are all the strategy's.
  await whole.resync('5');
  expect(await whole.database.use(db=>lotsForAllocationSell(db,{allocationId:whole.allocationId,symbol:'VTI',quantity:'2',live:[mine],nowMs:whole.clock()}))).toEqual({kind:'provider_default'});
 }finally{await whole.close();}
});

test('when the member’s own sale took the strategy’s lot it borrows unclaimed lots, unless the shares are really gone',async()=>{
 const f=await fixture();try{
  await bindStrategyLots(f.database,f.core,async()=>[theirs,mine],f.account,f.clock);
  f.later(86_400_000);
  // Robinhood FIFO sold the strategy's lot; the account still holds 15 >= the 5 claimed.
  const borrowed=await f.database.use(db=>lotsForAllocationSell(db,{allocationId:f.allocationId,symbol:'VTI',quantity:'2',live:[theirs],nowMs:f.clock()}));
  expect(borrowed).toEqual({kind:'lots',taxLots:[{open_lot_id:'lot-member',quantity:'2'}]});
  await f.resync('3');
  expect(await f.database.use(db=>lotsForAllocationSell(db,{allocationId:f.allocationId,symbol:'VTI',quantity:'2',live:[lot('lot-member','3','2026-01-02T14:00:00Z')],nowMs:f.clock()}))).toEqual({kind:'unavailable'});
 }finally{await f.close();}
});

test('your own sell names your unclaimed lots, and refuses when only strategy lots would cover it',async()=>{
 const f=await fixture();try{
  const read=async()=>[mine,theirs];
  expect(await f.database.use(db=>ownLotsForSale(db,read,{accountId:f.account,instrumentRef:'VTI',symbol:'VTI',quantity:'3'}))).toBeNull();
  await bindStrategyLots(f.database,f.core,read,f.account,f.clock);
  expect(await f.database.use(db=>ownLotsForSale(db,read,{accountId:f.account,instrumentRef:'VTI',symbol:'VTI',quantity:'3'}))).toEqual([{open_lot_id:'lot-member',quantity:'3'}]);
  await expect(f.database.use(db=>ownLotsForSale(db,read,{accountId:f.account,instrumentRef:'VTI',symbol:'VTI',quantity:'16'}))).rejects.toThrow('belong to your takes');
 }finally{await f.close();}
});

test('a planned close names the strategy’s lots, and waits on an unsettled lot in a shared position',async()=>{
 const f=await fixture();try{
  await bindStrategyLots(f.database,f.core,async()=>[theirs,mine],f.account,f.clock);
  const close=async()=>{
   const transactionId=await f.db.transaction(tx=>instruction(tx,{allocationId:f.allocationId,kind:'exit',cause:randomUUID()},new Date(f.clock()).toISOString()));
   return createPlanner(f.database,{taxLots:async()=>[mine,theirs]},f.clock).planLiquidation(f.allocationId,{kind:'liquidate',transactionId,symbols:null});
  };
  expect(await close()).toMatchObject({disposition:'deferred',reasonCode:'lots_unsettled'});
  f.later(86_400_000);await f.resync('20');
  const planned=await close();
  expect(planned.disposition).toBe('planned');
  const legs=(await f.db.query<{order_request:unknown}>(`SELECT order_request FROM strategy_executions WHERE allocation_id=$1`,[f.allocationId])).rows;
  expect(legs).toEqual([{order_request:{symbol:'VTI',side:'sell',type:'market',quantity:'5',tax_lots:[{open_lot_id:'lot-strategy',quantity:'5'}]}}]);
 }finally{await f.close();}
});

test('a sale that borrows past the strategy’s own lot uses settled lots first and never names one bought today (live EQUITY_TAX_LOT_STALE)',async()=>{
 const f=await fixture();try{
  // The strategy's only bound lot was bought today; it holds more than that lot (an import), so selling 7 borrows.
  await bindStrategyLots(f.database,f.core,async()=>[theirs,mine],f.account,f.clock);
  // Today it sells from settled lots only, never naming today's lot.
  expect(await f.database.use(db=>lotsForAllocationSell(db,{allocationId:f.allocationId,symbol:'VTI',quantity:'7',live:[mine,theirs],nowMs:f.clock()})))
   .toEqual({kind:'lots',taxLots:[{open_lot_id:'lot-member',quantity:'7'}]});
  // The next day the same sale names both lots.
  f.later(86_400_000);
  expect(await f.database.use(db=>lotsForAllocationSell(db,{allocationId:f.allocationId,symbol:'VTI',quantity:'7',live:[mine,theirs],nowMs:f.clock()})))
   .toEqual({kind:'lots',taxLots:[{open_lot_id:'lot-strategy',quantity:'5'},{open_lot_id:'lot-member',quantity:'2'}]});
 }finally{await f.close();}
});
