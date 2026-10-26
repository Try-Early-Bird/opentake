import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAttributionSweep} from '../../../src/main/allocations/attribution-sweep';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {append,instruction} from '../../../src/main/allocations/ledger';

async function fixture(){
 const db=new PGlite();await migrate(db);
 let now=Date.parse('2026-10-02T15:00:00Z'),shares='20';
 const database={use:<T>(operation:(db:PGlite)=>Promise<T>)=>operation(db)};
 const core=createAllocationCore(database,()=>now);
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'fixture-account','synthetic',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'synthetic',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:
   name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 async function invest(){
  const strategy=randomUUID(),version=randomUUID();
  await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $1,$2,id,1,1,'{"name":"Synthetic test basket"}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"VTI"},"bps":10000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{"producer":"test"}','{"fixture":true}' FROM local_owners`,[version,strategy]);
  await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
  return core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:randomUUID()});
 }
 async function fill(origin:string,side='buy'){
  const ref=randomUUID(),at=new Date(now).toISOString();
  const data={quantity:'5',price:'10',feeAmount:null,notionalAmount:null,side,instrumentRef:'VTI',symbol:'VTI',origin,orderCreatedAt:at,occurredAt:at};
  await db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','filled',true,'{}',$3,$3)`,[account,ref,at]);
  await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood',$2,$2,'equity',$3,$4)`,[account,ref,JSON.stringify(data),at]);
  return ref;
 }
 const states=async()=>(await db.query<{provider_ref:string;attribution_state:string}>(`SELECT provider_ref,attribution_state FROM account_executions`)).rows;
 return {db,core,account,invest,fill,states,sync,at:(iso:string)=>{now=Date.parse(iso);},setShares:(q:string)=>{shares=q;},advance:(ms=1000)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('history before any allocation and the member’s own buys complete; nothing is left pending',async()=>{
 const f=await fixture();try{
  const old=await f.fill('agentic');f.advance();
  await f.invest();f.advance();
  const mine=await f.fill('user');
  const sweep=createAttributionSweep({use:fn=>fn(f.db)},f.core);
  expect(await sweep.run(f.account)).toEqual({completed:2,deferred:0,failed:0});
  expect(Object.fromEntries((await f.states()).map(r=>[r.provider_ref,r.attribution_state]))).toEqual({[old]:'completed',[mine]:'completed'});
  // Settled fills are not revisited.
  expect(await sweep.run(f.account)).toEqual({completed:0,deferred:0,failed:0});
 }finally{await f.close();}
});

test('an agentic fill from another app defers with a case, and a linked fill joins its allocation',async()=>{
 const f=await fixture();try{
  const r=await f.invest();f.advance();
  const foreign=await f.fill('agentic');f.advance();
  const ours=await f.fill('agentic');
  const sweep=createAttributionSweep({use:fn=>fn(f.db)},f.core,async fill=>fill.executionRef===ours?{instruction:{...r,accountId:f.account,provider:'robinhood',orderRef:fill.orderRef}}:undefined);
  expect(await sweep.run(f.account)).toEqual({completed:1,deferred:1,failed:0});
  expect(Object.fromEntries((await f.states()).map(row=>[row.provider_ref,row.attribution_state]))).toEqual({[foreign]:'deferred',[ours]:'completed'});
  expect((await f.core.cases(f.account)).map(c=>(c as {cause:string}).cause)).toContain('missing_order_causation');
  expect((await f.db.query(`SELECT quantity_delta::text AS q FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type='fill'`,[r.allocationId])).rows).toEqual([{q:'5.000000000000000000'}]);
 }finally{await f.close();}
});

test('a fill that cannot be settled stops the sweep so later fills keep their order',async()=>{
 const f=await fixture();try{
  await f.invest();f.advance();
  await f.fill('user');f.advance();await f.fill('user');
  let calls=0;
  const sweep=createAttributionSweep({use:fn=>fn(f.db)},{attribute:async()=>{calls++;throw new Error('boom');}});
  expect(await sweep.run(f.account)).toEqual({completed:0,deferred:0,failed:1});
  expect(calls).toBe(1);
  expect((await f.states()).every(r=>r.attribution_state==='pending')).toBe(true);
 }finally{await f.close();}
});

test('a dividend reinvestment is split by holdings when Robinhood created the order, not when it filled a weekend later (hosted entitlement time)',async()=>{
 const f=await fixture();try{
  const {allocationId}=await f.invest();
  // The take holds 5 of the account's 20 VTI; the member holds the other 15.
  await f.db.transaction(async tx=>{const at=new Date(Date.parse('2026-10-02T15:30:00Z')).toISOString();const t=await instruction(tx,{allocationId,kind:'rebalance',cause:'take-buy'},at);
   await append(tx,{allocationId,transactionId:t,entryType:'fill',instrumentRef:'VTI',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',cause:'take-buy',sourceKind:'provider_execution',sourceRef:'take-buy',occurredAt:at},at);});
  f.at('2026-10-02T23:00:00Z');await f.sync.synchronize();
  // Friday night Robinhood creates the reinvestment order; Monday the member sells their 15 before it fills.
  f.at('2026-10-05T13:31:00Z');const sold=await f.fill('user','sell');
  await f.db.query(`UPDATE account_executions SET data=data||'{"quantity":"15"}' WHERE provider_ref=$1`,[sold]);
  f.setShares('5');f.at('2026-10-05T13:35:00Z');await f.sync.synchronize();
  f.at('2026-10-05T13:46:00Z');
  const ref=randomUUID(),at=new Date(Date.parse('2026-10-05T13:46:00Z')).toISOString();
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','filled',true,$3,$4,$4)`,
   [f.account,ref,JSON.stringify({origin:'drip',sourceCreatedAt:'2026-10-03T00:53:00Z'}),at]);
  await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood',$2,$2,'equity',$3,$4)`,
   [f.account,ref,JSON.stringify({quantity:'0.4',price:'10',feeAmount:null,notionalAmount:null,side:'buy',instrumentRef:'VTI',symbol:'VTI',origin:'drip',occurredAt:at}),at]);
  f.advance();await createAttributionSweep({use:fn=>fn(f.db)},f.core).run(f.account);
  const credited=(await f.db.query<{q:string;entitledAt:string}>(`SELECT quantity_delta::numeric(20,6)::text q,metadata->>'entitlementAt' AS "entitledAt" FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type='reinvestment'`,[allocationId])).rows;
  expect(credited).toEqual([{q:'0.100000',entitledAt:'2026-10-03T00:53:00.000Z'}]);
 }finally{await f.close();}
});
