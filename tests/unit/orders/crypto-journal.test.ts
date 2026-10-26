import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate,migrations} from '../../../src/main/migrations';
import {createCryptoOrderJournal} from '../../../src/main/orders/crypto-journal';
import {createOrderWriter} from '../../../src/main/orders/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createAllocationCore} from '../../../src/main/allocations/service';

async function fixture(migrationLimit=Infinity,initialTime=Date.parse('2026-10-15T14:00:00Z')){
 let db=new PGlite();await migrate(db,migrations.filter(m=>m.version<=migrationLimit));let at=initialTime,cash='100';
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'fake','fake',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fake',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:cash,cash,buying_power:cash}:{results:[]},
 },()=>at);await sync.synchronize();
 const journal=createCryptoOrderJournal(database,()=>at),core=createAllocationCore(database,()=>at);
 const review=(maximumDebit='60')=>journal.review({accountId:account,order:{currency_pair_id:'btc-pair',type:'limit',side:'buy',dollar_amount:maximumDebit,limit_price:'50000'},maximumDebit,review:{synthetic:true}});
 const held=async()=>(await db.query<{amount:string;state:string}>('SELECT amount::text,state FROM order_cash_holds ORDER BY created_at')).rows;
 async function request(value:string){
  const strategy=randomUUID(),version=randomUUID();
  await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $1,$2,id,1,1,'{"name":"Synthetic"}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"VTI"},"bps":10000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{}','{}' FROM local_owners`,[version,strategy]);
  await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
  return {allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:value,cause:randomUUID()};
 }
 return {get db(){return db;},database,account,journal,core,request,review,held,sync,setCash:(value:string)=>{cash=value;},clock:()=>at,setTime:(value:number)=>{at=value;},later:()=>{at+=121000;},restart:async()=>{const dump=await db.dumpDataDir('gzip');await db.close();db=new PGlite({loadDataDir:dump});await db.waitReady;},close:async()=>{sync.cancel();await db.close();}};
}
const authorize=async()=>{};
test('simultaneous crypto claims reserve shared cash once and failed claim leaves no partial write',async()=>{
 const f=await fixture();try{
  const a=await f.review(),b=await f.review();
  const results=await Promise.allSettled([f.journal.claim(a.id,authorize),f.journal.claim(b.id,authorize)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.held()).toHaveLength(1);
  const states=[(await f.journal.get(a.id)).status,(await f.journal.get(b.id)).status].sort();expect(states).toEqual(['placing','reviewed']);
  const winner=results[0].status==='fulfilled'?a:b;await expect(f.journal.claim(winner.id,authorize)).rejects.toThrow('already attempted');
 }finally{await f.close();}
});
test('approval and uncertain holds survive restart; acceptance and cancellation do not release cash',async()=>{
 const f=await fixture();try{
  const a=await f.review('30'),b=await f.review('30');await f.journal.claim(a.id,authorize);await f.journal.claim(b.id,authorize);
  await f.journal.record(a.id,{state:'approval_pending',approvalRef:'approval-1'});
  await f.restart();await f.journal.recoverInterrupted();
  expect((await f.journal.get(a.id)).status).toBe('approval_pending');expect((await f.journal.get(b.id)).status).toBe('placement_unknown');
  expect((await f.held()).every(h=>h.state==='held')).toBe(true);
  await f.journal.record(b.id,{state:'accepted',providerRef:'crypto-order'});
  await expect(f.journal.record(b.id,{state:'rejected',code:'late_failure'})).rejects.toThrow('conflicts');
  expect((await f.held()).every(h=>h.state==='held')).toBe(true);
 }finally{await f.close();}
});
test('definitive rejection releases a hold atomically',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'rejected',code:'provider_invalid_request'});
  expect((await f.journal.get(a.id)).status).toBe('rejected');expect((await f.held())[0].state).toBe('released');
  const b=await f.review('100');await f.journal.claim(b.id,authorize);
 }finally{await f.close();}
});
test('expired reviews, revoked accounts and failed authorization do not reserve or claim',async()=>{
 const f=await fixture();try{
  const a=await f.review();await expect(f.journal.claim(a.id,async()=>{throw Error('Trading disabled');})).rejects.toThrow('disabled');
  await f.db.query('UPDATE linked_accounts SET selected=false WHERE id=$1',[f.account]);
  await expect(f.journal.claim(a.id,authorize)).rejects.toThrow('no longer available');
  f.later();await expect(f.journal.claim(a.id,authorize)).rejects.toThrow('expired');
  expect(await f.held()).toEqual([]);expect((await f.journal.get(a.id)).status).toBe('reviewed');
 }finally{await f.close();}
});
test('personal holds reduce new Take funding; existing Take claims cannot be spent by crypto',async()=>{
 const f=await fixture();try{
  const a=await f.review('60');await f.journal.claim(a.id,authorize);
  const r=await f.request('50');expect(await f.core.preview(r)).toMatchObject({availableCash:'40',canFund:false});
  await expect(f.core.invest(r)).rejects.toThrow('Insufficient');
  await f.journal.record(a.id,{state:'rejected'});await f.core.invest(r);
  const b=await f.review('60');await expect(f.journal.claim(b.id,authorize)).rejects.toThrow('Insufficient');
 }finally{await f.close();}
});
test('Take holds use already-claimed USD without counting that cash twice',async()=>{
 const f=await fixture();try{
  const r=await f.request('70'),investment=await f.core.invest(r);
  const a=await f.journal.review({accountId:f.account,...investment,order:{currency_pair_id:'btc-pair',type:'limit',side:'buy',quantity:'0.001',limit_price:'50000'},maximumDebit:'60',review:{}});
  await f.journal.claim(a.id,authorize);
  await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  expect(await f.core.preview(await f.request('30'))).toMatchObject({availableCash:'30',canFund:true});
  await expect(f.core.releaseCash({allocationId:r.allocationId,amount:'1',cause:'release'})).rejects.toThrow('reserved');
  const b=await f.journal.review({accountId:f.account,...investment,order:{...a.order_request,quantity:'0.0002'},maximumDebit:'11',review:{}});
  await expect(f.journal.claim(b.id,authorize)).rejects.toThrow('Insufficient');
 }finally{await f.close();}
});
test('equity and crypto submission guards work in both directions; legacy listing excludes crypto',async()=>{
 const f=await fixture();try{
  let sent=0;const writer=createOrderWriter(f.database,{equityOrder:async(stage)=>{if(stage==='place')sent++;return {isError:false,errorCategory:null,data:{order:{id:'equity-order'}}};}},{enabled:()=>true});
  const a=await f.review();await f.journal.claim(a.id,authorize);
  const equity=await writer.review({accountId:f.account,order:{symbol:'VTI',side:'buy',type:'market',dollar_amount:'1'}});
  await expect(writer.confirm(equity.intent.id)).rejects.toThrow();expect(sent).toBe(0);
  expect(await writer.list(f.account)).toHaveLength(1);await expect(writer.get(a.id)).rejects.toThrow('not found');
  await f.journal.record(a.id,{state:'rejected'});await writer.confirm(equity.intent.id);expect(sent).toBe(1);
  const b=await f.review();await expect(f.journal.claim(b.id,authorize)).rejects.toThrow('equity submission');
 }finally{await f.close();}
});
test('version 73 upgrade preserves existing intents and does not rewrite migration history',async()=>{
 const db=new PGlite();try{
  await migrate(db,migrations.filter(m=>m.version<=72));
  await db.exec(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners;
   INSERT INTO linked_accounts(connection_id,external_ref,masked_number) SELECT id,'fake','fake' FROM platform_connections;
   INSERT INTO order_intents(id,account_id,asset_class,status,ref_id,order_request,reviewed_at,expires_at,updated_at)
   SELECT gen_random_uuid(),id,'equity','reviewed',gen_random_uuid(),'{"symbol":"VTI"}',now(),now()+interval '2 minutes',now() FROM linked_accounts;`);
  const intent=(await db.query('SELECT id,order_request,status,ref_id FROM order_intents')).rows;
  const old=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await migrate(db);expect((await db.query('SELECT * FROM app_migrations WHERE version<=72 ORDER BY version')).rows).toEqual(old);
  expect((await db.query('SELECT * FROM order_cash_holds')).rows).toEqual([]);
  expect((await db.query('SELECT id,order_request,status,ref_id FROM order_intents')).rows).toEqual(intent);
  await migrate(db);
 }finally{await db.close();}
});

