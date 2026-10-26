import { test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate,migrations } from '../../../src/main/migrations';
test('approval migration expires old pending and approved decisions while preserving earlier migration checksums',async()=>{
 const db=new PGlite();try{
  await migrate(db,migrations.filter(m=>m.version<8));const before=(await db.query('SELECT version,checksum FROM app_migrations ORDER BY version')).rows;
  const take=randomUUID();const run=randomUUID();await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Test','{}' FROM local_owners",[take]);await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,take,randomUUID()]);
  for(const state of ['pending','approved','consumed'])await db.query("INSERT INTO tool_approvals(id,run_id,server_id,tool_name,input,fingerprint,state) VALUES($1,$2,$3,'fixture','{}','hash',$4)",[randomUUID(),run,randomUUID(),state]);
  await migrate(db);const rows=(await db.query<{state:string;expires_at:Date}>('SELECT state,expires_at FROM tool_approvals')).rows;
  expect(rows.filter(r=>r.state==='expired')).toHaveLength(2);expect(rows.filter(r=>r.state==='consumed')).toHaveLength(1);expect(rows.every(r=>r.expires_at)).toBe(true);expect((await db.query('SELECT version,checksum FROM app_migrations WHERE version<8 ORDER BY version')).rows).toEqual(before);
 }finally{await db.close();}
});
