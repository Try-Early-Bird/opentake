import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {isStaleQueuedLeg,sweepStuckLegs} from '../../../src/main/execution/stuck-legs';

// Stuck legs on synthetic data: a leg planned and never placed is cancelled
// after 90 regular-session minutes; anything that may have reached Robinhood,
// or that waits for the member's confirmation, is left alone.
// Monday 2026-10-05, 10:00 Eastern: the regular session is open.
const session=Date.parse('2026-10-05T14:00:00Z');

async function fixture(){
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=session;
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:'20',mark_price:'10'}]}:{results:[]},
 } as never,()=>now);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,
  [version,strategy,JSON.stringify({schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}})]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const invested=await createAllocationCore(database,()=>now).invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'50',cause:randomUUID()});
 const queueLeg=async(createdAt:number,symbol='VTI')=>{
  const id=randomUUID();
  await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,'subscribe',$11,'buy','queued',$7,$8,$9,$10,$10)`,[id,invested.allocationId,account,strategy,version,invested.transactionId,
   JSON.stringify({symbol,side:'buy',type:'market',dollar_amount:'10.00'}),randomUUID(),createHash('sha256').update(id).digest('hex'),new Date(createdAt).toISOString(),symbol]);
  return id;
 };
 const status=async(id:string)=>(await db.query<{status:string;failure_code:string|null}>(`SELECT status,failure_code FROM strategy_executions WHERE id=$1`,[id])).rows[0];
 return {db,database,allocationId:invested.allocationId,queueLeg,status,clock:()=>now,at:(ms:number)=>{now=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('staleness counts only minutes the market was open',()=>{
 // Queued Friday evening: by Monday 9:45 Eastern only 15 session minutes have passed.
 expect(isStaleQueuedLeg('2026-10-02T23:00:00Z',Date.parse('2026-10-05T13:45:00Z'))).toBe(false);
 expect(isStaleQueuedLeg('2026-10-02T23:00:00Z',Date.parse('2026-10-05T15:00:00Z'))).toBe(true);
});

test('a leg never placed for 90 market minutes is cancelled and its allocation planned again',async()=>{
 const f=await fixture();try{
  const leg=await f.queueLeg(session);
  await f.db.query(`UPDATE strategy_allocations SET planning_reason_code='retry_backoff',planning_deferred_until=$2 WHERE id=$1`,[f.allocationId,new Date(session+86_400_000).toISOString()]);
  f.at(session+89*60_000);
  expect(await sweepStuckLegs(f.database,f.clock)).toMatchObject({cancelled:0});
  f.at(session+91*60_000);
  expect(await sweepStuckLegs(f.database,f.clock)).toEqual({cancelled:1,allocations:[f.allocationId],awaitingProvider:0});
  expect(await f.status(leg)).toEqual({status:'cancelled',failure_code:'stale_plan'});
  expect((await f.db.query(`SELECT planning_reason_code,planning_deferred_until FROM strategy_allocations WHERE id=$1`,[f.allocationId])).rows).toEqual([{planning_reason_code:null,planning_deferred_until:null}]);
 }finally{await f.close();}
});

test('a leg that may have reached Robinhood, or waits for the member, is never swept',async()=>{
 const f=await fixture();try{
  // Handed to the order writer, outcome unknown: counted, not cancelled.
  const sent=await f.queueLeg(session);
  const intent=randomUUID();
  await f.db.query(`INSERT INTO order_intents(id,account_id,asset_class,status,ref_id,order_request,review_result,reviewed_at,expires_at,updated_at)
   SELECT $1,account_id,'equity','placement_unknown',$2,'{}','{}',$3,$3,$3 FROM strategy_executions WHERE id=$4`,[intent,randomUUID(),new Date(session).toISOString(),sent]);
  await f.db.query(`UPDATE strategy_executions SET status='placement_unknown',order_intent_id=$2 WHERE id=$1`,[sent,intent]);
  // Held because the member confirms every trade.
  const held=await f.queueLeg(session,'SPY');
  await f.db.query(`UPDATE strategy_allocations SET planning_reason_code='awaiting_confirmation' WHERE id=$1`,[f.allocationId]);
  f.at(session+3*60*60_000);
  expect(await sweepStuckLegs(f.database,f.clock)).toEqual({cancelled:0,allocations:[],awaitingProvider:1});
  expect((await f.status(sent)).status).toBe('placement_unknown');
  expect((await f.status(held)).status).toBe('queued');
 }finally{await f.close();}
});

test('crypto-only queued work ages continuously over weekends while equity work waits',()=>{
 const saturday='2026-10-17T12:00:00Z',later=Date.parse('2026-10-17T14:00:00Z');
 expect(isStaleQueuedLeg(saturday,later,true)).toBe(true);
 expect(isStaleQueuedLeg(saturday,later)).toBe(false);
 expect(isStaleQueuedLeg(saturday,Date.parse(saturday)+89*60000,true)).toBe(false);
});
