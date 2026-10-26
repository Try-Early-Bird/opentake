import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {append,instruction} from '../../../src/main/allocations/ledger';
import {createPlanner} from '../../../src/main/execution/planner';
import {equityOrderSchema} from '../../../src/main/orders/contract';

// Monday 2026-10-05, 11:00 Eastern.
const start=Date.parse('2026-10-05T15:00:00Z');

async function fixture(options:{weights?:[string,number][];cashBps?:number;positions?:{symbol:string;quantity:string;mark:string|null}[];committedAt?:string;closes?:Map<string,{day:string;close:string}[]>}={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=start;
 let positions=options.positions??[{symbol:'VTI',quantity:'1',mark:'100'},{symbol:'QQQ',quantity:'1',mark:'100'}];
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'2000',cash:'1000',buying_power:'1000'}
   :name==='get_equity_positions'?{results:positions.map(p=>({instrument_id:p.symbol.toLowerCase(),symbol:p.symbol,quantity:p.quantity,...(p.mark===null?{}:{mark_price:p.mark})}))}
   :name==='get_equity_quotes'?{results:[]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 const weights=options.weights??[['VTI',6000],['QQQ',4000]];
 const spec={schemaVersion:1,kind:'basket',target:{weights:weights.map(([symbol,bps])=>({instrument:{venue:'robinhood',symbol},bps})),cashBps:options.cashBps??0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification,created_at)
  SELECT $1,$2,id,1,1,'{}',$3,'{}','{}',$4 FROM local_owners`,[version,strategy,JSON.stringify(spec),options.committedAt??new Date(now).toISOString()]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const core=createAllocationCore(database,()=>now);
 const r=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:randomUUID()});
 const planner=createPlanner(database,options.closes===undefined?{}:{closes:async()=>options.closes!},()=>now);
 const legs=async()=>(await db.query<{symbol:string;side:string;kind:string;status:string;order_request:Record<string,string>;transaction_id:string}>(`SELECT symbol,side,kind,status,order_request,transaction_id FROM strategy_executions WHERE allocation_id=$1 ORDER BY side DESC,symbol`,[r.allocationId])).rows;
 const allocationRow=async()=>(await db.query<{planning_reason_code:string|null;applied_version_sequence:number;status:string}>(`SELECT planning_reason_code,applied_version_sequence,status FROM strategy_allocations WHERE id=$1`,[r.allocationId])).rows[0]!;
 /** Gives the allocation holdings, as fills would, and lets the snapshot cover them. */
 async function hold(entries:{symbol:string;quantity:string;cash:string}[]){
  await db.transaction(async tx=>{
   const at=new Date(now).toISOString();
   for(const e of entries)await append(tx,{allocationId:r.allocationId,transactionId:r.transactionId,entryType:'fill',instrumentRef:e.symbol.toLowerCase(),symbol:e.symbol,
    quantityDelta:e.quantity,cashDelta:e.cash,cause:`fill:${randomUUID()}`,sourceKind:'test',sourceRef:'test',occurredAt:at},at);
   // The waiting deposit is spent once the basket is held.
   await tx.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1`,[r.transactionId]);
  });
 }
 return {db,database,account,strategy,version,r,core,planner,sync,legs,allocationRow,hold,
  setPositions:async(next:typeof positions)=>{positions=next;now+=1000;await sync.synchronize();},
  later:(ms:number)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('a first purchase buys the whole basket under the waiting deposit, in the writer’s order contract',async()=>{
 const f=await fixture();try{
  const result=await f.planner.planAllocation(f.r.allocationId,'activation');
  expect(result).toMatchObject({disposition:'planned',reasonCode:null});
  expect(result.executionIds).toHaveLength(2);
  const legs=await f.legs();
  expect(legs.map(l=>[l.symbol,l.side,l.kind,l.status,l.order_request.dollar_amount])).toEqual([['QQQ','buy','subscribe','queued','40'],['VTI','buy','subscribe','queued','60']]);
  expect(legs.every(l=>equityOrderSchema.safeParse(l.order_request).success&&l.transaction_id===f.r.transactionId)).toBe(true);
  // Queued legs do not count as applied: fills decide that.
  expect(await f.allocationRow()).toMatchObject({applied_version_sequence:0,planning_reason_code:null});
  expect((await f.db.query(`SELECT pending_reason FROM strategy_allocation_transactions WHERE id=$1`,[f.r.transactionId])).rows[0]).toEqual({pending_reason:null});
  expect((await f.db.query(`SELECT disposition,trigger FROM strategy_execution_plans WHERE allocation_id=$1`,[f.r.allocationId])).rows).toEqual([{disposition:'planned',trigger:'activation'}]);
  // Open legs block another plan.
  expect(await f.planner.planAllocation(f.r.allocationId,'manual')).toMatchObject({disposition:'deferred',reasonCode:'open_execution'});
  expect((await f.allocationRow()).planning_reason_code).toBe('open_execution');
 }finally{await f.close();}
});

test('a first purchase that would omit a holding under the $1 minimum waits instead',async()=>{
 const f=await fixture({weights:[['VTI',9950],['QQQ',50]]});try{
  expect(await f.planner.planAllocation(f.r.allocationId,'activation')).toMatchObject({disposition:'deferred',reasonCode:'incomplete_basket'});
  expect(await f.legs()).toEqual([]);
  expect((await f.db.query(`SELECT pending_reason FROM strategy_allocation_transactions WHERE id=$1`,[f.r.transactionId])).rows[0]).toEqual({pending_reason:'incomplete_basket'});
 }finally{await f.close();}
});

test('a rebalance sizes sells first and lets their proceeds fund buys, at a haircut',async()=>{
 const f=await fixture();try{
  await f.hold([{symbol:'VTI',quantity:'0.8',cash:'-80'},{symbol:'QQQ',quantity:'0.2',cash:'-20'}]);
  const result=await f.planner.planAllocation(f.r.allocationId,'scheduled');
  expect(result.disposition).toBe('planned');
  const legs=await f.legs();
  expect(legs.map(l=>[l.symbol,l.side,l.kind])).toEqual([['VTI','sell','rebalance'],['QQQ','buy','rebalance']]);
  expect(Number(legs[0]!.order_request.quantity)).toBeCloseTo(0.2,6);
  // 20 raised, credited at 99%: the buy spends no more than 19.80.
  expect(Number(legs[1]!.order_request.dollar_amount)).toBeLessThanOrEqual(19.8);
  expect(result.sleeves.find(s=>s.symbol==='VTI')).toMatchObject({side:'sell',currentWeightPercent:80,targetWeightPercent:60});
 }finally{await f.close();}
});

test('sleeves carry each order\'s USD notional, sells included; a notional cap refuses the plan without parking it',async()=>{
 const f=await fixture();try{
  await f.hold([{symbol:'VTI',quantity:'0.8',cash:'-80'},{symbol:'QQQ',quantity:'0.2',cash:'-20'}]);
  const preview=await f.planner.previewAllocation(f.r.allocationId,'manual');
  const sell=preview.sleeves.find(s=>s.symbol==='VTI')!;
  // The sell's amount is shares; its notional is dollars at the sizing mark.
  expect(Number(sell.amount)).toBeCloseTo(0.2,6);expect(Number(sell.notionalUsd)).toBeCloseTo(20,2);
  const capped=await f.planner.planAllocation(f.r.allocationId,'manual',{maxNotionalUsd:'30'});
  expect(capped).toMatchObject({disposition:'deferred',reasonCode:'notional_cap'});
  expect(await f.legs()).toEqual([]);
  expect((await f.planner.planAllocation(f.r.allocationId,'manual',{maxNotionalUsd:'45'})).disposition).toBe('planned');
 }finally{await f.close();}
});

test('a deposit only buys: an overweight holding is left for the next rebalance',async()=>{
 const f=await fixture();try{
  // After the $50 deposit the allocation is $150: VTI holds $95 against a $90 target, QQQ $5 against $60.
  await f.hold([{symbol:'VTI',quantity:'0.95',cash:'-95'},{symbol:'QQQ',quantity:'0.05',cash:'-5'}]);
  await f.db.transaction(async tx=>{const at=new Date(start).toISOString();
   const t=await instruction(tx,{allocationId:f.r.allocationId,kind:'contribution',cause:'deposit-1',requestedAmount:'50',pendingReason:'requested'},at);
   await append(tx,{allocationId:f.r.allocationId,transactionId:t,entryType:'capital_allocated',cashDelta:'50',cause:'capital:deposit-1',sourceKind:'test',sourceRef:'t',occurredAt:at},at);});
  expect((await f.planner.planAllocation(f.r.allocationId,'deposit')).disposition).toBe('planned');
  const legs=await f.legs();
  expect(legs.every(l=>l.side==='buy')).toBe(true);
  expect(legs.map(l=>l.symbol)).toEqual(['QQQ']);
 }finally{await f.close();}
});

test('gates: stale positions, a held mark missing, restore or pause, a blocked holding on a first purchase',async()=>{
 const f=await fixture();try{
  f.later(16*60_000);
  expect(await f.planner.planAllocation(f.r.allocationId,'activation')).toMatchObject({disposition:'deferred',reasonCode:'fresh_position_snapshot_required'});
  await f.setPositions([{symbol:'VTI',quantity:'1',mark:'100'},{symbol:'QQQ',quantity:'1',mark:'100'}]);
  await f.db.query(`INSERT INTO trading_preferences(owner_id,blocked_symbols,updated_at) SELECT id,'{QQQ}',now() FROM local_owners`);
  expect(await f.planner.planAllocation(f.r.allocationId,'activation')).toMatchObject({disposition:'deferred',reasonCode:'symbol_blocked'});
  await f.db.query(`DELETE FROM trading_preferences`);
  await f.hold([{symbol:'VTI',quantity:'0.6',cash:'-60'},{symbol:'QQQ',quantity:'0.4',cash:'-40'}]);
  await f.setPositions([{symbol:'VTI',quantity:'1',mark:'100'},{symbol:'QQQ',quantity:'1',mark:null}]);
  expect(await f.planner.planAllocation(f.r.allocationId,'scheduled')).toMatchObject({disposition:'deferred',reasonCode:'missing_position_valuation'});
  await f.db.query(`UPDATE strategy_allocations SET restore_required=true,status='paused' WHERE id=$1`,[f.r.allocationId]);
  expect(await f.planner.planAllocation(f.r.allocationId,'scheduled')).toMatchObject({disposition:'deferred',reasonCode:'restore_required'});
  await f.db.query(`UPDATE strategy_allocations SET restore_required=false WHERE id=$1`,[f.r.allocationId]);
  expect(await f.planner.planAllocation(f.r.allocationId,'scheduled')).toMatchObject({disposition:'deferred',reasonCode:'allocation_paused'});
  expect(await f.legs()).toEqual([]);
 }finally{await f.close();}
});

test('a held basket on its targets is up to date and marks the version applied',async()=>{
 const f=await fixture();try{
  await f.hold([{symbol:'VTI',quantity:'0.6',cash:'-60'},{symbol:'QQQ',quantity:'0.4',cash:'-40'}]);
  expect(await f.planner.planAllocation(f.r.allocationId,'scheduled')).toMatchObject({disposition:'up_to_date',reasonCode:null,executionIds:[]});
  expect(await f.allocationRow()).toMatchObject({applied_version_sequence:1});
  // A republish of the same version has nothing to do.
  expect((await f.planner.planAllocation(f.r.allocationId,'republish')).disposition).toBe('up_to_date');
 }finally{await f.close();}
});

test('a close sells every holding above the minimum; a redemption sells part of each, in shares',async()=>{
 const f=await fixture();try{
  await f.hold([{symbol:'VTI',quantity:'0.6',cash:'-60'},{symbol:'QQQ',quantity:'0.4',cash:'-40'}]);
  const redeem=await f.db.transaction(tx=>instruction(tx,{allocationId:f.r.allocationId,kind:'redemption',cause:'redeem-1',requestedAmount:'10'},new Date(start).toISOString()));
  const partial=await f.planner.planLiquidation(f.r.allocationId,{kind:'redeem',transactionId:redeem,amount:'10'});
  expect(partial.disposition).toBe('planned');
  const sold=await f.legs();
  expect(sold.every(l=>l.side==='sell'&&l.kind==='redeem')).toBe(true);
  expect(sold.reduce((sum,l)=>sum+Number(l.order_request.quantity)*100,0)).toBeGreaterThanOrEqual(9.99);
  await f.db.query(`UPDATE strategy_executions SET status='filled' WHERE allocation_id=$1`,[f.r.allocationId]);
  const exit=await f.db.transaction(tx=>instruction(tx,{allocationId:f.r.allocationId,kind:'exit',cause:'close-1'},new Date(start).toISOString()));
  const close=await f.planner.planLiquidation(f.r.allocationId,{kind:'liquidate',transactionId:exit,symbols:['VTI']});
  expect(close.disposition).toBe('planned');
  const liquidations=(await f.legs()).filter(l=>l.kind==='liquidate');
  expect(liquidations.map(l=>[l.symbol,l.order_request.quantity])).toEqual([['VTI','0.6']]);
  expect((await f.allocationRow()).planning_reason_code).toBe('liquidating');
 }finally{await f.close();}
});

test('preflight explains every reason an amount cannot be invested',async()=>{
 const f=await fixture();try{
  const ok=await f.planner.preflight({accountId:f.account,strategyId:f.strategy,amount:'100'});
  expect(ok).toMatchObject({ok:true,minimumAllocationUsd:'5',legs:[{symbol:'QQQ',notionalUsd:'40'},{symbol:'VTI',notionalUsd:'60'}]});
  const small=await f.planner.preflight({accountId:f.account,strategyId:f.strategy,amount:'2'});
  expect(small.reasons).toContainEqual({code:'incomplete_basket',symbols:[]});
  expect(small.legs).toEqual([]);
  // 1000 cash less the 100 already claimed by the existing allocation.
  const big=await f.planner.preflight({accountId:f.account,strategyId:f.strategy,amount:'950'});
  expect(big.reasons.map(r=>r.code)).toContain('insufficient_cash');
 }finally{await f.close();}
});

test('the model’s current weights are what new money buys; a model not valued through the last session waits',async()=>{
 // Committed Wednesday at 50/50; VTI then doubles while QQQ is flat, so by Friday's close the model holds 2/3 VTI.
 const closes=new Map([['VTI',[{day:'2026-09-30',close:'100'},{day:'2026-10-01',close:'150'},{day:'2026-10-02',close:'200'}]],['QQQ',[{day:'2026-09-30',close:'100'},{day:'2026-10-01',close:'100'},{day:'2026-10-02',close:'100'}]]]);
 const f=await fixture({weights:[['VTI',5000],['QQQ',5000]],committedAt:'2026-09-30T15:00:00Z',closes});try{
  const result=await f.planner.planAllocation(f.r.allocationId,'activation');
  expect(result.disposition).toBe('planned');
  expect(result.sleeves.map(s=>[s.symbol,s.targetWeightPercent])).toEqual([['QQQ',33.33],['VTI',66.67]]);
 }finally{await f.close();}
 const behind=new Map([...closes].map(([symbol,list])=>[symbol,list.slice(0,2)]));
 const g=await fixture({weights:[['VTI',5000],['QQQ',5000]],committedAt:'2026-09-30T15:00:00Z',closes:behind});try{
  expect(await g.planner.planAllocation(g.r.allocationId,'activation')).toMatchObject({disposition:'deferred',reasonCode:'model_stale'});
 }finally{await g.close();}
});

test('a delisted symbol gets no leg: the rest of the basket is bought',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO symbol_delistings(symbol,delisted_on,last_close) VALUES('QQQ','2026-10-01',400)`);
  const result=await f.planner.planAllocation(f.r.allocationId,'activation');
  expect(result.disposition).toBe('planned');
  expect((await f.legs()).map(l=>[l.symbol,l.side])).toEqual([['VTI','buy']]);
 }finally{await f.close();}
});

import {createPriceStore} from '../../../src/main/market-series/price-store';
test('older versions plan through the production database-backed price store without deadlocking',async()=>{
 const f=await fixture({committedAt:'2026-10-02T15:00:00Z'});try{
 await f.db.exec("INSERT INTO market_daily_closes(symbol,day,close,observed_at) VALUES('VTI','2026-10-02',100,now()),('QQQ','2026-10-02',100,now())");
 const prices=createPriceStore(f.database,{status:async()=>{throw new Error('No network');},readTool:async()=>{throw new Error('No network');}});
 const planner=createPlanner(f.database,{closes:(symbols,from,query)=>prices.closes(symbols,from,query)},()=>start);
 expect((await planner.planAllocation(f.r.allocationId,'activation')).disposition).toBe('planned');
 }finally{await f.close();}
});
test('cancelled first purchase can be replanned with new keys without resending an open plan',async()=>{
 const f=await fixture();try{
 const first=await f.planner.planAllocation(f.r.allocationId,'republish');expect(first.disposition).toBe('planned');
 expect((await f.planner.planAllocation(f.r.allocationId,'republish')).reasonCode).toBe('open_execution');
 await f.db.query("UPDATE strategy_executions SET status='cancelled',terminal_at=now()");f.later(1000);
 const next=await f.planner.planAllocation(f.r.allocationId,'republish');expect(next.disposition).toBe('planned');expect(next.executionIds).not.toEqual(first.executionIds);
 }finally{await f.close();}
});
test('daily cap counts earlier share-denominated sell legs',async()=>{
 const f=await fixture();try{
 await f.db.query('UPDATE strategy_allocations SET max_daily_notional=110 WHERE id=$1',[f.r.allocationId]);
 await f.db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at,planned_notional)
 VALUES($1,$2,$3,$4,$5,'rebalance','VTI','sell','filled','{"symbol":"VTI","side":"sell","type":"market","quantity":"0.5"}',$6,repeat('a',64),$7,$7,50)`,[randomUUID(),f.r.allocationId,f.account,f.strategy,f.r.transactionId,randomUUID(),new Date(start).toISOString()]);
 expect(await f.planner.planAllocation(f.r.allocationId,'activation')).toMatchObject({disposition:'deferred',reasonCode:'daily_notional_limit'});
 }finally{await f.close();}
});

