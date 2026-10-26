import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createOrderWriter} from '../../../src/main/orders/service';
import {createExecutor,errorCode,buyingPowerShort} from '../../../src/main/execution/executor';

// Monday 2026-10-05: 11:00 Eastern is inside the regular session, 18:00 is not.
const OPEN=Date.parse('2026-10-05T15:00:00Z'),CLOSED=Date.parse('2026-10-05T22:00:00Z');

async function fixture(options:{buyingPower?:string}={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=OPEN;const clock=()=>now;
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1000',cash:'500',buying_power:options.buyingPower??'500'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:'2',mark_price:'250'}]}:{results:[]},
 },clock);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"VTI"},"bps":10000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{}','{}' FROM local_owners`,[version,strategy]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const r=await createAllocationCore(database,clock).invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:randomUUID()});
 // The fake broker: records every call; scripted failures per symbol and stage.
 const calls:{stage:string;symbol:string;side:string}[]=[];
 const fail:Record<string,()=>unknown>={};
 let orders=0;
 const writer=createOrderWriter(database,{equityOrder:async(stage,input)=>{
  const o=input as {symbol:string;side:string};calls.push({stage,symbol:o.symbol,side:o.side});
  const scripted=fail[`${stage}:${o.symbol}`];if(scripted)return scripted();
  return stage==='review'?{review:'ok'}:{isError:false,errorCategory:null,data:{order:{id:`rh-${++orders}`}}};
 }},{enabled:()=>true},clock);
 const executor=createExecutor(database,{orderWriter:writer,clock});
 async function leg(side:'buy'|'sell',symbol:string,order:Record<string,unknown>,createdAt=now){
  const id=randomUUID();
  await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,transaction_id,kind,symbol,side,order_request,idempotency_key,request_hash,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,'rebalance',$7,$8,$9,$10,$11,$12,$12)`,[id,r.allocationId,account,strategy,version,r.transactionId,symbol,side,JSON.stringify({symbol,side,type:'market',...order}),randomUUID(),createHash('sha256').update(id).digest('hex'),new Date(createdAt).toISOString()]);
  return id;
 }
 const legs=async()=>Object.fromEntries((await db.query<{symbol:string;status:string;failure_code:string|null}>('SELECT symbol,status,failure_code FROM strategy_executions')).rows.map(r=>[r.symbol,`${r.status}${r.failure_code?':'+r.failure_code:''}`]));
 const allocation=async()=>(await db.query<{planning_reason_code:string|null;planning_deferred_until:Date|null}>('SELECT planning_reason_code,planning_deferred_until FROM strategy_allocations WHERE id=$1',[r.allocationId])).rows[0]!;
 return {db,account,allocationId:r.allocationId,writer,executor,calls,fail,leg,legs,allocation,set:(ms:number)=>{now=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('sells go out before buys, each reviewed then placed once, and settle to filled from synced orders',async()=>{
 const f=await fixture();try{
  await f.leg('buy','QQQ',{dollar_amount:'10.00'});
  await f.leg('sell','VTI',{quantity:'0.04'});
  expect(await f.executor.executeAllocation(f.allocationId)).toEqual({allocationId:f.allocationId,placed:2,failed:0,parkedReason:null});
  expect(f.calls.map(c=>`${c.stage}:${c.symbol}`)).toEqual(['review:VTI','place:VTI','review:QQQ','place:QQQ']);
  expect(await f.legs()).toEqual({VTI:'submitted',QQQ:'submitted'});
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','rh-1','equity','filled',true,'{}',now(),now()),($1,'robinhood','rh-2','equity','partially_filled',false,'{}',now(),now())`,[f.account]);
  await f.executor.settleLegs(f.account);
  expect(await f.legs()).toEqual({VTI:'filled',QQQ:'partially_filled'});
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({parkedReason:'nothing_queued'});
 }finally{await f.close();}
});

