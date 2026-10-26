import {adoptVersion,readVersionReview} from '../../../src/main/allocations/version-review';
import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createExecutionScheduler,currentSleeves} from '../../../src/main/execution/scheduler';
import type {Executor,Planner,PlanTrigger} from '../../../src/main/execution/contracts';

// Thursday 2026-10-01 11:00 Eastern (session open); the allocation is created then.
const START=Date.parse('2026-10-01T15:00:00Z');
const spec=(rebalance:Record<string,unknown>)=>({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:8000}],cashBps:2000},
 rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null,...rebalance}});

async function fixture(rebalance:Record<string,unknown>={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=START;const clock=()=>now;
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1000',cash:'500',buying_power:'500'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:'2',mark_price:'250'}]}:{results:[]},
 },clock);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[version,strategy,JSON.stringify(spec(rebalance))]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const r=await createAllocationCore(database,clock).invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:randomUUID()});
 // The first purchase has filled and a later run advanced the applied sequence: the allocation follows version 1.
 await db.query(`UPDATE strategy_allocations SET applied_version_sequence=1 WHERE id=$1`,[r.allocationId]);
 const planned:[string,PlanTrigger][]=[];const executed:string[]=[];
 let planFails=false,legsPlanned:string[]=[];
 const planner:Planner={
  async planAllocation(id,trigger){planned.push([id,trigger]);if(planFails)throw new Error('planner down');return {allocationId:id,planId:null,disposition:'planned',reasonCode:null,executionIds:legsPlanned,sleeves:[]};},
  async planLiquidation(){throw new Error('unused');},
 };
 const executor:Executor={async executeAllocation(id){executed.push(id);return {allocationId:id,placed:0,failed:0,parkedReason:null};},async settleLegs(){}};
 let busy=false;
 const scheduler=createExecutionScheduler(database,{planner,executor,clock,busy:()=>busy,busyWait:{ms:200,pollMs:20}});
 return {db,strategy,version,allocationId:r.allocationId,transactionId:r.transactionId,account,scheduler,planned,executed,
  set:(ms:number)=>{now=ms;},failPlanning:(on:boolean)=>{planFails=on;},planLegs:(ids:string[])=>{legsPlanned=ids;},setBusy:(on:boolean)=>{busy=on;},
  close:async()=>{sync.cancel();await db.close();}};
}

test('committed versions wait for explicit adoption and switching itself does not place trades',async()=>{
 const f=await fixture();try{
  await f.scheduler.tick();
  expect(f.planned).toEqual([]);
  const next=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,2,1,'{}',$3,'{}','{}' FROM local_owners`,[next,f.strategy,JSON.stringify(spec({}))]);
  await f.db.query(`UPDATE strategies SET current_version_id=$2 WHERE id=$1`,[f.strategy,next]);
  f.planLegs(['leg-1']);
  await f.scheduler.tick();
  expect(f.planned).toEqual([]);
  expect(f.executed).toEqual([]);
  expect((await readVersionReview(f.db,f.allocationId)).versionId).toBe(f.version);
  await expect(f.db.transaction(tx=>adoptVersion(tx,f.allocationId,next,f.version))).rejects.toThrow('changed');
  await f.db.query("UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE allocation_id=$1",[f.allocationId]);
  await f.db.query("UPDATE strategy_allocation_transactions SET pending_reason='pending' WHERE id=$1",[f.transactionId]);
  await expect(f.db.transaction(tx=>adoptVersion(tx,f.allocationId,f.version,next))).rejects.toThrow('pending investment actions');
  await f.db.query('UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1',[f.transactionId]);
  const reviewed=await f.db.transaction(tx=>adoptVersion(tx,f.allocationId,f.version,next));
  expect(reviewed.versionId).toBe(next);
  await f.scheduler.tick();
  expect(f.planned).toEqual([]);
  expect(f.executed).toEqual([]);
 }finally{await f.close();}
});

test('queued legs go out during the session only, without re-planning',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,order_request,idempotency_key,request_hash,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,'rebalance','VTI','buy','{}',$6,$7,now(),now())`,[randomUUID(),f.allocationId,f.account,f.strategy,f.transactionId,randomUUID(),createHash('sha256').update('x').digest('hex')]);
  f.set(Date.parse('2026-10-01T23:00:00Z'));await f.scheduler.tick();
  expect(f.executed).toEqual([]);
  f.set(Date.parse('2026-10-02T15:00:00Z'));await f.scheduler.tick();
  expect(f.executed).toEqual([f.allocationId]);
  expect(f.planned).toEqual([]);
 }finally{await f.close();}
});