test('review rejects an understated debit and expiry during authorization rolls back the claim',async()=>{
 const f=await fixture();try{
  await expect(f.journal.review({accountId:f.account,order:{currency_pair_id:'btc-pair',side:'buy',type:'limit',quantity:'1',limit_price:'100'},maximumDebit:'1',review:{}})).rejects.toThrow('below limit');
  const a=await f.review();await expect(f.journal.claim(a.id,async()=>{f.later();})).rejects.toThrow('expired');
  expect(await f.held()).toEqual([]);expect((await f.journal.get(a.id)).status).toBe('reviewed');
 }finally{await f.close();}
});


import type {CryptoIntentRow} from '../../../src/main/orders/crypto-journal';
function recoveryInput(row:CryptoIntentRow,clock:number,state='APPROVAL_STATE_APPROVED'){
 const scope={accountId:row.account_id,accountNumber:'FAKE',cryptoAccountNumber:'FAKE-CRYPTO',clientRef:row.ref_id,symbol:'BTC-USD',order:row.order_request};
 const approval={approval_id:'approval-1',account_number:'FAKE',asset_class:'ASSET_CLASS_CRYPTO',state,is_edited:false,
  proposed_order:{asset_class:'ASSET_CLASS_CRYPTO',symbol:'BTC-USD',side:row.order_request.side,order_type:row.order_request.type,time_in_force:'gtc',
   quantity:row.order_request.quantity,dollar_amount:row.order_request.dollar_amount?{amount:row.order_request.dollar_amount,currency_code:'USD'}:undefined,
   limit_price:{amount:row.order_request.limit_price,currency_code:'USD'}}};
 const order={id:'crypto-order',ref_id:'approval-1',currency_pair_id:row.order_request.currency_pair_id,side:row.order_request.side,type:row.order_request.type,
  time_in_force:'gtc',quantity:'0.001',cumulative_quantity:'0',state:'queued',limit_price:row.order_request.limit_price,speculative:false};
 return {scope,observedAt:new Date(clock).toISOString(),read:{accountId:row.account_id,complete:true,orders:[order],approvals:[approval]}};
}
test('reconciliation binds approved order once and retains its cash hold across late contradictory reads',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'approval_pending',approvalRef:'approval-1'});
  const input=recoveryInput(a,f.clock());
  expect(await f.journal.reconcile(a.id,input)).toMatchObject({status:'placed',provider_order_ref:'crypto-order'});
  input.read.orders=[];input.read.approvals[0].state='APPROVAL_STATE_DECLINED';
  expect((await f.journal.reconcile(a.id,input)).status).toBe('placed');
  expect((await f.held())[0].state).toBe('held');
  await expect(f.journal.claim(a.id,authorize)).rejects.toThrow('already attempted');
 }finally{await f.close();}
});
test('missing or edited approvals retain holds even after review expiry; provider expiry releases atomically',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'approval_pending',approvalRef:'approval-1'});
  f.later();const input=recoveryInput(a,f.clock(),'APPROVAL_STATE_EXPIRED');input.read.orders=[];
  const absent={...input,read:{...input.read,approvals:[]}};
  expect((await f.journal.reconcile(a.id,absent)).status).toBe('approval_pending');expect((await f.held())[0].state).toBe('held');
  input.read.approvals[0].is_edited=true;await f.journal.reconcile(a.id,input);expect((await f.held())[0].state).toBe('held');
  input.read.approvals[0].is_edited=false;
  expect((await f.journal.reconcile(a.id,input)).status).toBe('rejected');expect((await f.held())[0].state).toBe('released');
  expect((await f.journal.reconcile(a.id,input)).status).toBe('rejected');
 }finally{await f.close();}
});
test('uncertain approval reference survives restart and reconciles without submitting again',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);
  await f.journal.record(a.id,{state:'unknown',code:'approval_requires_reconciliation',approvalRef:'approval-1'});
  await f.restart();expect((await f.journal.get(a.id)).approval_ref).toBe('approval-1');
  const input=recoveryInput(a,f.clock());expect((await f.journal.reconcile(a.id,input)).status).toBe('placed');
  expect((await f.held())[0].state).toBe('held');
 }finally{await f.close();}
});
test('reconciliation refuses substituted orders and stale, future or pre-submission evidence',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.unknown(a.id,'transport_error');
  const input=recoveryInput(a,f.clock());
  for(const scope of [{...input.scope,accountId:randomUUID()},{...input.scope,clientRef:randomUUID()},
   {...input.scope,order:{...input.scope.order,dollar_amount:'1'}}])await expect(f.journal.reconcile(a.id,{...input,scope})).rejects.toThrow('stored order');
  for(const observedAt of ['invalid',new Date(f.clock()+1).toISOString(),new Date(f.clock()-1).toISOString()])await expect(f.journal.reconcile(a.id,{...input,observedAt})).rejects.toThrow('Fresh');
  f.later();await expect(f.journal.reconcile(a.id,input)).rejects.toThrow('Fresh');
  expect((await f.held())[0].state).toBe('held');expect((await f.journal.get(a.id)).status).toBe('placement_unknown');
 }finally{await f.close();}
});

