import { test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate,migrations,prepareRestoredDatabase } from '../../../src/main/migrations';
import { createToolGovernance } from '../../../src/main/tool-governance';
test('tool governance migration preserves reviewed tool policies and restores interrupted audit records',async()=>{
 const db=new PGlite();try{
  await migrate(db,migrations.filter(m=>m.version<12));const checksums=(await db.query('SELECT version,checksum FROM app_migrations ORDER BY version')).rows;
  const server=randomUUID();const take=randomUUID();const run=randomUUID();
  await db.query('INSERT INTO mcp_servers(id,config,enabled) VALUES($1,$2,true)',[server,JSON.stringify({name:'Synthetic'})]);
  await db.query("INSERT INTO mcp_tools(server_id,name,definition,fingerprint,policy) VALUES($1,'fixture','{}','synthetic','blocked')",[server]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Synthetic','{}' FROM local_owners",[take]);
  await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,take,randomUUID()]);
  await migrate(db);expect((await db.query('SELECT version,checksum FROM app_migrations WHERE version<12 ORDER BY version')).rows).toEqual(checksums);
  expect((await db.query<{policy:string}>('SELECT policy FROM mcp_tools')).rows[0].policy).toBe('blocked');expect((await db.query<{policy:string}>('SELECT policy FROM mcp_servers')).rows[0].policy).toBe('allowed');
  const audit=createToolGovernance({use:async fn=>fn(db)});const call=await audit.begin(run,'fixture');await call.dispatch();await prepareRestoredDatabase(db);
  const item=(await audit.history({takeId:take})).items[0];expect(item.state).toBe('interrupted');expect(item.detail).toContain('outcome may be unknown');expect(item.finished_at).not.toBeNull();
  await db.query('DELETE FROM mcp_servers WHERE id=$1',[server]);expect((await audit.history({takeId:take})).items).toHaveLength(1);
 }finally{await db.close();}
});