test('an investment waiting to hold or sell is never rebalanced, and an archived take’s queued sells still go out in the session',async()=>{
 const f=await fixture();try{
  const next=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,2,1,'{}',$3,'{}','{}' FROM local_owners`,[next,f.strategy,JSON.stringify(spec({}))]);
  await f.db.query(`UPDATE strategies SET current_version_id=$2 WHERE id=$1`,[f.strategy,next]);
  await f.db.query(`INSERT INTO strategy_allocation_closures(id,allocation_id,reason,status,opened_at,updated_at,failure_code) VALUES($1,$2,'close','failed',now(),now(),'nothing_to_sell')`,[randomUUID(),f.allocationId]);
  await f.scheduler.tick();
  expect(f.planned).toEqual([]);

  await f.db.query(`UPDATE strategy_allocation_closures SET status='selling' WHERE allocation_id=$1`,[f.allocationId]);
  await f.db.query(`UPDATE strategies SET archived_at=now() WHERE id=$1`,[f.strategy]);
  await f.db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,order_request,idempotency_key,request_hash,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,'liquidate','VTI','sell','{}',$6,$7,now(),now())`,[randomUUID(),f.allocationId,f.account,f.strategy,f.transactionId,randomUUID(),createHash('sha256').update('y').digest('hex')]);
  f.set(Date.parse('2026-10-01T23:00:00Z'));await f.scheduler.tick();
  expect(f.executed).toEqual([]);
  f.set(Date.parse('2026-10-02T15:00:00Z'));await f.scheduler.tick();
  expect(f.executed).toEqual([f.allocationId]);
  expect(f.planned).toEqual([]);
 }finally{await f.close();}
});

test('a scheduled rebalance is due on the period’s first trading day, inside the session, and caught up after downtime',async()=>{
 const f=await fixture({schedule:'monthly'});try{
  await f.scheduler.tick();
  expect(f.planned).toEqual([]);
  // The app was closed over the weekend and the month turn; Monday evening is outside the session.
  f.set(Date.parse('2026-11-02T22:00:00Z'));await f.scheduler.tick();
  expect(f.planned).toEqual([]);
  // Tuesday's session catches it up.
  f.set(Date.parse('2026-11-03T15:00:00Z'));await f.scheduler.tick();
  expect(f.planned).toEqual([[f.allocationId,'scheduled']]);
 }finally{await f.close();}
});

test('drift bands are checked once per trading day against stored quotes',async()=>{
 const f=await fixture({driftBandPoints:5});try{
  // The allocation holds only cash: VTI is 0% against an 80% target.
  await f.db.query(`INSERT INTO market_quotes(symbol,price,observed_at) VALUES('VTI',250,now())`);
  await f.scheduler.tick();
  expect(f.planned).toEqual([[f.allocationId,'drift']]);
  await f.scheduler.tick();
  expect(f.planned).toHaveLength(1);
  expect((await f.db.query(`SELECT last_drift_check_on FROM strategy_allocations`)).rows).toEqual([{last_drift_check_on:'2026-10-01'}]);
 }finally{await f.close();}
});

