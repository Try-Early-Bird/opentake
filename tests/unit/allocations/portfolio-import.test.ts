import {expect,test} from 'vitest';
import {importedAllocationValueMigration} from '../../../src/main/allocations/import-value-migration';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {importStrategyPortfolio,validateStrategyPortfolio,strategyImportResult,StrategyImportError} from '../../../src/main/allocations/portfolio-import';
import {matchesImportedAccountNumber} from '../../../src/main/robinhood-client';
import {createStrategies} from '../../../src/main/strategies/service';
const now=Date.parse('2026-10-03T14:00:00Z');
async function fixture(){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-hash','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 let quantity='20',clock=now;const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity,mark_price:'10',average_buy_price:'8'}]}:{results:[]},
 },()=>clock);await sync.synchronize();
 const sourceConnection=randomUUID();
 const strategies=[1,2].map(i=>({id:randomUUID(),title:`Imported strategy ${i}`,description:'Synthetic',rebalance:i===1?{schedule:'daily',driftBandPoints:null,driftBandRelative:null}:null,versions:[{id:randomUUID(),sequence:1,weights:[{symbol:'VTI',weightPercent:80}],cashPercent:20}]}));
 const input={format:'opentake-strategy-portfolio-v1',exportedAt:new Date(now).toISOString(),source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-hash`).digest('hex')},strategies,
 allocations:strategies.map(s=>({id:randomUUID(),strategyId:s.id,status:'active',appliedSequence:1,entries:[
  {id:randomUUID(),sequence:1,entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',unitCost:null,currency:'USD',sourceKind:'reconciliation',sourceRef:'fixture1',occurredAt:'2026-10-02T14:00:00Z'},
  {id:randomUUID(),sequence:2,entryType:'fill',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',currency:'USD',sourceKind:'strategy_execution',sourceRef:'fixture2',occurredAt:'2026-10-02T15:00:00Z'},
 ],history:[{observedAt:'2026-10-02T15:00:00Z',totalValue:'100'}]}))};
 return {db,database,accountId,sync,input,shrink:async()=>{quantity='2';clock+=1000;await sync.synchronize();},close:async()=>{sync.cancel();await db.close();}};
}
test('imports complete source evidence once, creates editable takes, pauses ownership and subtracts shared-symbol claims',async()=>{
 const f=await fixture();try{
  expect(await importStrategyPortfolio(f.database,f.input,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).toEqual({imported:2,skipped:0});
  const v=await f.sync.snapshot();expect(v.strategies).toHaveLength(2);expect(v.strategies?.map(s=>s.value)).toEqual(['100','100']);
  expect(v.selfDirectedPositions?.[0]).toMatchObject({quantity:'10',marketValue:'100',averageCost:null,providerUnrealizedPnl:null});expect(v.reservedCash).toBe('100');expect(v.selfDirectedCash).toBe('900');
  expect(v.strategies?.every(s=>s.status==='paused'&&s.requiresReconciliation)).toBe(true);
  // Hosted's allocation_value: the net capital in the source ledger. Withdrawals settle against it.
  expect((await f.db.query(`SELECT allocation_value::numeric::text AS v FROM strategy_allocations`)).rows.map(r=>Number((r as {v:string}).v))).toEqual([100,100]);
  // Migration 40 repairs allocations imported before this, which came out at 0.
  await f.db.exec(`UPDATE strategy_allocations SET allocation_value=0`);
  await f.db.exec(importedAllocationValueMigration.sql);
  expect((await f.db.query(`SELECT allocation_value::numeric::text AS v FROM strategy_allocations`)).rows.map(r=>Number((r as {v:string}).v))).toEqual([100,100]);
  const authoring=createStrategies(f.database,{active:()=>false,ensure:async()=>{},verify:async()=>{throw Error('not needed');}});
  const take=await authoring.read(v.strategies![0].takeId!);expect(take?.clean).toBe(true);expect(take?.draft.metadata.title).toContain('Imported strategy');
  // Daily is a supported rule and survives import; imported allocations remain paused.
  expect(take?.draft.spec.rebalance.schedule).toBe(take?.draft.metadata.title.endsWith('1')?'daily':'never');expect(take?.draft.unsupportedRequests).toEqual([]);
  expect((await f.db.query("SELECT id FROM strategy_versions WHERE spec->'rebalance'->>'schedule'='daily'")).rows).toHaveLength(1);
  expect((await f.db.query('SELECT * FROM take_platform_context')).rows).toHaveLength(2);
  const before=(await f.db.query('SELECT * FROM strategy_attribution_entries ORDER BY id')).rows;
  expect(await importStrategyPortfolio(f.database,{...f.input,exportedAt:new Date(now+1000).toISOString()},undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).toEqual({imported:0,skipped:2});
  expect((await f.db.query('SELECT * FROM strategy_attribution_entries ORDER BY id')).rows).toEqual(before);
  expect((await f.db.query('SELECT * FROM account_orders')).rows).toHaveLength(0);
  await expect(f.db.exec('DELETE FROM strategy_portfolio_imports')).rejects.toThrow('append-only');
 }finally{await f.close();}
});
test('mismatched account, source gaps and excessive claims reject the whole import without partial rows',async()=>{
 const f=await fixture();try{
  await expect(importStrategyPortfolio(f.database,{...f.input,source:{...f.input.source,accountRefHash:'0'.repeat(64)}},undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).rejects.toThrow('match');
  const broken=structuredClone(f.input);broken.allocations[1].entries[1].sequence=3;
  expect(()=>validateStrategyPortfolio(broken,now)).toThrow('Incomplete');
  const excess=structuredClone(f.input);excess.allocations[1].entries[1].quantityDelta='30';
  await expect(importStrategyPortfolio(f.database,excess,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).rejects.toThrow('exceed');
  expect((await f.db.query('SELECT * FROM strategies')).rows).toHaveLength(0);
  expect((await f.db.query('SELECT * FROM strategy_portfolio_imports')).rows).toHaveLength(0);
 }finally{await f.close();}
});
test('changed import cannot overwrite local ownership; later physical shortfalls are visible without double counting',async()=>{
 const f=await fixture();try{
  await importStrategyPortfolio(f.database,f.input,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash});
  const changed=structuredClone(f.input);changed.allocations[0].entries[1].quantityDelta='6';
  await expect(importStrategyPortfolio(f.database,changed,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).rejects.toThrow('Source portfolio changed');
  await f.shrink();const v=await f.sync.snapshot();
  expect(v.allocationWarnings?.length).toBeGreaterThan(0);expect(v.strategies?.every(s=>s.value===null)).toBe(true);expect(v.selfDirectedPositions).toEqual([]);
 }finally{await f.close();}
});
test('transaction failure rolls back takes, versions, ownership and import receipt together',async()=>{
 const f=await fixture();try{
  await f.db.exec(`CREATE FUNCTION reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER reject_import BEFORE INSERT ON strategy_portfolio_imports FOR EACH ROW EXECUTE FUNCTION reject_import();`);
  await expect(importStrategyPortfolio(f.database,f.input,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).rejects.toThrow('fixture failure');
  for(const table of ['takes','strategies','strategy_versions','strategy_allocations','strategy_attribution_entries'])expect((await f.db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
 }finally{await f.close();}
});
test('open orders permit paused import, incomplete sync blocks it, and concurrent imports cannot duplicate claims',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','fixture','equity','queued',false,'{}',now(),now())`,[f.accountId]);
  await f.db.exec("UPDATE account_sync_checkpoints SET discovery_complete=false WHERE resource='equity_orders'");
  await expect(importStrategyPortfolio(f.database,f.input,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})).rejects.toThrow('Complete fresh');
  await f.db.exec("UPDATE account_sync_checkpoints SET discovery_complete=true WHERE resource='equity_orders'");
  const results=await Promise.all([importStrategyPortfolio(f.database,f.input,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash}),importStrategyPortfolio(f.database,f.input,undefined,now,{externalRef:'synthetic-hash',connectionId:f.input.source.connectionId,accountRefHash:f.input.source.accountRefHash})]);
  expect(results.reduce((n,r)=>n+r.imported,0)).toBe(2);expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(2);
  expect((await f.db.query('SELECT status,restore_required FROM strategy_allocations')).rows).toEqual([{status:'paused',restore_required:true},{status:'paused',restore_required:true}]);
  expect((await f.db.query("SELECT state,terminal FROM account_orders WHERE provider_ref='fixture'")).rows).toEqual([{state:'queued',terminal:false}]);
 }finally{await f.close();}
});