import {createCryptoOrderExecution} from '../../../src/main/orders/crypto-execution';
function approvedResponse(row:CryptoIntentRow,at:number){
 const input=recoveryInput(row,at,'APPROVAL_STATE_PENDING');
 return {isError:false,errorCategory:null,data:{data:{approval:input.read.approvals[0]}}};
}
test('shared execution dispatches once under concurrent confirms and pending approvals never resubmit',async()=>{
 const f=await fixture();try{
  const a=await f.review();let sends=0;
  const execution=createCryptoOrderExecution(f.journal,{enabled:()=>true,authorize,prepare:async row=>({scope:recoveryInput(row,f.clock()).scope,maximumDebit:row.maximum_debit,
   send:async()=>{sends++;return approvedResponse(row,f.clock());}})});
  const results=await Promise.allSettled([execution.confirm(a.id),execution.confirm(a.id)]);
  expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(sends).toBe(1);
  expect((await execution.confirm(a.id)).status).toBe('approval_pending');expect(sends).toBe(1);
  expect((await f.held())[0].state).toBe('held');
 }finally{await f.close();}
});
test('lost provider response retains the hold and cannot be retried after restart',async()=>{
 const f=await fixture();try{
  const a=await f.review();let sends=0;
  const execution=createCryptoOrderExecution(f.journal,{enabled:()=>true,authorize,prepare:async row=>({scope:recoveryInput(row,f.clock()).scope,maximumDebit:row.maximum_debit,
   send:async()=>{sends++;throw Error('Connection reset after broker received request');}})});
  expect((await execution.confirm(a.id)).status).toBe('placement_unknown');await f.restart();
  await expect(execution.confirm(a.id)).rejects.toThrow('reconcile');expect(sends).toBe(1);expect((await f.held())[0].state).toBe('held');
  const recovery=recoveryInput(a,f.clock());recovery.read.orders[0].ref_id=a.ref_id;recovery.read.approvals=[];
  expect((await f.journal.reconcile(a.id,recovery)).status).toBe('placed');
  expect((await execution.confirm(a.id)).status).toBe('placed');expect(sends).toBe(1);
 }finally{await f.close();}
});
test('changed debit, swapped identity, revoked consent and trading off prevent transport and holds',async()=>{
 const f=await fixture();try{
  const a=await f.review();let sends=0;
  for(const mode of ['debit','account','consent','switch','stored']){
   let enabled=true;
   const execution=createCryptoOrderExecution(f.journal,{enabled:()=>enabled,authorize:async()=>{if(mode==='consent')throw Error('Consent revoked');},prepare:async row=>{
    if(mode==='switch')enabled=false;
    if(mode==='stored')await f.db.query(`UPDATE order_intents SET order_request=jsonb_set(order_request,'{dollar_amount}','"1"') WHERE id=$1`,[a.id]);
    return {scope:{...recoveryInput(row,f.clock()).scope,...(mode==='account'?{accountId:randomUUID()}:{})},maximumDebit:mode==='debit'?'1000':row.maximum_debit,
     send:async()=>{sends++;return approvedResponse(row,f.clock());}};
   }});
   await expect(execution.confirm(a.id)).rejects.toThrow();
  }
  expect(sends).toBe(0);expect(await f.held()).toEqual([]);expect((await f.journal.get(a.id)).status).toBe('reviewed');
 }finally{await f.close();}
});