test('an accepted mixed-platform version cannot plan equity orders even for a matching ticker',async()=>{
 const f=await fixture();try{
  const id=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $2,strategy_id,owner_id,sequence+1,schema_version,metadata,jsonb_set(spec,'{target,weights,0,instrument,venue}','"coinbase"'),provenance,verification FROM strategy_versions WHERE id=$1`,[f.version,id]);
  await f.db.query('UPDATE strategies SET current_version_id=$2 WHERE id=$1',[f.strategy,id]);
  await f.db.query('UPDATE strategy_allocations SET accepted_version_id=$2 WHERE id=$1',[f.r.allocationId,id]);
  await expect(f.planner.planAllocation(f.r.allocationId,'republish')).rejects.toThrow('mixed-platform');
  expect(await f.legs()).toEqual([]);
 }finally{await f.close();}
});

test.each([
 ['60','40','10',{QQQ:10}],['60','40','20',{QQQ:20}],['60','40','40',{VTI:10,QQQ:30}],['50','50','20',{VTI:10,QQQ:10}],
])('deposit targets post-deposit weights: %s/%s plus %s',async(vti,qqq,cash,expected)=>{
 const f=await fixture({weights:[['VTI',5000],['QQQ',5000]]});try{
  await f.hold([{symbol:'VTI',quantity:String(Number(vti)/100),cash:'-'+vti},{symbol:'QQQ',quantity:String(Number(qqq)/100),cash:'-'+qqq}]);
  await f.db.transaction(async tx=>{const at=new Date(start).toISOString();const t=await instruction(tx,{allocationId:f.r.allocationId,kind:'contribution',cause:'deposit-example',requestedAmount:cash,pendingReason:'requested'},at);
   await append(tx,{allocationId:f.r.allocationId,transactionId:t,entryType:'capital_allocated',cashDelta:cash,cause:'capital:example',sourceKind:'test',sourceRef:'example',occurredAt:at},at);});
  expect((await f.planner.planAllocation(f.r.allocationId,'deposit')).disposition).toBe('planned');
  const legs=await f.legs();expect(legs.every(l=>l.side==='buy')).toBe(true);
  expect(Object.fromEntries(legs.map(l=>[l.symbol,Number(l.order_request.dollar_amount)]))).toEqual(expected);
 }finally{await f.close();}
});


test('deposits keep accepted weights when a newer version is committed',async()=>{
 const f=await fixture();try{
  const id=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $2,strategy_id,owner_id,sequence+1,schema_version,metadata,jsonb_set(jsonb_set(spec,'{target,weights,0,bps}','9000'),'{target,weights,1,bps}','1000'),provenance,verification FROM strategy_versions WHERE id=$1`,[f.version,id]);
  await f.db.query('UPDATE strategies SET current_version_id=$2 WHERE id=$1',[f.strategy,id]);
  const result=await f.planner.planAllocation(f.r.allocationId,'deposit');
  expect(result.sleeves.map(s=>[s.symbol,s.targetWeightPercent]).sort()).toEqual([['QQQ',40],['VTI',60]]);
 }finally{await f.close();}
});
