import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID, createHash } from 'node:crypto';
import { migrate } from '../../src/main/migrations';
import { createAccountSync } from '../../src/main/account-sync/service';
import { createAllocationCore } from '../../src/main/allocations/service';
import { createNotifications, type NativeAlert } from '../../src/main/notifications';

// Synthetic account and a committed take with $100 invested; legs and closures are written directly.
async function fixture(options:{dividendYields?:(symbols:string[])=>Promise<ReadonlyMap<string,number>>}={}){
 // What the synthetic Robinhood account reports; tests change it between syncs.
 const account$={cash:'500',positions:[] as Record<string,string>[]};
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-10-05T15:00:00Z');const clock=()=>now;
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1000',cash:account$.cash,buying_power:account$.cash}:name==='get_equity_positions'?{results:account$.positions}:{results:[]},
 },clock);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 const spec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:8000}],cashBps:2000},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,$3,$4,'{}','{}' FROM local_owners`,
  [version,strategy,JSON.stringify({title:'Synthetic take',description:'Synthetic'}),JSON.stringify(spec)]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const r=await createAllocationCore(database,clock).invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:randomUUID()});
 const leg=async(status:string,side='buy')=>{const id=randomUUID();const at=new Date(now).toISOString();
  await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at,terminal_at,failure_code)
   VALUES($1,$2,$3,$4,$5,'subscribe','VTI',$6,$7,'{}',$8,$9,$10,$10,$11,$12)`,[id,r.allocationId,account,strategy,r.transactionId,side,status,randomUUID(),createHash('sha256').update(id).digest('hex'),at,
   status==='failed'?at:null,status==='failed'?'provider_invalid_request':null]);return id;};
 const alerts:NativeAlert[]=[];
 const service=createNotifications(database,{now:clock,deliver:a=>alerts.push(a),badge:()=>{},openDesktop:()=>{},dividendYields:options.dividendYields});
 const items=async()=>(await service.list()).items.map(i=>({kind:i.kind,resolved:i.resolvedAt!==null,requiresAction:i.requiresAction,takeEvent:i.takeEvent,title:i.title,body:i.body}));
 return {db,strategy,allocationId:r.allocationId,service,alerts,leg,items,account$,sync,advance:()=>{now+=6000;},close:async()=>{await service.stop();sync.cancel();await db.close();}};
}

test('take events reach the bell once, route to the take, and resolve when they stop being true',async()=>{
 const f=await fixture();try{
  await f.leg('failed');
  const unknown=await f.leg('placement_unknown','sell');
  await f.service.tick();
  let items=await f.items();
  expect(items).toEqual(expect.arrayContaining([
   expect.objectContaining({kind:'holding_not_bought',requiresAction:false,resolved:false,title:'VTI could not be bought',takeEvent:expect.objectContaining({strategyName:'Synthetic take',symbol:'VTI'})}),
   expect.objectContaining({kind:'order_unknown',requiresAction:true,resolved:false,title:'Sell VTI: outcome unknown'}),
  ]));
  const page=await f.service.list();
  // The investment action now has its own attention notice alongside the unknown order.
  expect(page.items.find(i=>i.kind==='action_update')).toMatchObject({requiresAction:true,action:{state:'attention'}});
  expect(page.actionRequiredCount).toBe(2);
  expect(await f.service.target(page.items[0]!.id)).toEqual({type:'strategy',strategyId:f.strategy});
  f.advance();await f.service.tick();
  expect((await f.items()).filter(i=>i.takeEvent)).toHaveLength(2);

  // The member cleared the unknown order; archiving asks to hold or sell.
  await f.db.query(`UPDATE strategy_executions SET status='failed',failure_code='member_abandoned',terminal_at=now() WHERE id=$1`,[unknown]);
  await f.db.query(`UPDATE strategies SET archived_at=now() WHERE id=$1`,[f.strategy]);
  f.advance();await f.service.tick();
  items=await f.items();
  expect(items.find(i=>i.kind==='order_unknown')?.resolved).toBe(true);
  expect(items.find(i=>i.kind==='strategy_archived')).toMatchObject({requiresAction:true,resolved:false,title:'You archived Synthetic take',takeEvent:{allocationId:f.allocationId,detail:'awaiting'}});

  // Decided: the notice resolves and history stays.
  await f.db.query(`UPDATE strategy_allocation_closures SET status='held',updated_at=now() WHERE allocation_id=$1`,[f.allocationId]);
  f.advance();await f.service.tick();
  items=await f.items();
  expect(items.find(i=>i.kind==='strategy_archived')?.resolved).toBe(true);
  expect((await f.service.list()).items.filter(i=>i.takeEvent&&i.requiresAction&&!i.resolvedAt)).toHaveLength(0);
 }finally{await f.close();}
});