test('rejection and cash release roll back together if reconciliation persistence fails',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'approval_pending',approvalRef:'approval-1'});
  const input=recoveryInput(a,f.clock(),'APPROVAL_STATE_DECLINED');input.read.orders=[];
  await f.db.exec(`CREATE FUNCTION fail_hold_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic storage failure'; END $$;
   CREATE TRIGGER fail_hold_release BEFORE UPDATE ON order_cash_holds FOR EACH ROW EXECUTE FUNCTION fail_hold_release();`);
  await expect(f.journal.reconcile(a.id,input)).rejects.toThrow('Synthetic storage failure');
  expect((await f.journal.get(a.id)).status).toBe('approval_pending');expect((await f.held())[0].state).toBe('held');
  await f.db.exec('DROP TRIGGER fail_hold_release ON order_cash_holds');
  expect((await f.journal.reconcile(a.id,input)).status).toBe('rejected');expect((await f.held())[0].state).toBe('released');
 }finally{await f.close();}
});

import {createCryptoFillSettlement} from '../../../src/main/orders/crypto-fill-settlement';
test('fill ledger writes and checkpoints commit together, replay after restart, and never release a terminal hold',async()=>{
 const f=await fixture();try{
  const a=await f.review('100');await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  await f.db.exec('CREATE TABLE synthetic_crypto_ledger(cause text PRIMARY KEY,quantity numeric(38,18),cash numeric(38,18))');
  let fail=true;
  const settlement=createCryptoFillSettlement(f.database,{applyDelta:async(tx,{cause,delta})=>{
   await tx.query('INSERT INTO synthetic_crypto_ledger VALUES($1,$2,$3)',[cause,delta.quantityDelta,delta.cashDelta]);
   if(fail)throw Error('Synthetic accounting failure');
  }},f.clock);
  const order={id:'crypto-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'partially_filled',quantity:'0.002',limit_price:'50000',cumulative_quantity:'0.001',
   updated_at:new Date(f.clock()).toISOString(),net_rounded_executed_notional:'50',executions:[{id:'fill-1',quantity:'0.001',price:'50000',effective_price:'50000',notional:'50',timestamp:new Date(f.clock()).toISOString()}]};
  const input={intentId:a.id,accountId:f.account,observedAt:new Date(f.clock()).toISOString(),order};
  await expect(settlement.observe(input)).rejects.toThrow('Synthetic accounting failure');
  expect((await f.db.query('SELECT * FROM synthetic_crypto_ledger')).rows).toEqual([]);expect((await f.db.query('SELECT * FROM order_fill_checkpoints')).rows).toEqual([]);
  fail=false;
  await expect(settlement.observe({...input,accountId:randomUUID()})).rejects.toThrow('bound');
  await expect(settlement.observe({...input,order:{...order,net_rounded_executed_notional:'101'}})).rejects.toThrow('exceeds reserved');
  await expect(settlement.observe({...input,order:{...order,limit_price:'60000'}})).rejects.toThrow('limit price');
  await settlement.observe(input);await f.restart();
  expect((await settlement.observe(input)).delta.changed).toBe(false);
  expect((await f.db.query('SELECT * FROM synthetic_crypto_ledger')).rows).toHaveLength(1);
  f.later();input.observedAt=new Date(f.clock()).toISOString();input.order={...order,state:'canceled',updated_at:input.observedAt};
  expect((await settlement.observe(input)).snapshot.terminal).toBe(true);
  expect((await f.db.query('SELECT * FROM synthetic_crypto_ledger')).rows).toHaveLength(1);expect((await f.held())[0].state).toBe('held');
 }finally{await f.close();}
});

import {append,holdings} from '../../../src/main/allocations/ledger';
import {instrumentKey} from '../../../src/shared/strategies';
test('real Take ledger books crypto net cash once with exact pair identity and rejects unapplied assets',async()=>{
 const f=await fixture();try{
  const r=await f.request('100'),investment=await f.core.invest(r);
  const a=await f.journal.review({accountId:f.account,...investment,order:{currency_pair_id:'btc-pair',type:'limit',side:'buy',dollar_amount:'100',limit_price:'50000'},maximumDebit:'100',review:{}});
  await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  const at=new Date(f.clock()).toISOString();
  const input={intentId:a.id,accountId:f.account,observedAt:at,order:{id:'crypto-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'partially_filled',quantity:'0.002',limit_price:'50000',cumulative_quantity:'0.001',updated_at:at,
   net_rounded_executed_notional:'50.10',fee:'0.10',executions:[{id:'fill-1',quantity:'0.001',price:'50000',effective_price:'50100',notional:'50.10',timestamp:at}]}};
  const settlement=createCryptoFillSettlement(f.database,undefined,f.clock);
  await expect(settlement.observe(input)).rejects.toThrow('original Take identity');
  expect((await f.db.query('SELECT * FROM order_fill_checkpoints')).rows).toEqual([]);
  const instrument={venue:'robinhood',symbol:'BTC',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'btc-pair'}};
  // Append a new fixture version and explicitly adopt it; version history stays immutable.
  const cryptoVersion=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $2,strategy_id,owner_id,2,schema_version,metadata,jsonb_set(spec,'{target,weights,0,instrument}',$3::jsonb),provenance,verification FROM strategy_versions WHERE id=$1`,[r.versionId,cryptoVersion,JSON.stringify(instrument)]);
  await f.db.query('UPDATE strategy_allocations SET applied_version_id=$2 WHERE id=$1',[r.allocationId,cryptoVersion]);
  await f.db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,version_id,transaction_id,kind,trigger,symbol,side,status,order_request,idempotency_key,request_hash,order_intent_id,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,'rebalance','republish','BTC','buy','submitted',$7,$8,repeat('a',64),$9,$10,$10)`,[randomUUID(),r.allocationId,f.account,r.strategyId,cryptoVersion,investment.transactionId,JSON.stringify(a.order_request),randomUUID(),a.id,at]);
  // A later adoption cannot change which version owns an already placed fill.
  await f.db.query('UPDATE strategy_allocations SET applied_version_id=$2 WHERE id=$1',[r.allocationId,r.versionId]);

  await settlement.observe(input);await f.restart();await settlement.observe(input);
  await f.db.transaction(tx=>append(tx,{allocationId:r.allocationId,transactionId:investment.transactionId,entryType:'fill',cause:'synthetic-equity',instrumentRef:'BTC',symbol:'BTC',quantityDelta:'1',cashDelta:'0',sourceKind:'test',sourceRef:'equity',occurredAt:at},at));
  expect(await f.core.preview(await f.request('1'))).toMatchObject({availableCash:'0',canFund:false});
  const personal=await f.review('1');await expect(f.journal.claim(personal.id,authorize)).rejects.toThrow('Insufficient');
  const held=await f.db.transaction(tx=>holdings(tx,r.allocationId));
  expect(held.cash).toBe('49.9');expect(held.positions).toEqual(expect.arrayContaining([{instrumentRef:'BTC',symbol:'BTC',quantity:'1'},{instrumentRef:instrumentKey(instrument),symbol:'BTC',quantity:'0.001'}]));
  expect((await f.db.query("SELECT asset_class,cash_delta::text FROM strategy_attribution_entries WHERE source_kind='provider_order_cumulative'")).rows).toEqual([{asset_class:'crypto',cash_delta:'-50.100000000000000000'}]);
  expect((await f.held())[0].state).toBe('held');
 }finally{await f.close();}
});

