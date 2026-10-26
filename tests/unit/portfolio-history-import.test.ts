import { expect,test } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseLifecycle } from '../../src/main/database';
import { createAccountSync } from '../../src/main/account-sync/service';
import { importPortfolioHistory,createPortfolioHistoryImport } from '../../src/main/account-sync/history-import';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'portfolio-import-test-'));
 const db=createDatabaseLifecycle(join(root,'database'));await db.start();
 const connection=(await db.use(d=>d.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`))).rows[0].id;
 const id=(await db.use(d=>d.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-account','••••1234',true,true) RETURNING id`,[connection]))).rows[0].id;
 const sourceConnection=randomUUID();
 const input={format:'opentake-portfolio-history-v1',exportedAt:'2026-10-02T15:00:00Z',source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-account`).digest('hex')},observations:[{id:randomUUID(),observedAt:'2026-09-01T15:00:00Z',totalValue:'990.123456789012345678',cash:'90',buyingPower:'90',currency:'USD'}]};
 const now=Date.parse('2026-10-02T15:00:00Z');
 const sync=createAccountSync(db,{status:async()=>({status:'connected',checkedAt:null,accounts:[{id,maskedNumber:'••••1234',nickname:null,accountType:null,agenticAllowed:true,selected:true}]}),readTool:async name=>name==='get_portfolio'?{total_value:'1000',cash:'100',buying_power:'100'}:{results:[]}},()=>now);
 return {root,db,id,input,sync,now,close:async()=>{await db.close();await rm(root,{recursive:true,force:true});}};
}
test('imports exact historical values idempotently without changing live balances, positions or checkpoints',async()=>{
 const f=await fixture();try{
  await f.sync.synchronize();
  const checkpoints=await f.db.use(d=>d.query('SELECT * FROM account_sync_checkpoints ORDER BY resource'));
  expect(await importPortfolioHistory(f.db,f.input,undefined,f.now)).toEqual({imported:1,skipped:0});
  expect(await importPortfolioHistory(f.db,f.input,undefined,f.now)).toEqual({imported:0,skipped:1});
  const view=await f.sync.snapshot();
  expect(view.history[0]).toMatchObject({totalValue:'990.123456789012345678',observedAt:'2026-09-01T15:00:00.000Z'});
  expect(view.portfolio?.totalValue).toBe('1000');expect(view.positions).toEqual([]);
  expect((await f.db.use(d=>d.query('SELECT * FROM account_sync_checkpoints ORDER BY resource'))).rows).toEqual(checkpoints.rows);
 }finally{await f.close();}
});
test('wrong account, future data, unknown fields and changed source values fail without partial writes',async()=>{
 const f=await fixture();try{
  await expect(importPortfolioHistory(f.db,{...f.input,source:{...f.input.source,accountRefHash:'0'.repeat(64)}},undefined,f.now)).rejects.toThrow('does not match');
  await expect(importPortfolioHistory(f.db,{...f.input,exportedAt:'2030-01-01T00:00:00Z'},undefined,f.now)).rejects.toThrow('future');
  await expect(importPortfolioHistory(f.db,{...f.input,credentials:'forbidden'},undefined,f.now)).rejects.toThrow('Invalid');
  await importPortfolioHistory(f.db,f.input,undefined,f.now);
  const changed=structuredClone(f.input);changed.observations[0].totalValue='123';changed.observations.push({...changed.observations[0],id:randomUUID()});
  await expect(importPortfolioHistory(f.db,changed,undefined,f.now)).rejects.toThrow('changed');
  expect((await f.db.use(d=>d.query('SELECT * FROM portfolio_history_imports'))).rows).toHaveLength(1);
 }finally{await f.close();}
});
test('preview binds the reviewed bytes and selected account and commit tokens are single use',async()=>{
 const f=await fixture();try{
  const file=join(f.root,'history.json');await writeFile(file,JSON.stringify(f.input));
  const importer=createPortfolioHistoryImport(f.db);const preview=await importer.prepare(file);
  expect(preview.count).toBe(1);await writeFile(file,'{}');
  expect(await importer.commit(preview.token)).toEqual({imported:1,skipped:0});
  await expect(importer.commit(preview.token)).rejects.toThrow('expired');
  await writeFile(file,JSON.stringify(f.input));const next=await importer.prepare(file);
  await f.db.use(d=>d.query('UPDATE linked_accounts SET selected=false WHERE id=$1',[f.id]));
  await expect(importer.commit(next.token)).rejects.toThrow('does not match');
 }finally{await f.close();}
});