test('confirm-every-trade holds legs planned after the last confirmation until the member confirms',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO trading_preferences(owner_id,confirm_trades,updated_at) SELECT id,true,now() FROM local_owners`);
  await f.leg('buy','QQQ',{dollar_amount:'10.00'});
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({placed:0,parkedReason:'awaiting_confirmation'});
  expect(f.calls).toEqual([]);
  expect((await f.allocation()).planning_reason_code).toBe('awaiting_confirmation');
  expect(await f.executor.executeAllocation(f.allocationId,{confirmed:true})).toMatchObject({placed:1,parkedReason:null});
  expect((await f.allocation()).planning_reason_code).toBeNull();
 }finally{await f.close();}
});

test('outside the session the allocation waits for the open and nothing is sent',async()=>{
 const f=await fixture();try{
  await f.leg('buy','QQQ',{dollar_amount:'10.00'});
  f.set(CLOSED);
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({parkedReason:'market_closed'});
  expect(f.calls).toEqual([]);
  const parked=await f.allocation();
  expect(parked.planning_reason_code).toBe('market_closed');
  expect(new Date(parked.planning_deferred_until!).toISOString()).toBe('2026-10-06T13:30:00.000Z');
 }finally{await f.close();}
});

test('a failed leg stops the batch and parks the allocation; Robinhood refusing is provider_invalid_request',async()=>{
 const f=await fixture();try{
  await f.leg('sell','VTI',{quantity:'0.04'});
  await f.leg('buy','QQQ',{dollar_amount:'10.00'});
  f.fail['review:VTI']=()=>{throw new Error('not tradable');};
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({placed:0,failed:1});
  expect(await f.legs()).toEqual({VTI:'failed:delegated_unknown',QQQ:'queued'});
  expect((await f.allocation()).planning_reason_code).toBe('delegated_unknown');
  const g=await fixture();try{
   await g.leg('buy','QQQ',{dollar_amount:'10.00'});
   g.fail['place:QQQ']=()=>({isError:true,errorCategory:'invalid_request',data:[]});
   expect(await g.executor.executeAllocation(g.allocationId)).toMatchObject({failed:1});
   expect(await g.legs()).toEqual({QQQ:'failed:provider_invalid_request'});
  }finally{await g.close();}
 }finally{await f.close();}
});

test('an unknown placement stops later buys, is never resent, and resolves only through the synced ref_id',async()=>{
 const f=await fixture();try{
  await f.leg('sell','VTI',{quantity:'0.04'});
  await f.leg('buy','QQQ',{dollar_amount:'10.00'});
  f.fail['place:VTI']=()=>{throw new Error('socket hang up');};
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({placed:0,parkedReason:'placement_unresolved'});
  expect(await f.legs()).toEqual({VTI:'placement_unknown:placement_unknown',QQQ:'queued'});
  const before=f.calls.length;
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({parkedReason:'placement_unresolved'});
  expect(f.calls.length).toBe(before);
  // Still unknown an hour later: reconciliation, never a resend.
  f.set(OPEN+61*60_000);await f.executor.settleLegs(f.account);
  expect((await f.legs()).VTI).toBe('reconciliation_required:placement_unknown');
  const intent=(await f.db.query<{ref_id:string}>(`SELECT ref_id FROM order_intents WHERE status='placement_unknown'`)).rows[0]!;
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','rh-9','equity','queued',false,$2,now(),now())`,[f.account,JSON.stringify({clientRef:intent.ref_id})]);
  await f.writer.reconcile(f.account);await f.executor.settleLegs(f.account);
  expect((await f.legs()).VTI).toBe('submitted');
 }finally{await f.close();}
});