test('crypto ledger migration preserves prior equity entries, Take cash and migration checksums',async()=>{
 const f=await fixture(74);try{
  const r=await f.request('100'),investment=await f.core.invest(r),at=new Date(f.clock()).toISOString();
  await f.db.transaction(tx=>append(tx,{allocationId:r.allocationId,transactionId:investment.transactionId,entryType:'fill',cause:'legacy-stock',instrumentRef:'VTI',symbol:'VTI',quantityDelta:'1',cashDelta:'-25',sourceKind:'test',sourceRef:'legacy',occurredAt:at},at));
  const before=(await f.db.query('SELECT * FROM strategy_attribution_entries ORDER BY sequence')).rows;
  const history=(await f.db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await migrate(f.db);await migrate(f.db);
  expect((await f.db.query('SELECT * FROM strategy_attribution_entries ORDER BY sequence')).rows).toEqual(before);
  expect((await f.db.query('SELECT * FROM app_migrations WHERE version<=74 ORDER BY version')).rows).toEqual(history);
  expect(await f.db.transaction(tx=>holdings(tx,r.allocationId))).toMatchObject({cash:'75',positions:[{instrumentRef:'VTI',quantity:'1'}]});
 }finally{await f.close();}
});


import {createCryptoCashSettlement} from '../../../src/main/orders/crypto-cash-settlement';
test('zero-fill cancellation needs fresh post-terminal account sync before releasing a hold',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  const release=createCryptoCashSettlement(f.database,f.clock),settle=createCryptoFillSettlement(f.database,undefined,f.clock);
  await expect(release.releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('terminal');
  f.later();const at=new Date(f.clock()).toISOString();
  const input={intentId:a.id,accountId:f.account,observedAt:at,order:{id:'crypto-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'canceled',quantity:'0.001',limit_price:'50000',cumulative_quantity:'0',updated_at:at,net_rounded_executed_notional:null,executions:[]}};
  await settle.observe(input);
  await expect(release.releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('Refresh account cash');
  await f.sync.synchronize();
  await expect(release.releaseUnfilled({intentId:a.id,accountId:randomUUID()})).rejects.toThrow('not found');
  expect(await release.releaseUnfilled({intentId:a.id,accountId:f.account})).toEqual({released:true});
  expect(await release.releaseUnfilled({intentId:a.id,accountId:f.account})).toEqual({released:true});
  expect((await f.held())[0].state).toBe('released');
 }finally{await f.close();}
});
test('partial-fill cancellation cannot release through the zero-fill shortcut even with fresh cash',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  const at=new Date(f.clock()).toISOString(),settle=createCryptoFillSettlement(f.database,undefined,f.clock);
  await settle.observe({intentId:a.id,accountId:f.account,observedAt:at,order:{id:'crypto-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'canceled',quantity:'0.002',limit_price:'50000',cumulative_quantity:'0.001',updated_at:at,net_rounded_executed_notional:'50',executions:[{id:'fill',quantity:'0.001',price:'50000',effective_price:'50000',notional:'50',timestamp:at}]}});
  await f.sync.synchronize();
  await expect(createCryptoCashSettlement(f.database,f.clock).releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('zero-fill');
  expect((await f.held())[0].state).toBe('held');
 }finally{await f.close();}
});
test('unchanged terminal polls refresh observation time without duplicating ledger revisions',async()=>{
 const f=await fixture();try{
  const a=await f.review();await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  const at=new Date(f.clock()).toISOString(),settle=createCryptoFillSettlement(f.database,undefined,f.clock),release=createCryptoCashSettlement(f.database,f.clock);
  const input={intentId:a.id,accountId:f.account,observedAt:at,order:{id:'crypto-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'canceled',quantity:'0.001',limit_price:'50000',cumulative_quantity:'0',updated_at:at,net_rounded_executed_notional:null,executions:[]}};
  await settle.observe(input);f.later();await f.sync.synchronize();
  await expect(release.releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('Fresh terminal');
  input.observedAt=new Date(f.clock()).toISOString();expect((await settle.observe(input)).revision).toBe(1);
  await f.db.query("UPDATE account_sync_checkpoints SET discovery_complete=false WHERE account_id=$1 AND resource='equity_orders'",[f.account]);
  await expect(release.releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('synchronization');
  await f.sync.synchronize();expect((await release.releaseUnfilled({intentId:a.id,accountId:f.account})).released).toBe(true);
 }finally{await f.close();}
});

test('cash release preserves other order holds and refuses cash shortfalls or uncertain submissions',async()=>{
 const f=await fixture();try{
  const a=await f.review('60');await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'crypto-order'});
  const b=await f.review('30');await f.journal.claim(b.id,authorize);
  const at=new Date(f.clock()).toISOString(),settle=createCryptoFillSettlement(f.database,undefined,f.clock),release=createCryptoCashSettlement(f.database,f.clock);
  const input={intentId:a.id,accountId:f.account,observedAt:at,order:{id:'crypto-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'canceled',quantity:'0.001',limit_price:'50000',cumulative_quantity:'0',updated_at:at,net_rounded_executed_notional:null,executions:[]}};
  await settle.observe(input);
  await expect(release.releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('uncertain');
  await f.journal.record(b.id,{state:'approval_pending',approvalRef:'other-approval'});
  f.later();input.observedAt=new Date(f.clock()).toISOString();await settle.observe(input);f.setCash('20');await f.sync.synchronize();
  await expect(release.releaseUnfilled({intentId:a.id,accountId:f.account})).rejects.toThrow('remaining claims');
  expect((await f.held()).every(h=>h.state==='held')).toBe(true);
  f.later();input.observedAt=new Date(f.clock()).toISOString();await settle.observe(input);f.setCash('100');await f.sync.synchronize();
  await release.releaseUnfilled({intentId:a.id,accountId:f.account});
  expect((await f.held()).filter(h=>h.state==='held')).toHaveLength(1);
  expect((await f.journal.get(b.id)).status).toBe('approval_pending');
 }finally{await f.close();}
});

test('desktop crypto service reviews, confirms once, refreshes fills and keeps cancellation separate from cash release',async()=>{
 const {createCryptoTradingService}=await import('../../../src/main/orders/crypto-service');
 const f=await fixture(Infinity,Date.now());try{
  let enabled=true,sends=0,latest:any,fail=false,approval:any=null;
  const order={currency_pair_id:'btc-pair',side:'buy' as const,type:'limit' as const,dollar_amount:'5',limit_price:'50000'};
  const scope=(row:any)=>({accountId:f.account,accountNumber:'fake',cryptoAccountNumber:'RHC-fake',clientRef:row.ref_id,symbol:'BTC-USD',order:row.order_request});
  const session={
   review:async()=>({order,maximumDebit:'5.01',preview:{symbol:'BTC-USD'}}),
   prepare:async(row:any)=>({scope:scope(row),maximumDebit:'5.01',send:async()=>{sends++;latest={id:`order-fake-${sends}`,ref_id:row.ref_id,currency_pair_id:'btc-pair',side:'buy',type:'limit',time_in_force:'gtc',quantity:'0.0001',limit_price:'50000',cumulative_quantity:'0',state:'confirmed',updated_at:new Date().toISOString(),executions:[],net_rounded_executed_notional:null};if(fail)throw Error('lost response');return approval?{isError:false,errorCategory:null,data:{data:{approval}}}:{isError:false,errorCategory:null,data:{data:{crypto_account_number:'RHC-fake',order:latest}}};}}),
   observe:async(row:any)=>({scope:scope(row),observedAt:new Date().toISOString(),read:{accountId:f.account,complete:true,orders:approval?.state==='APPROVAL_STATE_PENDING'?[]:[latest],approvals:approval?[approval]:[]}}),
   cancel:async()=>({isError:false,errorCategory:null,data:{data:{accepted:true}}}),
  };
  const service=createCryptoTradingService(f.database,{enabled:()=>enabled,selected:async()=>f.account,session:async(_id,work)=>work(session as any),synchronize:async()=>{f.setTime(Date.now());await f.sync.synchronize();}});
  const reviewed=(await service.execute({action:'review',order})).orders[0];expect(reviewed.maximumDebit).toBe('5.01');
  const submitted=await service.execute({action:'confirm',id:reviewed.id});expect(submitted.orders[0]).toMatchObject({status:'placed',cashHeld:true});
  await service.execute({action:'confirm',id:reviewed.id});expect(sends).toBe(1);
  expect((await service.execute({action:'refresh',id:reviewed.id})).orders[0]).toMatchObject({providerState:'confirmed',filledQuantity:'0'});
  enabled=false;expect((await service.execute({action:'cancel',id:reviewed.id})).cancellation).toBe('requested');
  expect((await service.execute({action:'list'})).orders[0].cashHeld).toBe(true);
  await expect(service.execute({action:'review',order})).rejects.toThrow('disabled');
  latest={...latest,state:'canceled',updated_at:new Date().toISOString()};
  expect((await service.execute({action:'refresh',id:reviewed.id})).orders[0]).toMatchObject({providerState:'canceled',cashHeld:false});
  enabled=true;fail=true;const uncertain=(await service.execute({action:'review',order})).orders[0];
  expect((await service.execute({action:'confirm',id:uncertain.id})).orders[0].status).toBe('placement_unknown');
  await expect(service.execute({action:'confirm',id:uncertain.id})).rejects.toThrow('already attempted');expect(sends).toBe(2);
  expect((await service.execute({action:'refresh',id:uncertain.id})).orders[0].status).toBe('placed');
  fail=false;approval={approval_id:'approval-fake',account_number:'fake',asset_class:'ASSET_CLASS_CRYPTO',state:'APPROVAL_STATE_PENDING',is_edited:false,proposed_order:{asset_class:'ASSET_CLASS_CRYPTO',symbol:'BTC-USD',side:'buy',order_type:'limit',time_in_force:'gtc',dollar_amount:{amount:'5',currency_code:'USD'},limit_price:{amount:'50000',currency_code:'USD'}}};
  const pending=(await service.execute({action:'review',order})).orders[0];
  expect((await service.execute({action:'confirm',id:pending.id})).orders[0]).toMatchObject({approvalPending:true,cashHeld:true});
  expect((await service.execute({action:'refresh',id:pending.id})).orders[0].approvalPending).toBe(true);
  approval.state='APPROVAL_STATE_APPROVED';latest={...latest,ref_id:'approval-fake'};
  expect((await service.execute({action:'refresh',id:pending.id})).orders[0]).toMatchObject({approvalPending:false,status:'placed',cashHeld:true});
  expect(sends).toBe(3);

 }finally{await f.close();}
});

async function cryptoSeller(f:Awaited<ReturnType<typeof fixture>>){
 const request=await f.request('50'),investment=await f.core.invest(request),version=randomUUID();
 const instrument={venue:'robinhood',symbol:'BTC',market:{venue:'robinhood',instance:'production',kind:'crypto',reference:'btc-pair'}};
 await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
 SELECT $2,strategy_id,owner_id,2,schema_version,metadata,jsonb_set(spec,'{target,weights,0,instrument}',$3::jsonb),provenance,verification FROM strategy_versions WHERE id=$1`,[request.versionId,version,JSON.stringify(instrument)]);
 await f.db.query('UPDATE strategy_allocations SET applied_version_id=$2 WHERE id=$1',[request.allocationId,version]);
 const at=new Date(f.clock()).toISOString();
 await f.db.transaction(tx=>append(tx,{allocationId:request.allocationId,transactionId:investment.transactionId,entryType:'fill',cause:'owned-coins',instrumentRef:instrumentKey(instrument),assetClass:'crypto',symbol:'BTC',quantityDelta:'0.002',cashDelta:'0',sourceKind:'test',sourceRef:'coins',occurredAt:at},at));
 return {investment,review:(quantity='0.002')=>f.journal.review({accountId:f.account,...investment,order:{currency_pair_id:'btc-pair',type:'market',side:'sell',quantity},maximumDebit:'0',review:{symbol:'BTC-USD'}}),available:()=>({quantity:'0.002',observedAt:new Date(f.clock()).toISOString()})};
}
test('crypto sell claims reserve owned units atomically, survive restart and release only on rejection',async()=>{
 const f=await fixture();try{
  const seller=await cryptoSeller(f),a=await seller.review(),b=await seller.review();
  const results=await Promise.allSettled([f.journal.claim(a.id,authorize,seller.available()),f.journal.claim(b.id,authorize,seller.available())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const winner=results[0].status==='fulfilled'?a:b,loser=winner.id===a.id?b:a;
  expect(await f.held()).toEqual([]);
  await f.restart();await f.journal.recoverInterrupted();
  expect((await f.journal.get(winner.id)).status).toBe('placement_unknown');
  await expect(f.journal.claim(loser.id,authorize,seller.available())).rejects.toThrow('unreserved Take');
  await f.journal.record(winner.id,{state:'rejected',code:'provider_invalid_request'});
  await f.journal.claim(loser.id,authorize,seller.available());
  expect((await f.db.query("SELECT * FROM order_unit_holds WHERE state='held'")).rows).toHaveLength(1);
 }finally{await f.close();}
});
test('crypto sells require fresh transferable evidence and exact Take ownership; partial fills retain holds',async()=>{
 const f=await fixture();try{
  const seller=await cryptoSeller(f),a=await seller.review();
  await expect(f.journal.claim(a.id,authorize)).rejects.toThrow('Fresh transferable');
  await expect(f.journal.claim(a.id,authorize,{...seller.available(),quantity:'0.001'})).rejects.toThrow('transferable');
  await expect(f.journal.claim(a.id,authorize,{...seller.available(),observedAt:new Date(f.clock()-60001).toISOString()})).rejects.toThrow('Fresh transferable');
  await f.journal.claim(a.id,authorize,seller.available());await f.journal.record(a.id,{state:'accepted',providerRef:'sell-order'});
  const at=new Date(f.clock()).toISOString(),settlement=createCryptoFillSettlement(f.database,undefined,f.clock);
  const order={id:'sell-order',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'sell',state:'partially_filled',quantity:'0.002',cumulative_quantity:'0.001',updated_at:at,
   net_rounded_executed_notional:'49.9',fee:'0.1',executions:[{id:'sell-fill',quantity:'0.001',price:'50000',effective_price:'49900',notional:'49.9',timestamp:at}]};
  await settlement.observe({intentId:a.id,accountId:f.account,observedAt:at,order});
  expect((await f.db.query("SELECT * FROM order_unit_holds WHERE state='held'")).rows).toHaveLength(1);
  const next=new Date(f.clock()+1000).toISOString();f.setTime(f.clock()+1000);
  await settlement.observe({intentId:a.id,accountId:f.account,observedAt:next,order:{...order,state:'canceled',updated_at:next}});
  expect((await f.db.query("SELECT * FROM order_unit_holds WHERE state='held'")).rows).toHaveLength(0);
  const owned=await f.db.transaction(tx=>holdings(tx,seller.investment.allocationId));
  expect(owned.cash).toBe('99.9');expect(owned.positions[0].quantity).toBe('0.001');
 }finally{await f.close();}
});


test('Take crypto writer uses the shared executor contract and refuses recorded account denials before broker calls',async()=>{
 const {createCryptoTakeWriter}=await import('../../../src/main/orders/crypto-take-writer');
 const {createTakeOrderWriter}=await import('../../../src/main/orders/take-writer');
 const f=await fixture();try{
  const seller=await cryptoSeller(f);let sessions=0,sends=0;
  await f.db.query('UPDATE strategy_allocations SET applied_version_id=accepted_version_id WHERE id=$1',[seller.investment.allocationId]);
  const order={currency_pair_id:'btc-pair',side:'sell' as const,type:'market' as const,quantity:'0.001'};
  const writer=createCryptoTakeWriter(f.database,{enabled:()=>true,session:async(accountId,work)=>{sessions++;return work({
   review:async()=>({order,preview:{symbol:'BTC-USD'},maximumDebit:'0'}),
   prepare:async(row:any)=>({scope:{accountId,accountNumber:'fake',cryptoAccountNumber:'RHC-fake',clientRef:row.ref_id,symbol:'BTC-USD',order:row.order_request},maximumDebit:'0',sellAvailability:seller.available(),send:async()=>{sends++;return {isError:true,errorCategory:'invalid_request',data:{error:'agentic trading is not available to New York residents.'}};}}),
  } as any);}},f.clock);
  const router=createTakeOrderWriter(f.database,{crypto:writer,equity:{review:async()=>{throw Error('Wrong asset route');},confirm:async()=>{throw Error('Wrong asset route');}}});
  await expect(router.review({accountId:f.account,...seller.investment,order:{currency_pair_id:'btc-pair',side:'buy',type:'market',dollar_amount:'5'}})).rejects.toThrow('accepted target or owned sell');
  expect(sessions).toBe(0);
  const review=await router.review({accountId:f.account,...seller.investment,order});
  await expect(router.confirm(review.intent.id)).rejects.toThrow('rejected');expect(sends).toBe(1);
  expect((await f.db.query("SELECT * FROM order_unit_holds WHERE state='held'")).rows).toHaveLength(0);
  const before=sessions;
  await expect(router.review({accountId:f.account,...seller.investment,order})).rejects.toThrow('previously denied');expect(sessions).toBe(before);
 }finally{await f.close();}
});

test('filled buy cash releases only after a fresh balance accounts for its actual debit',async()=>{
 const f=await fixture();try{
  const intent=await f.review('60');await f.journal.claim(intent.id,authorize);await f.journal.record(intent.id,{state:'accepted',providerRef:'filled-buy'});
  const at=new Date(f.clock()).toISOString(),settlement=createCryptoFillSettlement(f.database,undefined,f.clock),release=createCryptoCashSettlement(f.database,f.clock);
  await settlement.observe({intentId:intent.id,accountId:f.account,observedAt:at,order:{id:'filled-buy',ref_id:intent.ref_id,currency_pair_id:'btc-pair',side:'buy',state:'filled',quantity:'0.001',limit_price:'50000',cumulative_quantity:'0.001',updated_at:at,net_rounded_executed_notional:'50.10',executions:[{id:'fill',quantity:'0.001',price:'50000',effective_price:'50100',notional:'50.10',timestamp:at}]}});
  await f.sync.synchronize();
  await expect(release.releaseSettled({intentId:intent.id,accountId:f.account})).rejects.toThrow('has not reconciled');
  expect((await f.held())[0].state).toBe('held');
  f.setTime(f.clock()+1000);f.setCash('49.90');await f.sync.synchronize();
  expect(await release.releaseSettled({intentId:intent.id,accountId:f.account})).toEqual({released:true});
  expect((await f.held())[0].state).toBe('released');
  expect(await release.releaseSettled({intentId:intent.id,accountId:f.account})).toEqual({released:true});
 }finally{await f.close();}
});

test('maintenance observes and settles crypto fills without submitting an order',async()=>{
 const {createCryptoOrderSync}=await import('../../../src/main/orders/crypto-sync');
 const f=await fixture();try{
  const a=await f.review('60');await f.journal.claim(a.id,authorize);await f.journal.record(a.id,{state:'accepted',providerRef:'sync-buy'});
  const at=new Date(f.clock()).toISOString();let reads=0,balances=0;
  const order={id:'sync-buy',ref_id:a.ref_id,currency_pair_id:'btc-pair',side:'buy',type:'limit',time_in_force:'gtc',state:'filled',quantity:'0.001',limit_price:'50000',cumulative_quantity:'0.001',updated_at:at,net_rounded_executed_notional:'50',executions:[{id:'sync-fill',quantity:'0.001',price:'50000',effective_price:'50000',notional:'50',timestamp:at}]};
  const sync=createCryptoOrderSync(f.database,{session:async(_id,work)=>work({observe:async()=>{reads++;return {scope:{accountId:f.account,accountNumber:'fake',cryptoAccountNumber:'RHC-fake',clientRef:a.ref_id,symbol:'BTC-USD',order:a.order_request},observedAt:new Date(f.clock()).toISOString(),read:{accountId:f.account,complete:true,orders:[order],approvals:[]}};}} as any),refreshCash:async()=>{balances++;f.setTime(f.clock()+1000);f.setCash('50');await f.sync.synchronize();}},f.clock);
  await sync.synchronize(f.account);expect((await f.held())[0].state).toBe('released');
  await sync.synchronize(f.account);expect(reads).toBe(1);expect(balances).toBe(1);
  expect((await f.db.query('SELECT * FROM order_fill_checkpoints')).rows).toHaveLength(1);
 }finally{await f.close();}
});
