import { test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate,migrations } from '../../../src/main/migrations';

test('take integrity migration upgrades existing instructions and equal-time messages without changing earlier history',async()=>{
 const db=new PGlite();try{
  await migrate(db,migrations.filter(m=>m.version<6));
  const before=await db.query('SELECT version,checksum FROM app_migrations ORDER BY version');
  const take=randomUUID();const user=randomUUID();const reply=randomUUID();
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Existing','{}' FROM local_owners",[take]);
  await db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,NULL,$3),($4,$2,$1,$5)',[user,take,JSON.stringify({role:'user',createdAt:'2026-01-01',images:[]}),reply,JSON.stringify({role:'assistant',createdAt:'2026-01-01',images:[]})]);
  await db.query("INSERT INTO ai_instruction_revisions(id,text) VALUES($1,'User override')",[randomUUID()]);
  await migrate(db);
  expect((await db.query('SELECT version,checksum FROM app_migrations WHERE version<6 ORDER BY version')).rows).toEqual(before.rows);
  expect((await db.query('SELECT id FROM take_messages ORDER BY sequence')).rows).toEqual([{id:user},{id:reply}]);
  expect((await db.query('SELECT text,mode FROM ai_instruction_revisions')).rows).toEqual([{text:'User override',mode:'custom'}]);
  await migrate(db);
 }finally{await db.close();}
});
