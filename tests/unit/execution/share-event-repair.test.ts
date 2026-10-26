import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createAllocationResume} from '../../../src/main/allocations/resume';
import {createShareEventTracker,heldSymbols,splitQuantityDelta} from '../../../src/main/execution/share-event-repair';
import {parseRead} from '../../../src/main/opentake-mcp/catalog';

// Splits on synthetic data, with the member in the operator's place. An allocation bought 5 VTI on Sep 28; Robinhood's
// raw and split-adjusted closes then show an event on Oct 1.
const monday=Date.parse('2026-10-05T14:00:00Z');
const days=['2026-09-29','2026-09-30','2026-10-01','2026-10-02'];

async function fixture(raw:string[],adjusted:string[]){
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-09-28T15:00:00Z');
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
 const core=createAllocationCore(database,()=>now);
 const invested=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'50',cause:randomUUID()});
 const at='2026-09-28T15:00:00.000Z';
 await db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','fill-1','equity','filled',true,'{}',$2,$2)`,[account,at]);
 await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood','fill-1','fill-1','equity',$2,$3)`,
  [account,JSON.stringify({quantity:'5',price:'10',feeAmount:null,notionalAmount:null,side:'buy',instrumentRef:'VTI',symbol:'VTI',origin:'agentic',orderCreatedAt:at,occurredAt:at}),at]);
 await core.attribute({accountId:account,provider:'robinhood',executionRef:'fill-1'},{instruction:{...invested,accountId:account,provider:'robinhood',orderRef:'fill-1'}});
 await db.query(`UPDATE strategy_allocations SET status='active' WHERE id=$1`,[invested.allocationId]);
 now=monday;
 await db.query(`INSERT INTO market_daily_closes(symbol,day,close,observed_at) VALUES('VTI','2026-09-29',100,now())`);
 const reads:string[]=[];
 const readTool=async(name:string,args:Record<string,unknown>)=>{
  // The real read allowlist the connection applies: what the tracker sends must pass it.
  parseRead(name,args,true);
  reads.push(String(args.adjustment_type));
  const closes=args.adjustment_type==='none'?raw:adjusted;
  return {results:(args.symbols as string[]).map(symbol=>({symbol,bars:days.map((d,i)=>({begins_at:`${d}T00:00:00Z`,open_price:closes[i],high_price:closes[i],low_price:closes[i],close_price:closes[i],volume:'1',session:'reg'}))}))};
 };
 const tracker=createShareEventTracker(database,readTool,()=>now);
 const shares=async()=>(await db.query<{q:string}>(`SELECT sum(quantity_delta)::text AS q FROM strategy_attribution_entries WHERE allocation_id=$1 AND symbol='VTI'`,[invested.allocationId])).rows[0]!.q;
 const allocation=async()=>(await db.query<{status:string;planning_reason_code:string|null}>(`SELECT status,planning_reason_code FROM strategy_allocations WHERE id=$1`,[invested.allocationId])).rows[0];
 return {db,database,tracker,reads,shares,allocation,allocationId:invested.allocationId,clock:()=>now,close:async()=>{sync.cancel();await db.close();}};
}

test('splitQuantityDelta: forward and reverse splits restate the share count',()=>{
 expect(splitQuantityDelta('5',{splitTo:2,splitFrom:1})).toBe('5');
 expect(splitQuantityDelta('5',{splitTo:1,splitFrom:10})).toBe('-4.5');
});

test('a forward split restates the strategy’s shares at once, keeps its cost, and purges stored closes',async()=>{
 const f=await fixture(['100','100','50','51'],['50','50','50','51']);try{
  const events=await f.tracker.check();
  expect(events).toMatchObject([{symbol:'VTI',effectiveOn:'2026-10-01',kind:'split',status:'applied',splitTo:2,splitFrom:1}]);
  expect(Number(await f.shares())).toBe(10);
  expect((await f.db.query(`SELECT entry_type,metadata->>'attributedBefore' AS before FROM strategy_attribution_entries WHERE entry_type='corporate_action'`)).rows).toEqual([{entry_type:'corporate_action',before:'5.000000000000000000'}]);
  expect((await f.db.query(`SELECT 1 FROM market_daily_closes WHERE symbol='VTI'`)).rows).toEqual([]);
  expect(await f.allocation()).toEqual({status:'active',planning_reason_code:null});
  // Read once a day: a second call the same day does nothing.
  const before=f.reads.length;
  expect(await f.tracker.check()).toEqual([]);
  expect(f.reads.length).toBe(before);
 }finally{await f.close();}
});