test('import responses expose authored validation failures and redact unexpected errors',async()=>{
 expect(await strategyImportResult(async()=>{throw new StrategyImportError('Strategy claims exceed account cash');})).toEqual({ok:false,message:'Strategy claims exceed account cash'});
 expect(await strategyImportResult(async()=>{throw new Error('private-path-or-database-row');})).toEqual({ok:false,message:'Take import failed. Check the export file and try again.'});
 expect(await strategyImportResult(async()=>({imported:4,skipped:0}))).toEqual({ok:true,value:{imported:4,skipped:0}});
});

test('source account matching uses the account number rather than double hashing its local reference',()=>{
 const number='synthetic-account-1234',connectionId=randomUUID();
 const local=createHash('sha256').update(number).digest('hex');
 const hosted=createHash('sha256').update(`${connectionId}:${number}`).digest('hex');
 expect(matchesImportedAccountNumber(number,local,connectionId,hosted)).toBe(true);
 expect(matchesImportedAccountNumber(number,local,randomUUID(),hosted)).toBe(false);
 expect(matchesImportedAccountNumber('different-account',local,connectionId,hosted)).toBe(false);
 expect(matchesImportedAccountNumber(number,local,connectionId,createHash('sha256').update(`${connectionId}:${local}`).digest('hex'))).toBe(false);
});
