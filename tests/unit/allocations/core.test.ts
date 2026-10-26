import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, prepareRestoredDatabase } from '../../../src/main/migrations';
import { createAllocationCore } from '../../../src/main/allocations/service';
import { append } from '../../../src/main/allocations/ledger';
import { setFinancialRetention, pruneFinancialObservations } from '../../../src/main/allocations/retention';
import { createAccountSync } from '../../../src/main/account-sync/service';

async function fixture() {
 let db=new PGlite();await migrate(db);
 let now=Date.parse('2026-10-02T15:00:00Z');
 const database={use:<T>(operation:(db:PGlite)=>Promise<T>)=>operation(db)};
 const core=createAllocationCore(database,()=>now);
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'fixture-account','synthetic',true,true) RETURNING id`,[connection])).rows[0].id;
 let cash='1000',shares='20';
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'synthetic',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash,buying_power:cash}:
   name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 async function request(value='100') {
  const strategy=randomUUID(),version=randomUUID();
  await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $1,$2,id,1,1,'{"name":"Synthetic test basket"}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"VTI"},"bps":10000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{"producer":"test"}','{"fixture":true}' FROM local_owners`,[version,strategy]);
  await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
  return {allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:value,cause:randomUUID()};
 }
 async function fill(options:{ref?:string;side?:string;quantity?:string;price?:string;fee?:string;origin?:string;at?:string;accountId?:string}={}){
  const ref=options.ref??randomUUID(),accountId=options.accountId??account;
  const at=options.at??new Date(now).toISOString();
  const data={quantity:options.quantity??'5',price:options.price??'10',feeAmount:options.fee??null,notionalAmount:null,side:options.side??'buy',instrumentRef:'VTI',symbol:'VTI',origin:options.origin??'agentic',orderCreatedAt:at,occurredAt:at};
  await db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','filled',true,'{}',$3,$3) ON CONFLICT DO NOTHING`,[accountId,ref,at]);
  await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood',$2,$2,'equity',$3,$4)`,[accountId,ref,JSON.stringify(data),at]);
  return {accountId,provider:'robinhood',executionRef:ref};
 }
 const link=(r:Awaited<ReturnType<typeof core.invest>>,executionRef:string)=>({instruction:{...r,accountId:account,provider:'robinhood',orderRef:executionRef}});
 return {get db(){return db;},database,core,account,connection,request,fill,link,
  now:()=>new Date(now).toISOString(),advance:(ms=1000)=>{now+=ms;},
  snapshot:async(values:{cash?:string;shares?:string}={})=>{cash=values.cash??cash;shares=values.shares??shares;now+=1000;await sync.synchronize();},
  restart:async()=>{const saved=await db.dumpDataDir('gzip');await db.close();db=new PGlite({loadDataDir:saved});await db.waitReady;await migrate(db);},
  close:async()=>{sync.cancel();await db.close();}};
}