test('buys the account cannot fund park the allocation; a blocked ticker’s buy fails while the rest go out',async()=>{
 const f=await fixture({buyingPower:'5'});try{
  await f.leg('buy','QQQ',{dollar_amount:'10.00'});
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({parkedReason:'insufficient_buying_power'});
  expect(f.calls).toEqual([]);
 }finally{await f.close();}
 const g=await fixture();try{
  await g.db.query(`INSERT INTO trading_preferences(owner_id,blocked_symbols,updated_at) SELECT id,'{QQQ}',now() FROM local_owners`);
  await g.leg('buy','QQQ',{dollar_amount:'10.00'});await g.leg('buy','SPY',{dollar_amount:'5.00'});
  expect(await g.executor.executeAllocation(g.allocationId)).toMatchObject({placed:1});
  expect(await g.legs()).toEqual({QQQ:'failed:symbol_blocked',SPY:'submitted'});
 }finally{await g.close();}
});

test('error codes and the buying-power rule follow the hosted helpers',()=>{
 class OrderConflictError extends Error {}
 expect(errorCode(new OrderConflictError('x'))).toBe('order_conflict');
 expect(errorCode(new Error('x'))).toBe('unknown');
 expect(buyingPowerShort(10,'9.99')).toBe(true);
 expect(buyingPowerShort(10,null)).toBe(false);
 expect(buyingPowerShort(0,'0')).toBe(false);
});


test('shared executor parks provider approval without claiming placement or submitting later buys',async()=>{
 const f=await fixture();try{
  await f.leg('sell','VTI',{quantity:'0.04'});await f.leg('buy','QQQ',{dollar_amount:'10'});
  let attempts=0;
  const executor=createExecutor({use:async fn=>fn(f.db)},{clock:()=>OPEN,orderWriter:{review:input=>f.writer.review(input),confirm:async()=>{attempts++;return {status:'approval_pending',placedAt:null};}}});
  expect(await executor.executeAllocation(f.allocationId)).toMatchObject({placed:0,failed:0,parkedReason:'provider_approval_pending'});
  expect(await f.legs()).toEqual({VTI:'placement_unknown:provider_approval_pending',QQQ:'queued'});
  expect(await executor.executeAllocation(f.allocationId)).toMatchObject({placed:0,parkedReason:'placement_unresolved'});expect(attempts).toBe(1);
  await f.db.query(`UPDATE order_intents SET status='rejected',error_code='approval_declined'`);
  await executor.settleLegs(f.account);
  expect(await f.legs()).toEqual({VTI:'failed:approval_declined',QQQ:'queued'});
 }finally{await f.close();}
});

test('crypto-only batches reach review on weekends; mixed batches preserve equity sell dependencies',async()=>{
 for(const mixed of [false,true]){
  const f=await fixture();try{
   await f.leg('buy','BTC-USD',{currency_pair_id:randomUUID(),dollar_amount:'5',time_in_force:'gtc'});
   if(mixed) await f.leg('sell','VTI',{quantity:'0.04'});
   let reviews=0;
   const executor=createExecutor({use:async fn=>fn(f.db)},{clock:()=>Date.parse('2026-10-10T15:00:00Z'),orderWriter:{
    review:async()=>{reviews++;throw new Error('Synthetic stop at review');},
    confirm:async()=>{throw new Error('Must never submit in this calendar test');},
   }});
   const result=await executor.executeAllocation(f.allocationId);
   expect(reviews).toBe(mixed?0:1);
   expect(result).toMatchObject(mixed?{placed:0,parkedReason:'market_closed'}:{placed:0,failed:1});
  }finally{await f.close();}
 }
});

test('crypto sells never borrow a same-ticker equity quote for buying-power estimates',async()=>{
 const f=await fixture({buyingPower:'0'});try{
  await f.leg('sell','VTI',{currency_pair_id:randomUUID(),quantity:'1',time_in_force:'gtc'});
  await f.leg('buy','QQQ',{dollar_amount:'10'});
  await f.db.query(`INSERT INTO market_quotes(symbol,price,observed_at) VALUES('VTI',250,now()) ON CONFLICT(symbol) DO UPDATE SET price=250`);
  expect(await f.executor.executeAllocation(f.allocationId)).toMatchObject({placed:0,parkedReason:'insufficient_buying_power'});
  expect(f.calls).toEqual([]);
 }finally{await f.close();}
});
