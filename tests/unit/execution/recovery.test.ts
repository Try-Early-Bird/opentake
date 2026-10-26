import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate,prepareRestoredDatabase} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createOrderWriter} from '../../../src/main/orders/service';
import {createExecutor} from '../../../src/main/execution/executor';
import {createAttributionSweep} from '../../../src/main/allocations/attribution-sweep';
import {createAllocationResume} from '../../../src/main/allocations/resume';

// Recovery scenarios on synthetic data: the process dying mid-placement,
// in-flight orders blocking cash release, and restoring a backup after the account moved.
// Monday 2026-10-05, 11:00 Eastern: the regular session is open.
const session=Date.parse('2026-10-05T15:00:00Z');

async function fixture(){
 let db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=session,shares='20',orders:unknown[]=[];
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const status=async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]});
 const readTool=async(name:string,args:Record<string,unknown>)=>{
  if(name==='get_portfolio')return {total_value:'1200',cash:'1000',buying_power:'1000'};
  if(name==='get_equity_positions')return {results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10'}]};
  if(name==='get_equity_orders')return {results:args.order_id?orders.filter(o=>(o as {id:string}).id===args.order_id):orders};
  return {results:[]};
 };
 const sync=()=>createAccountSync(database as Parameters<typeof createAccountSync>[0],{status,readTool} as never,()=>now);
 let syncer=sync();
 await syncer.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,
  [version,strategy,JSON.stringify({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}})]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const core=()=>createAllocationCore(database,()=>now);
 const invested=await core().invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'50',cause:randomUUID()});
 const sends:string[]=[];
 const writer=()=>createOrderWriter(database,{equityOrder:async(stage,_input,_account,refId)=>{sends.push(stage);return stage==='review'?{review:'ok'}:{isError:false,errorCategory:null,data:{order:{id:`rh-${refId}`}}};}},{enabled:()=>true},()=>now);
 /** A queued buy leg for the allocation, as the planner writes it. */
 const queueLeg=async(symbol='VTI')=>{
  const id=randomUUID();
  await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,'subscribe',$11,'buy','queued',$7,$8,$9,$10,$10)`,[id,invested.allocationId,account,strategy,version,invested.transactionId,
   JSON.stringify({symbol,side:'buy',type:'market',dollar_amount:'10.00'}),randomUUID(),createHash('sha256').update(id).digest('hex'),new Date(now).toISOString(),symbol]);
  return id;
 };
 return {get db(){return db;},database,account,invested,core,writer,sends,queueLeg,
  later:(ms:number)=>{now+=ms;},clock:()=>now,setShares:(q:string)=>{shares=q;},setOrders:(o:unknown[])=>{orders=o;},
  resync:async()=>{now+=1000;await syncer.synchronize();},
  /** The process dies: everything in memory is gone; the database survives as written. */
  restart:async(restore=false)=>{
   syncer.cancel();const saved=await db.dumpDataDir('gzip');await db.close();
   db=new PGlite({loadDataDir:saved});await db.waitReady;await (restore?prepareRestoredDatabase(db):migrate(db));syncer=sync();
  },
  close:async()=>{syncer.cancel();await db.close();}};
}

test('cash release and detach wait while a strategy order is queued, sent, or of unknown outcome',async()=>{
 const f=await fixture();try{
  const leg=await f.queueLeg();
  await expect(f.core().releaseCash({allocationId:f.invested.allocationId,amount:'5',cause:randomUUID()})).rejects.toThrow("Wait for this take's orders to finish");
  await expect(f.core().detach({allocationId:f.invested.allocationId,cause:randomUUID()})).rejects.toThrow("Wait for this take's orders to finish");
  await f.db.query(`UPDATE strategy_executions SET status='cancelled',terminal_at=now() WHERE id=$1`,[leg]);
  // Any order of unknown outcome on the account blocks too: it may yet move cash.
  const {intent}=await f.writer().review({accountId:f.account,order:{symbol:'VTI',side:'buy',type:'market',dollar_amount:'1.00'}});
  await f.db.query(`UPDATE order_intents SET status='placement_unknown' WHERE id=$1`,[intent.id]);
  await expect(f.core().releaseCash({allocationId:f.invested.allocationId,amount:'5',cause:randomUUID()})).rejects.toThrow('unknown outcome');
  await f.db.query(`UPDATE order_intents SET status='placed',provider_order_ref='rh-x' WHERE id=$1`,[intent.id]);
  await f.core().releaseCash({allocationId:f.invested.allocationId,amount:'5',cause:randomUUID()});
 }finally{await f.close();}
});

test('a process killed mid-placement never resends: the order is matched on sync and its fill joins the strategy',async()=>{
 const f=await fixture();try{
  const leg=await f.queueLeg();
  // The executor claimed the leg and the writer claimed the intent; then the process died
  // after Robinhood may have received the order, before anything else was recorded.
  const {intent}=await f.writer().review({accountId:f.account,order:{symbol:'VTI',side:'buy',type:'market',dollar_amount:'10.00'},allocationId:f.invested.allocationId,transactionId:f.invested.transactionId});
  await f.db.query(`UPDATE order_intents SET status='placing',updated_at=$2 WHERE id=$1`,[intent.id,new Date(f.clock()).toISOString()]);
  await f.db.query(`UPDATE strategy_executions SET status='submitting',order_intent_id=$2 WHERE id=$1`,[leg,intent.id]);
  await f.restart();
  f.later(6*60_000);
  const writer=f.writer(),executor=createExecutor(f.database,{orderWriter:writer,clock:f.clock});
  await writer.reconcile(f.account,f.clock()-5*60_000);
  expect((await writer.list(f.account))[0]).toMatchObject({status:'placement_unknown',errorCode:'interrupted'});
  // Nothing is placed while the outcome is unknown, not even another queued order.
  await f.queueLeg('SPY');
  const sendsBefore=f.sends.length;
  expect(await executor.executeAllocation(f.invested.allocationId)).toMatchObject({placed:0,parkedReason:'placement_unresolved'});
  expect(f.sends.length).toBe(sendsBefore);
  // Robinhood did receive it: the next sync shows the order with its ref_id, filled.
  const at=new Date(f.clock()).toISOString();
  f.setOrders([{id:'rh-order-7',ref_id:intent.refId,state:'filled',symbol:'VTI',instrument_id:'VTI',side:'buy',quantity:'1',created_at:at,placed_agent:'agentic',
   executions:[{id:'exec-7',quantity:'1',price:'10',timestamp:at}]}]);
  await f.resync();
  expect(await writer.reconcile(f.account,f.clock()-5*60_000)).toBe(1);
  await executor.settleLegs(f.account);
  expect((await f.db.query<{status:string}>(`SELECT status FROM strategy_executions WHERE id=$1`,[leg])).rows[0]!.status).toBe('filled');
  const sweep=createAttributionSweep(f.database,f.core(),fill=>writer.link(fill));
  expect(await sweep.run(f.account)).toMatchObject({completed:1,failed:0});
  expect((await f.db.query(`SELECT quantity_delta::text AS q FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type='fill'`,[f.invested.allocationId])).rows).toEqual([{q:'1.000000000000000000'}]);
  expect(f.sends.filter(s=>s==='place')).toEqual([]);
 }finally{await f.close();}
});

test('a restored backup pauses every strategy until the moved-on account is reviewed and resolved',async()=>{
 const f=await fixture();try{
  // The strategy's shares, attributed before the backup was taken.
  const at=new Date(f.clock()).toISOString();
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','fill-a','equity','filled',true,'{}',$2,$2)`,[f.account,at]);
  await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood','fill-a','fill-a','equity',$2,$3)`,
   [f.account,JSON.stringify({quantity:'5',price:'10',feeAmount:null,notionalAmount:null,side:'buy',instrumentRef:'VTI',symbol:'VTI',origin:'agentic',orderCreatedAt:at,occurredAt:at}),at]);
  await f.core().attribute({accountId:f.account,provider:'robinhood',executionRef:'fill-a'},{instruction:{...f.invested,accountId:f.account,provider:'robinhood',orderRef:'fill-a'}});
  // Restore the backup while the account has since sold down to 2 shares.
  await f.restart(true);
  expect((await f.db.query(`SELECT status,restore_required FROM strategy_allocations`)).rows).toEqual([{status:'paused',restore_required:true}]);
  const resume=createAllocationResume(f.database,f.clock);
  expect(await resume.review(f.invested.allocationId)).toMatchObject({pauseReason:'restored',blockers:['evidence_stale']});
  f.setShares('2');await f.resync();
  const review=await resume.review(f.invested.allocationId);
  expect(review).toMatchObject({ready:false,cases:[{cause:'position_shortfall',claimed:'5',observed:'2'}]});
  await expect(resume.resume(f.invested.allocationId)).rejects.toThrow('Resolve the differences');
  await resume.keepReduced(f.invested.allocationId,review.cases[0]!.id);
  expect(await resume.resume(f.invested.allocationId)).toMatchObject({status:'active',restoreRequired:false,positions:[{symbol:'VTI',claimed:'2'}]});
 }finally{await f.close();}
});