test('planning errors back off, doubling, and a success resets the count',async()=>{
 const f=await fixture({schedule:'monthly'});try{
  f.set(Date.parse('2026-11-03T15:00:00Z'));f.failPlanning(true);
  await f.scheduler.tick();
  const first=(await f.db.query<{planning_failures:number;planning_reason_code:string;planning_deferred_until:Date}>(`SELECT planning_failures,planning_reason_code,planning_deferred_until FROM strategy_allocations`)).rows[0]!;
  expect(first).toMatchObject({planning_failures:1,planning_reason_code:'retry_backoff'});
  const wait1=new Date(first.planning_deferred_until).getTime()-Date.parse('2026-11-03T15:00:00Z');
  await f.scheduler.tick();
  expect(f.planned).toHaveLength(1);
  f.set(new Date(first.planning_deferred_until).getTime()+1000);await f.scheduler.tick();
  const second=(await f.db.query<{planning_failures:number;planning_deferred_until:Date}>(`SELECT planning_failures,planning_deferred_until FROM strategy_allocations`)).rows[0]!;
  expect(second.planning_failures).toBe(2);
  expect(new Date(second.planning_deferred_until).getTime()-(new Date(first.planning_deferred_until).getTime()+1000)).toBe(wait1*2);
  f.failPlanning(false);f.set(new Date(second.planning_deferred_until).getTime()+1000);await f.scheduler.tick();
  expect((await f.db.query(`SELECT planning_failures FROM strategy_allocations`)).rows).toEqual([{planning_failures:0}]);
 }finally{await f.close();}
});

test('paused and restore-required ticks do nothing; a busy connection is waited for, then the tick steps aside',async()=>{
 const f=await fixture({schedule:'monthly'});try{
  f.set(Date.parse('2026-11-03T15:00:00Z'));
  f.setBusy(true);await f.scheduler.tick();expect(f.planned).toEqual([]);f.setBusy(false);
  // A connection that frees up within the wait does not cost the tick (a quote refresh beside it on the same timer).
  await f.db.query(`UPDATE strategy_allocations SET last_rebalanced_on=NULL`);
  f.setBusy(true);setTimeout(()=>f.setBusy(false),60);await f.scheduler.tick();expect(f.planned).toEqual([[f.allocationId,'scheduled']]);f.planned.length=0;
  await f.db.query(`UPDATE strategy_allocations SET restore_required=true`);await f.scheduler.tick();expect(f.planned).toEqual([]);
  await f.db.query(`UPDATE strategy_allocations SET restore_required=false,status='paused'`);await f.scheduler.tick();expect(f.planned).toEqual([]);
 }finally{await f.close();}
});

test('a first purchase whose legs have filled is planned again, so its applied sequence advances (hosted fill-backed replanning)',async()=>{
 const f=await fixture();try{
  // Invested; its legs filled, but the run that queued them did not advance the sequence.
  await f.db.query(`UPDATE strategy_allocations SET applied_version_sequence=0 WHERE id=$1`,[f.allocationId]);
  await f.scheduler.tick();
  expect(f.planned).toEqual([[f.allocationId,'republish']]);
 }finally{await f.close();}
});

import {append} from '../../../src/main/allocations/ledger';
test('missing or stale prices do not consume the daily drift check',async()=>{
 const f=await fixture({driftBandPoints:5});try{
 await f.db.transaction(tx=>append(tx,{allocationId:f.allocationId,transactionId:f.transactionId,entryType:'fill',instrumentRef:'VTI',symbol:'VTI',quantityDelta:'0.4',cashDelta:'-100',cause:'regression',sourceKind:'test',sourceRef:'regression',occurredAt:new Date(START).toISOString()},new Date(START).toISOString()));
 await f.scheduler.tick();expect(f.planned).toEqual([]);
 expect((await f.db.query('SELECT last_drift_check_on FROM strategy_allocations')).rows[0]).toEqual({last_drift_check_on:null});
 await f.db.query("INSERT INTO market_quotes(symbol,price,observed_at) VALUES('VTI',250,$1)",[new Date(START-3600000).toISOString()]);
 await f.scheduler.tick();expect(f.planned).toEqual([]);
 await f.db.query('UPDATE market_quotes SET observed_at=$1',[new Date(START).toISOString()]);
 await f.scheduler.tick();expect(f.planned).toEqual([[f.allocationId,'drift']]);
 }finally{await f.close();}
});
test('a failed drift plan retries after its backoff and only success completes the daily check',async()=>{
 const f=await fixture({driftBandPoints:5});try{
 f.failPlanning(true);await f.scheduler.tick();expect(f.planned).toHaveLength(1);
 f.failPlanning(false);f.set(START+3600000);await f.scheduler.tick();expect(f.planned).toHaveLength(2);
 await f.scheduler.tick();expect(f.planned).toHaveLength(2);
 }finally{await f.close();}
});

