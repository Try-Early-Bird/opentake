import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, migrations } from '../../src/main/migrations';

async function trace(db: PGlite, feature = 'search', source: string | null = null) {
 const id = randomUUID();
 await db.query(`INSERT INTO ai_audit_traces(id,owner_id,feature,operation,source_ref)
  SELECT $1,id,$2,'answer',$3 FROM local_owners`, [id,feature,source]);
 return id;
}
async function run(db: PGlite, traceId: string, parent: string | null = null) {
 const id = randomUUID();
 await db.query(`INSERT INTO ai_audit_runs(id,trace_id,parent_run_id,provider,model,adapter,adapter_version)
  VALUES($1,$2,$3,'synthetic','fixture-model','fixture','1')`, [id,traceId,parent]);
 return id;
}
async function event(db: PGlite, traceId: string, runId: string | null, payload = {}) {
 return (await db.query<{sequence:string}>(`INSERT INTO ai_audit_events(trace_id,run_id,kind,payload_status,payload)
  VALUES($1,$2,'model.request','captured',$3) RETURNING sequence::text`, [traceId,runId,JSON.stringify(payload)])).rows[0].sequence;
}

test('audit upgrade preserves existing take data and ledger without inventing historical traces', async () => {
 const db = new PGlite();
 try {
  await migrate(db,migrations.filter(m=>m.version<15));
  const take = randomUUID();
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Existing','{}' FROM local_owners",[take]);
  const ledger = (await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await migrate(db);
  expect((await db.query('SELECT * FROM app_migrations WHERE version<15 ORDER BY version')).rows).toEqual(ledger);
  expect((await db.query('SELECT title FROM takes WHERE id=$1',[take])).rows).toEqual([{title:'Existing'}]);
  expect((await db.query('SELECT * FROM ai_audit_traces')).rows).toEqual([]);
  await migrate(db);
 } finally { await db.close(); }
});

test('search and chat support ordered multi-run evidence independent of source lifetime', async () => {
 const db = new PGlite();
 try {
  await migrate(db);
  const take = randomUUID();
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Source','{}' FROM local_owners",[take]);
  const chat = await trace(db,'chat',take), search = await trace(db);
  const first = await run(db,search), second = await run(db,search,first);
  const request = {messages:[{role:'user',content:'Synthetic query'}],instructions:'Fixture instructions'};
  expect(await event(db,search,first,request)).toBe('1');
  expect(await event(db,search,second,{result:'Synthetic result'})).toBe('2');
  expect(await event(db,chat,null)).toBe('1');
  await db.query('DELETE FROM takes WHERE id=$1',[take]);
  expect((await db.query('SELECT payload FROM ai_audit_events WHERE trace_id=$1 ORDER BY sequence',[search])).rows[0]).toEqual({payload:request});
  expect((await db.query('SELECT source_ref FROM ai_audit_traces WHERE id=$1',[chat])).rows).toEqual([{source_ref:take}]);
  await db.query('DELETE FROM ai_audit_traces WHERE id=$1',[search]);
  expect((await db.query('SELECT * FROM ai_audit_runs WHERE trace_id=$1',[search])).rows).toEqual([]);
  expect((await db.query('SELECT * FROM ai_audit_events WHERE trace_id=$1',[search])).rows).toEqual([]);
 } finally { await db.close(); }
});

test('parallel appends are ordered and rejected events roll back their sequence allocation', async () => {
 const db = new PGlite();
 try {
  await migrate(db);
  const id = await trace(db), other = await trace(db), otherRun = await run(db,other);
  const numbers = await Promise.all(Array.from({length:8},()=>event(db,id,null)));
  expect(numbers.map(Number).sort((a,b)=>a-b)).toEqual([1,2,3,4,5,6,7,8]);
  await expect(event(db,id,otherRun)).rejects.toThrow();
  await expect(run(db,id,otherRun)).rejects.toThrow();
  expect(await event(db,id,null)).toBe('9');
  await expect(db.query(`INSERT INTO ai_audit_events(trace_id,parent_sequence,kind,payload_status,payload)
   VALUES($1,999,'tool.result','captured','{}')`,[id])).rejects.toThrow();
  expect(await event(db,id,null)).toBe('10');
 } finally { await db.close(); }
});

test('causal links, immutable evidence, capture gaps and terminal state constraints', async () => {
 const db = new PGlite();
 try {
  await migrate(db);
  const id = await trace(db), span = randomUUID();
  await event(db,id,null);
  await db.query(`INSERT INTO ai_audit_events(trace_id,parent_sequence,span_id,kind,payload_status,payload,capture_note)
   VALUES($1,1,$2,'capture.gap','unavailable','{}','Provider did not expose usage')`,[id,span]);
  await expect(db.query("UPDATE ai_audit_events SET payload='{}' WHERE trace_id=$1",[id])).rejects.toThrow('append-only');
  await expect(db.query(`INSERT INTO ai_audit_events(trace_id,kind,payload_status,payload)
   VALUES($1,'capture.gap','omitted','{}')`,[id])).rejects.toThrow();
  await expect(db.query("UPDATE ai_audit_traces SET state='completed' WHERE id=$1",[id])).rejects.toThrow();
  await db.query("UPDATE ai_audit_traces SET state='interrupted',finished_at=clock_timestamp() WHERE id=$1",[id]);
  expect((await db.query('SELECT state,capture_status,last_sequence::text FROM ai_audit_traces WHERE id=$1',[id])).rows)
   .toEqual([{state:'interrupted',capture_status:'partial',last_sequence:'2'}]);
 } finally { await db.close(); }
});