import {sweepStuckLegs} from '../../../src/main/execution/stuck-legs';
test('restart expires a review that never entered placement and releases its leg',async()=>{
 const f=await fixture();try{
 const leg=await f.queueLeg();const {intent}=await f.writer().review({accountId:f.account,allocationId:f.invested.allocationId,transactionId:f.invested.transactionId,order:{symbol:'VTI',side:'buy',type:'market',dollar_amount:'10.00'}});
 await f.db.query("UPDATE strategy_executions SET status='reviewed',order_intent_id=$2 WHERE id=$1",[leg,intent.id]);
 await f.restart();f.later(3*3600000);await f.resync();await f.writer().reconcile(f.account);
 const executor=createExecutor(f.database,{orderWriter:f.writer(),clock:f.clock});await executor.settleLegs(f.account);await sweepStuckLegs(f.database,f.clock);
 expect((await f.db.query('SELECT status FROM order_intents WHERE id=$1',[intent.id])).rows[0]).toEqual({status:'expired'});
 expect((await f.db.query('SELECT status FROM strategy_executions WHERE id=$1',[leg])).rows[0]).toEqual({status:'failed'});
 expect(f.sends).not.toContain('place');
 }finally{await f.close();}
});
test('an investment paused after review cannot place the reviewed order',async()=>{
 const f=await fixture();try{
 const {intent}=await f.writer().review({accountId:f.account,allocationId:f.invested.allocationId,transactionId:f.invested.transactionId,order:{symbol:'VTI',side:'buy',type:'market',dollar_amount:'10.00'}});
 await f.db.query("UPDATE strategy_allocations SET status='paused' WHERE id=$1",[f.invested.allocationId]);
 await expect(f.writer().confirm(intent.id)).rejects.toThrow('no longer eligible');expect(f.sends).not.toContain('place');
 }finally{await f.close();}
});
