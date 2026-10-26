import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate,prepareRestoredDatabase} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createInvestmentPreview} from '../../../src/main/planning/preview';
import {robinhoodPreviewRules,type PreviewEvidence} from '../../../src/main/planning/first-investment';
import {createAllocationCore} from '../../../src/main/allocations/service';

async function fixture() {
 const db=new PGlite();await migrate(db);
 let now=Date.parse('2026-10-03T14:00:00.000Z');
 const database={use:<T>(operation:(db:PGlite)=>Promise<T>)=>operation(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'fixture','synthetic',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,maskedNumber:'synthetic',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'2000',cash:'1000',buying_power:'1000'}:
    name==='get_equity_positions'?{results:[{instrument_id:'personal-vti',symbol:'VTI',quantity:'100',mark_price:'10'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const strategyId=randomUUID(),versionId=randomUUID();
 const spec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:8000}],cashBps:2000},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategyId]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
  SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[versionId,strategyId,JSON.stringify(spec)]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategyId,versionId]);
 const request={accountId,strategyId,versionId,amount:'100'};
 const evidence=():PreviewEvidence=>({accountId,venue:'robinhood',observedAt:new Date(now).toISOString(),instruments:[{symbol:'VTI',instrumentRef:'personal-vti',markPriceUsd:'10',tradable:true,fractional:true}]});
 let duringEvidence=async()=>{};
 const preview=createInvestmentPreview(database,{rules:robinhoodPreviewRules('10000'),clock:()=>now,evidence:async input=>{
  expect(input).toEqual({accountId,venue:'robinhood',symbols:['VTI']});await duringEvidence();return evidence();
 }});
 return {db,database,request,preview,connection,advance:()=>{now+=16*60_000;},core:createAllocationCore(database,()=>now),
  during:(fn:()=>Promise<void>)=>{duringEvidence=fn;},close:async()=>{sync.cancel();await db.close();}};
}
async function financialState(db:PGlite) {
 const tables=['strategy_allocations','strategy_allocation_transactions','strategy_attribution_entries','strategy_evidence_pins','strategy_reconciliation_cases','account_orders','account_executions','account_sync_checkpoints'];
 return Promise.all(tables.map(async table=>(await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows));
}
test('preview uses hypothetical cash, never personal holdings, and leaves financial storage unchanged on replay',async()=>{
 const f=await fixture();try{
  const before=await financialState(f.db);
  const p=await f.preview(f.request);
  expect(p).toMatchObject({disposition:'planned',totalBuyUsd:'80',remainingCashUsd:'20',availableCashUsd:'1000'});
  expect(p.sleeves[0]).toMatchObject({dollarAmount:'80',disposition:'order'});
  expect(await f.preview(f.request)).toEqual(p);
  expect(await financialState(f.db)).toEqual(before);
 }finally{await f.close();}
});
test('rechecks account and version after evidence fetch and subtracts newly reserved cash',async()=>{
 const f=await fixture();try{
  await expect(f.preview({...f.request,versionId:randomUUID()})).rejects.toThrow('Current committed');
  f.during(async()=>{await f.db.query(`UPDATE strategies SET archived_at=now() WHERE id=$1`,[f.request.strategyId]);});
  await expect(f.preview(f.request)).rejects.toThrow('Current committed');
  await f.db.query(`UPDATE strategies SET archived_at=NULL WHERE id=$1`,[f.request.strategyId]);
  f.during(async()=>{await f.db.query(`UPDATE linked_accounts SET selected=false WHERE id=$1`,[f.request.accountId]);});
  await expect(f.preview(f.request)).rejects.toThrow('Current committed');
  await f.db.query(`UPDATE linked_accounts SET selected=true WHERE id=$1`,[f.request.accountId]);
  f.during(async()=>{await f.core.invest({...f.request,amount:'950',allocationId:randomUUID(),cause:randomUUID()});});
  expect(await f.preview(f.request)).toMatchObject({availableCashUsd:'50',canFund:false,disposition:'deferred'});
 }finally{await f.close();}
});
test('stale sync and unresolved orders/fills fail closed without creating an allocation',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen)
   VALUES($1,'robinhood','synthetic','equity','queued',false,'{}',now(),now())`,[f.request.accountId]);
  await expect(f.preview(f.request)).rejects.toThrow('open account orders');
  await f.db.query(`UPDATE account_orders SET terminal=true`);
  await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at)
   VALUES($1,'robinhood','fill','synthetic','equity','{}',now())`,[f.request.accountId]);
  await expect(f.preview(f.request)).rejects.toThrow('fill attribution');
  await f.db.query(`UPDATE account_executions SET attribution_state='completed',attributed_at=now()`);
  f.advance();await expect(f.preview(f.request)).rejects.toThrow('Fresh account');
  expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
 }finally{await f.close();}
});
test('restore invalidation blocks preview after a fresh-profile restore',async()=>{
 const f=await fixture();try{
  await prepareRestoredDatabase(f.db);
  await expect(f.preview(f.request)).rejects.toThrow();
  expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
 }finally{await f.close();}
});