test('idle allocations do not starve work beyond the first page',async()=>{
 const f=await fixture();try{
 // Keep the due row last by UUID; all preceding allocations are already current.
 const ids:string[]=[];
 for(let i=0;i<51;i++){
 const strategy=randomUUID(),version=randomUUID(),id=randomUUID();ids.push(id);
 await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await f.db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners",[version,strategy,JSON.stringify(spec({}))]);
 await f.db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await f.db.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,applied_version_sequence,status,currency,created_at,updated_at)
 SELECT $1,account_id,$2,$3,1,'active',currency,created_at,updated_at FROM strategy_allocations WHERE id=$4`,[id,strategy,version,f.allocationId]);
 }
 const due=ids.sort().at(-1)!;await f.db.query('UPDATE strategy_allocations SET applied_version_sequence=0 WHERE id=$1',[due]);
 await f.scheduler.tick();await f.scheduler.tick();expect(f.planned.some(([id])=>id===due)).toBe(true);
 }finally{await f.close();}
});


test('daily rebalance waits for the next trading session and does not repeat a completed day',async()=>{
 const f=await fixture({schedule:'daily'});try{
  await f.scheduler.tick();expect(f.planned).toEqual([]);
  f.set(Date.parse('2026-10-02T12:00:00Z'));await f.scheduler.tick();expect(f.planned).toEqual([]);
  f.set(Date.parse('2026-10-02T15:00:00Z'));await f.scheduler.tick();
  expect(f.planned).toEqual([[f.allocationId,'scheduled']]);
  await f.db.query("UPDATE strategy_allocations SET last_rebalanced_on='2026-10-02' WHERE id=$1",[f.allocationId]);
  await f.scheduler.tick();expect(f.planned).toHaveLength(1);
  f.set(Date.parse('2026-10-03T15:00:00Z'));await f.scheduler.tick();expect(f.planned).toHaveLength(1);
  f.set(Date.parse('2026-10-05T15:00:00Z'));await f.scheduler.tick();expect(f.planned).toHaveLength(2);
 }finally{await f.close();}
});

test('crypto drift uses exact pair quotes and refuses stale prices instead of same-ticker equity prices',async()=>{
 const f=await fixture();try{
  const at='2026-10-17T15:00:00Z',now=Date.parse(at),ref=JSON.stringify(['robinhood','production','btc','crypto',null,null]);
  const {append}=await import('../../../src/main/allocations/ledger');
  await f.db.transaction(tx=>append(tx,{allocationId:f.allocationId,transactionId:f.transactionId,entryType:'fill',cause:'synthetic-crypto',instrumentRef:ref,assetClass:'crypto',symbol:'BTC',quantityDelta:'1',cashDelta:'-50',sourceKind:'test',sourceRef:'test',occurredAt:at},at));
  await f.db.query(`INSERT INTO market_quotes(symbol,price,observed_at) VALUES('BTC',9999,$1)`,[at]);
  const run=randomUUID(),snap=randomUUID();
  await f.db.query(`INSERT INTO account_sync_runs(id,account_id,resource,state,started_at,finished_at) VALUES($1,$2,'crypto_positions','completed',$3,$3)`,[run,f.account,at]);
  const data=[{instrumentRef:ref,symbol:'BTC',markPrice:'50',priceObservedAt:at}];
  await f.db.query(`INSERT INTO position_snapshots(id,account_id,asset_class,payload_hash,data) VALUES($1,$2,'crypto','synthetic',$3)`,[snap,f.account,JSON.stringify(data)]);
  await f.db.query(`INSERT INTO account_observations(id,run_id,account_id,resource,observed_at,position_snapshot_id) VALUES($1,$2,$3,'crypto_positions',$4,$5)`,[randomUUID(),run,f.account,at,snap]);
  const basket={...spec({}),target:{weights:[{instrument:{venue:'robinhood',symbol:'BTC',market:{venue:'robinhood',instance:'production',reference:'btc',kind:'crypto'}},bps:5000}],cashBps:5000}} as any;
  const database={use:async(fn:any)=>fn(f.db)};
  expect(await currentSleeves(database,f.allocationId,basket,now)).toEqual([{symbol:ref,targetWeightPercent:50,currentWeightPercent:50}]);
  expect(await currentSleeves(database,f.allocationId,basket,now+61000)).toBeNull();
 }finally{await f.close();}
});