test('a reverse split pauses the strategy until the member applies it after checking Robinhood',async()=>{
 const f=await fixture(['10','10','100','101'],['100','100','100','101']);try{
  const [event]=await f.tracker.check();
  expect(event).toMatchObject({kind:'split',status:'pending_review',splitTo:1,splitFrom:10});
  expect(await f.allocation()).toEqual({status:'paused',planning_reason_code:'share_event'});
  const resume=createAllocationResume(f.database,f.clock);
  const review=await resume.review(f.allocationId);
  expect(review.blockers).toContain('share_event_pending');
  expect(review).toMatchObject({pauseReason:'share_event',ready:false,shareEvents:[{id:event!.id,symbol:'VTI',splitTo:1,splitFrom:10}]});
  await expect(resume.resume(f.allocationId)).rejects.toThrow();
  await f.tracker.decide(event!.id,'apply');
  expect(Number(await f.shares())).toBe(0.5);
  expect(await f.allocation()).toEqual({status:'active',planning_reason_code:null});
  await expect(f.tracker.decide(event!.id,'dismiss')).rejects.toThrow('already decided');
 }finally{await f.close();}
});

test('a step that is not a simple split can only be dismissed, which leaves the shares as they were',async()=>{
 // A spin-off-like step (about 1.049): not a simple fraction.
 const f=await fixture(['100','100','95.36','96'],['100','100','100','100.67']);try{
  const [event]=await f.tracker.check();
  expect(event).toMatchObject({kind:'unclassified',status:'pending_review',splitTo:null});
  await expect(f.tracker.decide(event!.id,'apply')).rejects.toThrow('not a split');
  await f.tracker.decide(event!.id,'dismiss');
  expect(Number(await f.shares())).toBe(5);
  expect(await f.allocation()).toEqual({status:'active',planning_reason_code:null});
 }finally{await f.close();}
});

test('a newest bar that moves like an unadjusted split holds planning for that symbol',async()=>{
 const f=await fixture(['100','100','100','40'],['100','100','100','40']);try{
  expect(await f.tracker.check()).toEqual([]);
  expect([...await f.database.use(db=>heldSymbols(db))]).toEqual(['VTI']);
  expect(Number(await f.shares())).toBe(5);
 }finally{await f.close();}
});

test('a failed queued read holds planning and is retried ten minutes later',async()=>{
 const f=await fixture(['100','100','100','101'],['100','100','100','101']);try{
  const {ConnectionFailure}=await import('../../../src/main/connection-errors');
  let now=monday,calls=0,mode:'down'|'up'='up';
  const readTool=async(name:string,args:Record<string,unknown>)=>{
   calls++;
   if(mode==='down')throw new Error('offline');
   return {results:(args.symbols as string[]).map(symbol=>({symbol,bars:days.map(d=>({begins_at:`${d}T00:00:00Z`,open_price:'100',high_price:'100',low_price:'100',close_price:'100',volume:'1',session:'reg'}))}))};
  };
  // A queued read completes with nothing held.
  expect(await createShareEventTracker(f.database,readTool,()=>now).check()).toEqual([]);
  expect([...await f.database.use(db=>heldSymbols(db))]).toEqual([]);
  // The next day Robinhood is unreachable: planning holds, and the same tracker retries only after ten minutes.
  now=monday+86_400_000;mode='down';
  const tracker=createShareEventTracker(f.database,readTool,()=>now);
  await tracker.check();
  expect([...await f.database.use(db=>heldSymbols(db))]).toEqual(['VTI']);
  const after=calls;
  now+=5*60_000;await tracker.check();
  expect(calls).toBe(after);
  mode='up';now+=6*60_000;await tracker.check();
  expect([...await f.database.use(db=>heldSymbols(db))]).toEqual([]);
 }finally{await f.close();}
});