test('preview writes nothing and simultaneous investments cannot overclaim cash; retries validate their payload',async()=>{
 const f=await fixture();try{
  const a=await f.request('700'),b=await f.request('600');
  expect(await f.core.preview(a)).toMatchObject({canFund:true,availableCash:'1000',hypothetical:{cash:'700',positions:[]}});
  expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
  const results=await Promise.allSettled([f.core.invest(a),f.core.invest(b)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const winner=results[0].status==='fulfilled'?a:b;
  await f.core.invest(winner);
  await expect(f.core.invest({...winner,amount:'1'})).rejects.toThrow('Changed instruction');
  expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toHaveLength(1);
  await f.db.query(`UPDATE strategy_allocations SET status='paused' WHERE id=$1`,[winner.allocationId]);
  expect((await f.core.preview(await f.request('500'))).canFund).toBe(false);
  await expect(f.db.query('DELETE FROM linked_accounts WHERE id=$1',[f.account])).rejects.toThrow();
 }finally{await f.close();}
});

test('fill, fee and completion marker commit together; replay concurrently and after restart adds nothing',async()=>{
 const f=await fixture();try{
  const r=await f.core.invest(await f.request());f.advance();const fill=await f.fill({fee:'0.01'});const link=f.link(r,fill.executionRef);
  await f.db.exec(`CREATE FUNCTION fixture_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$;
   CREATE TRIGGER fixture_interruption BEFORE UPDATE ON account_executions FOR EACH ROW EXECUTE FUNCTION fixture_interrupt();`);
  await expect(f.core.attribute(fill,link)).rejects.toThrow('synthetic interruption');
  expect((await f.core.read(r.allocationId)).holdings).toEqual({cash:'100',positions:[]});
  expect((await f.db.query('SELECT attribution_state FROM account_executions')).rows).toEqual([{attribution_state:'pending'}]);
  await f.db.exec('DROP TRIGGER fixture_interruption ON account_executions;');
  await Promise.all([f.core.attribute(fill,link),f.core.attribute(fill,link)]);
  await f.restart();await f.core.attribute(fill,link);
  const read=await f.core.read(r.allocationId);
  expect(read.holdings).toEqual({cash:'49.99',positions:[{instrumentRef:'VTI',symbol:'VTI',quantity:'5'}]});
  expect(read.pnl.fees).toBe('0.01');expect(read.pnl.realizedNet).toBe('-0.01');
  expect((await f.db.query('SELECT sequence FROM strategy_attribution_entries ORDER BY sequence')).rows).toEqual([{sequence:1},{sequence:2},{sequence:3}]);
  await expect(f.db.exec("UPDATE strategy_attribution_entries SET cash_delta=0")).rejects.toThrow('append-only');
 }finally{await f.close();}
});

test('concurrent contributions serialize sequences and exact decimal releases are idempotent',async()=>{
 const f=await fixture();try{
  const request=await f.request('0.000000000000000001');await f.core.invest(request);
  await Promise.all(['10.123456789012345678','20.000000000000000001'].map(value=>f.core.addCapital({...request,amount:value,cause:randomUUID()})));
  expect((await f.core.read(request.allocationId)).holdings.cash).toBe('30.12345678901234568');
  const release={allocationId:request.allocationId,amount:'0.000000000000000001',cause:randomUUID()};
  await Promise.all([f.core.releaseCash(release),f.core.releaseCash(release)]);
  expect((await f.core.read(request.allocationId)).holdings.cash).toBe('30.123456789012345679');
  expect((await f.db.query('SELECT sequence FROM strategy_attribution_entries ORDER BY sequence')).rows).toEqual([1,2,3,4].map(sequence=>({sequence})));
  await expect(f.core.releaseCash({...release,amount:'1e-18',cause:randomUUID()})).rejects.toThrow('decimal');
 }finally{await f.close();}
});

test('outside buys stay personal and outside sales consume personal shares before overlapping allocations',async()=>{
 const f=await fixture();try{
  const a=await f.core.invest(await f.request()),b=await f.core.invest(await f.request());
  for(const r of [a,b]){f.advance();const fill=await f.fill();await f.core.attribute(fill,f.link(r,fill.executionRef));}
  await f.snapshot({shares:'20',cash:'900'});
  f.advance();const buy=await f.fill({origin:'user',quantity:'2'});await f.core.attribute(buy);
  const personal=await f.fill({origin:'user',side:'sell',quantity:'7'});await f.core.attribute(personal);
  expect(await f.core.cases(f.account)).toHaveLength(0);
  const reaches=await f.fill({origin:'user',side:'sell',quantity:'8'});await f.core.attribute(reaches);
  const c=await f.core.reconcile(f.account,'VTI');expect(c).toMatchObject({observed:'7.000000000000000000',claimed:'10.000000000000000000',difference:'-3.000000000000000000'});
  expect(c!.impacts.map(p=>p.quantity)).toEqual(['1.5','1.5']);
  expect((await f.core.read(a.allocationId)).allocation.status).toBe('diverged');
  await f.core.keepReduced(c!.id);await f.core.keepReduced(c!.id);
  expect((await f.core.read(a.allocationId)).holdings.positions[0].quantity).toBe('3.5');
  expect((await f.core.read(b.allocationId)).holdings.positions[0].quantity).toBe('3.5');
  expect((await f.core.read(a.allocationId)).pnl.realizedNet).toBe('0');
  expect((await f.core.read(a.allocationId)).allocation.status).toBe('active');
 }finally{await f.close();}
});

test('cash case is account scoped, reserves diverged claims, and cash restoration preserves user pause',async()=>{
 const f=await fixture();try{
  const a=await f.core.invest(await f.request('400')),b=await f.core.invest(await f.request('400'));
  await f.db.query("UPDATE strategy_allocations SET status='paused' WHERE id=$1",[a.allocationId]);
  await f.snapshot({cash:'600'});
  const first=await f.core.reconcile(f.account,null),second=await f.core.reconcile(f.account,null);
  expect(second!.id).toBe(first!.id);expect(second!.impacts).toHaveLength(2);
  await expect(f.core.guardSelfDirected({accountId:f.account,side:'buy',amount:'1'})).rejects.toThrow('allocation cash');
  await f.snapshot({cash:'1000'});expect(await f.core.reconcile(f.account,null)).toBeNull();
  expect((await f.core.read(a.allocationId)).allocation.status).toBe('paused');
  expect((await f.core.read(b.allocationId)).allocation.status).toBe('active');
 }finally{await f.close();}
});

test('delayed DRIP uses entitlement observations and historical claims; missing evidence defers without guessing',async()=>{
 const f=await fixture();try{
  const a=await f.core.invest(await f.request()),b=await f.core.invest(await f.request());
  for(const r of [a,b]){f.advance();const fill=await f.fill();await f.core.attribute(fill,f.link(r,fill.executionRef));}
  await f.snapshot({shares:'20'});
  const entitlementAt=f.now(),observationId=(await f.db.query<{id:string}>(`SELECT id FROM account_observations WHERE account_id=$1 AND resource='equity_positions' ORDER BY observed_at DESC LIMIT 1`,[f.account])).rows[0].id;
  f.advance(2*86400000);
  const later=await f.fill({quantity:'5'});await f.core.attribute(later,f.link(a,later.executionRef));
  await f.snapshot({shares:'25'});f.advance();const drip=await f.fill({origin:'drip',quantity:'1'});
  expect(await f.core.attribute(drip)).toBe('deferred');
  expect((await f.core.read(a.allocationId)).holdings.positions[0].quantity).toBe('10');
  expect(await f.core.attribute(drip,{entitlement:{at:entitlementAt,observationId}})).toBe('completed');
  expect((await f.core.read(a.allocationId)).holdings.positions[0].quantity).toBe('10.25');
  expect((await f.core.read(b.allocationId)).holdings.positions[0].quantity).toBe('5.25');
  expect((await f.db.query("SELECT * FROM strategy_evidence_pins WHERE reason='entitlement'")).rows).toHaveLength(2);
  await expect(f.db.query('DELETE FROM account_observations WHERE id=$1',[observationId])).rejects.toThrow();
 }finally{await f.close();}
});

test('lot matching retries unmatched fills, protects claimed lots, and detach releases without broker trades',async()=>{
 const f=await fixture();try{
  const r=await f.core.invest(await f.request());f.advance();const fill=await f.fill();await f.core.attribute(fill,f.link(r,fill.executionRef));
  const input={accountId:f.account,provider:'robinhood',instrumentRef:'VTI',observedAt:f.now(),complete:true as const};
  expect(await f.core.resolveLots({...input,lots:[]})).toEqual({matched:0,unmatched:1});
  const lots=[{openLotId:'lot-a',quantity:'5',unitCost:'10',costBasis:'50',acquiredAt:f.now()}];
  expect(await f.core.resolveLots({...input,lots})).toEqual({matched:1,unmatched:0});
  expect(await f.core.resolveLots({...input,lots})).toEqual({matched:0,unmatched:0});
  const sale={allocationId:r.allocationId,instrumentRef:'VTI',quantity:'2',provider:'robinhood',lots,observedAt:f.now(),complete:true as const};
  expect(await f.core.lotsForSale(sale)).toMatchObject({covered:true,borrowed:'0',taxLots:[{openLotId:'lot-a',quantity:'2'}]});
  await expect(f.core.lotsForSale({...sale,quantity:'6'})).rejects.toThrow('exceeds allocation');
  expect(await f.core.lotsForSale({...sale,lots:[{...lots[0],quantity:'1'},{...lots[0],openLotId:'personal-lot',quantity:'5'}]})).toMatchObject({covered:true,borrowed:'1'});
  await expect(f.core.lotsForSale({...sale,lots:[{...lots[0],selectable:false}]})).rejects.toThrow('not selectable');
  await expect(f.core.guardSelfDirected({accountId:f.account,side:'sell',instrumentRef:'VTI',amount:'1',lotIds:['lot-a']})).rejects.toThrow('Lot belongs');
  const count=(await f.db.query('SELECT * FROM account_orders')).rows.length;
  const detach={allocationId:r.allocationId,cause:'detach-fixture'};await Promise.all([f.core.detach(detach),f.core.detach(detach)]);
  const view=await f.core.read(r.allocationId);expect(view.allocation.status).toBe('detached');expect(view.holdings.cash).toBe('0');expect(view.holdings.positions[0].quantity).toBe('0');expect(view.pnl.realizedNet).toBe('0');
  expect((await f.db.query('SELECT * FROM account_orders')).rows).toHaveLength(count);
  await f.core.guardSelfDirected({accountId:f.account,side:'sell',instrumentRef:'VTI',amount:'1',lotIds:['lot-a']});
 }finally{await f.close();}
});

test('cross-account causation and entry links fail; restore pauses allocations and invalidates freshness',async()=>{
 const f=await fixture();try{
  const request=await f.request(),r=await f.core.invest(request);f.advance();const fill=await f.fill();
  await expect(f.core.attribute(fill,{instruction:{...f.link(r,fill.executionRef).instruction,accountId:randomUUID()}})).rejects.toThrow('crosses account');
  expect((await f.core.read(r.allocationId)).holdings.positions).toHaveLength(0);
  await prepareRestoredDatabase(f.db);
  expect((await f.core.read(r.allocationId)).allocation).toMatchObject({status:'paused',restore_required:true});
  await expect(f.core.detach({allocationId:r.allocationId,cause:'restored'})).rejects.toThrow();
  await expect(f.core.guardSelfDirected({accountId:f.account,side:'buy',amount:'1'})).rejects.toThrow('synchronization');
  expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toHaveLength(1);
 }finally{await f.close();}
});

test('append rejects reused keys with changed evidence and database forbids cross-allocation instructions',async()=>{
 const f=await fixture();try{
  const a=await f.core.invest(await f.request()),b=await f.core.invest(await f.request());
  const write={allocationId:a.allocationId,transactionId:a.transactionId,entryType:'corporate_action' as const,instrumentRef:'fixture',quantityDelta:'1',cause:'same',sourceKind:'fixture',sourceRef:'same',occurredAt:f.now()};
  await f.db.transaction(tx=>append(tx,write,f.now()));
  await expect(f.db.transaction(tx=>append(tx,{...write,quantityDelta:'2'},f.now()))).rejects.toThrow('Changed ledger');
  await expect(f.db.transaction(tx=>append(tx,{...write,cause:'crossed',transactionId:b.transactionId},f.now()))).rejects.toThrow();
 }finally{await f.close();}
});


test('short retention preserves pending DRIP, open allocation history, and explicit evidence pins',async()=>{
 const f=await fixture();try{
  await setFinancialRetention(f.db,1);
  for(let i=0;i<3;i++){f.advance(86400000);await f.snapshot({shares:String(20+i)});}
  const entitlementAt=f.now(),observationId=(await f.db.query<{id:string}>(`SELECT id FROM account_observations WHERE resource='equity_positions' ORDER BY observed_at DESC LIMIT 1`)).rows[0].id;
  f.advance(3*86400000);const drip=await f.fill({origin:'drip'});
  const before=(await f.db.query('SELECT id FROM account_observations')).rows.length;
  expect(await pruneFinancialObservations(f.db,Date.parse(f.now()))).toEqual({observations:0});
  await f.core.attribute(drip,{entitlement:{at:entitlementAt,observationId}});
  expect((await pruneFinancialObservations(f.db,Date.parse(f.now()))).observations).toBeGreaterThan(0);
  expect((await f.db.query('SELECT id FROM account_observations')).rows.length).toBeLessThan(before);
  await f.snapshot();const a=await f.core.invest(await f.request());
  for(let i=0;i<3;i++){f.advance(86400000);await f.snapshot();}
  const openCount=(await f.db.query('SELECT id FROM account_observations')).rows.length;
  const pruned=await pruneFinancialObservations(f.db,Date.parse(f.now()));
  expect(pruned.observations).toBe(3); // Only history older than the allocation's inception.
  expect((await f.db.query('SELECT id FROM account_observations')).rows).toHaveLength(openCount-3);
  expect((await f.core.read(a.allocationId)).holdings.cash).toBe('100');
  await setFinancialRetention(f.db,null);
  f.advance(86400000*365);expect((await pruneFinancialObservations(f.db,Date.parse(f.now()))).observations).toBe(0);
 }finally{await f.close();}
});

test('a restored account and stale evidence cannot create a new claim',async()=>{
 const f=await fixture();try{
  const request=await f.request();f.advance(16*60000);
  await expect(f.core.invest(request)).rejects.toThrow('Fresh account observation');
  expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
  await f.snapshot();await prepareRestoredDatabase(f.db);
  await expect(f.core.invest(request)).rejects.toThrow('Eligible account');
 }finally{await f.close();}
});

test('complete lot evidence assigns an outside loss to its allocation and small measured gaps settle once',async()=>{
 const f=await fixture();try{
  const a=await f.core.invest(await f.request()),b=await f.core.invest(await f.request());
  for(const r of [a,b]){f.advance();const fill=await f.fill();await f.core.attribute(fill,f.link(r,fill.executionRef));}
  const lots=[{openLotId:'lot-a',quantity:'5',unitCost:'10',costBasis:'50',acquiredAt:f.now()},
   {openLotId:'lot-b',quantity:'5',unitCost:'10',costBasis:'50',acquiredAt:f.now()}];
  await f.core.resolveLots({accountId:f.account,provider:'robinhood',instrumentRef:'VTI',lots,observedAt:f.now(),complete:true});
  await f.snapshot({shares:'7',cash:'900'});
  const evidence={accountId:f.account,provider:'robinhood',instrumentRef:'VTI',complete:true as const,observedAt:f.now(),lots:[{openLotId:'lot-a',quantity:'2'},{openLotId:'lot-b',quantity:'5'}]};
  const c=await f.core.reconcile(f.account,'VTI',evidence);
  expect(c!.evidence.assignment).toBe('observed_lot_loss');
  await f.core.keepReduced(c!.id,evidence);
  expect((await f.core.read(a.allocationId)).holdings.positions[0].quantity).toBe('2');
  expect((await f.core.read(b.allocationId)).holdings.positions[0].quantity).toBe('5');
  await f.snapshot({shares:'6.95'});
  expect(await f.core.reconcile(f.account,'VTI')).toBeNull();
  const after=(await f.db.query("SELECT * FROM strategy_attribution_entries WHERE entry_type='external_adjustment'")).rows;
  expect(after).toHaveLength(3);
  await f.core.reconcile(f.account,'VTI');
  expect((await f.db.query("SELECT * FROM strategy_attribution_entries WHERE entry_type='external_adjustment'")).rows).toHaveLength(3);
 }finally{await f.close();}
});


test('fills predating every local allocation complete with an explicit no-allocation decision',async()=>{
 const f=await fixture();try{
  const fill=await f.fill({origin:'agentic'});
  f.advance();const a=await f.core.invest(await f.request());
  expect(await f.core.attribute(fill)).toBe('completed');
  expect((await f.core.read(a.allocationId)).holdings).toEqual({cash:'100',positions:[]});
  expect(await f.core.cases(f.account)).toHaveLength(0);
 }finally{await f.close();}
});