test('a close that fails again after a retry is a new notice, not the resolved one',async()=>{
 const f=await fixture();try{
  const fail=async()=>{await f.db.query(`INSERT INTO strategy_allocation_closures(id,allocation_id,reason,status,opened_at,updated_at,failure_code) VALUES($1,$2,'close','failed',now(),clock_timestamp(),'nothing_to_sell')
   ON CONFLICT(allocation_id) DO UPDATE SET status='failed',updated_at=clock_timestamp()`,[randomUUID(),f.allocationId]);};
  await fail();f.advance();await f.service.tick();
  await f.db.query(`UPDATE strategy_allocation_closures SET status='selling',updated_at=clock_timestamp() WHERE allocation_id=$1`,[f.allocationId]);
  f.advance();await f.service.tick();
  await fail();f.advance();await f.service.tick();
  const closes=(await f.items()).filter(i=>i.kind==='close_failed');
  expect(closes.map(i=>i.resolved).sort()).toEqual([false,true]);
 }finally{await f.close();}
});

test('a fill the books cannot match, and account reads that keep failing, reach the bell until they clear',async()=>{
 const f=await fixture();try{
  const caseId=randomUUID();
  const account=(await f.db.query<{account_id:string}>(`SELECT account_id FROM strategy_allocations WHERE id=$1`,[f.allocationId])).rows[0]!.account_id;
  await f.db.query(`INSERT INTO strategy_reconciliation_cases(id,account_id,scope,cause,instrument_ref,impacts,evidence,created_at,updated_at) VALUES($1,$2,'fill:robinhood:x','missing_order_causation','VTI',$3,'{}',now(),now())`,
   [caseId,account,JSON.stringify([{allocationId:f.allocationId,quantity:'0'}])]);
  // Account reads: the last good one two hours back, and the newest failed.
  const run=async(resource:string,state:string,at:string)=>f.db.query(`INSERT INTO account_sync_runs(id,account_id,resource,state,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$5)`,[randomUUID(),account,resource,state,at]);
  await f.db.query(`UPDATE account_sync_runs SET started_at='2026-10-05T12:00:00Z',finished_at='2026-10-05T12:00:00Z' WHERE account_id=$1`,[account]);
  await run('equity_positions','failed','2026-10-05T14:59:00Z');
  await f.service.tick();
  let items=await f.items();
  expect(items.find(i=>i.kind==='missing_evidence')).toMatchObject({requiresAction:true,resolved:false,title:'VTI fill not matched',takeEvent:{symbol:'VTI',strategyName:'Synthetic take'}});
  const stale=(await f.service.list()).items.find(i=>i.kind==='account_data_stale')!;
  expect(stale).toMatchObject({requiresAction:true,resolvedAt:null,title:'Can’t read your Robinhood account'});
  expect(await f.service.target(stale.id)).toMatchObject({type:'connection'});
  // Matched and read again: both clear.
  await f.db.query(`UPDATE strategy_reconciliation_cases SET resolved_at=now(),resolution='evidence_restored' WHERE id=$1`,[caseId]);
  await run('equity_positions','completed','2026-10-05T15:00:00Z');
  f.advance();await f.service.tick();
  items=await f.items();
  expect(items.find(i=>i.kind==='missing_evidence')?.resolved).toBe(true);
  expect((await f.service.list()).items.find(i=>i.kind==='account_data_stale')?.resolvedAt).not.toBeNull();
 }finally{await f.close();}
});

test('shares that appear with no order reach the bell as a probable reinvestment or unexplained, never attributed',async()=>{
 const f=await fixture({dividendYields:async symbols=>new Map(symbols.filter(s=>s==='QDTE').map(s=>[s,30]))});try{
  f.account$.positions=[{instrument_id:'QDTE',symbol:'QDTE',quantity:'2',mark_price:'30'},{instrument_id:'VTI',symbol:'VTI',quantity:'1',mark_price:'300'}];
  f.advance();await f.sync.synchronize();
  // QDTE grew by what the cash fell; VTI grew with no cash change; MSFT is new, so it is not compared.
  f.account$.positions=[{instrument_id:'QDTE',symbol:'QDTE',quantity:'2.01',mark_price:'30'},{instrument_id:'VTI',symbol:'VTI',quantity:'1.5',mark_price:'300'},{instrument_id:'MSFT',symbol:'MSFT',quantity:'1',mark_price:'400'}];
  f.account$.cash='499.70';
  f.advance();await f.sync.synchronize();
  f.advance();await f.service.tick();
  const appeared=(await f.items()).filter(i=>i.kind==='shares_appeared');
  expect(appeared).toEqual(expect.arrayContaining([
   expect.objectContaining({title:'0.01 QDTE appeared with no order',requiresAction:false,resolved:false,body:expect.stringContaining('reinvested dividend (worth $0.30')}),
   expect.objectContaining({title:'0.5 VTI appeared with no order',body:expect.stringContaining('Nothing in your Robinhood orders explains it')}),
  ]));
  expect(appeared).toHaveLength(2);
  // A later read with nothing new keeps the notices: each records the change it saw.
  f.advance();await f.sync.synchronize();f.advance();await f.service.tick();
  expect((await f.items()).filter(i=>i.kind==='shares_appeared'&&!i.resolved)).toHaveLength(2);
 }finally{await f.close();}
});
