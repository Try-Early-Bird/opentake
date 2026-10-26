import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate, migrations } from '../../src/main/migrations';
import { createAiAudit } from '../../src/main/ai-audit';
import { getAiAuditRetention, setAiAuditRetention, pruneAiAudits } from '../../src/main/ai-audit-retention';
import { getJobRetention, setJobRetention } from '../../src/main/job-history';
import { createMaintenance } from '../../src/main/maintenance';
import type { createDatabaseLifecycle } from '../../src/main/database';

const day=86400000;
async function seed(db:PGlite,age:number,state:'completed'|'failed'|'cancelled'|'interrupted'|'running'='completed',now=Date.now()) {
 const audit=createAiAudit({use:async fn=>fn(db)});
 const ids=await audit.start({feature:'chat',operation:'respond',provider:'fixture',model:'fixture',adapter:'fixture',adapterVersion:'1',context:{input:'Synthetic input'}});
 if(state!=='running')await audit.finish(ids.runId,state);
 await db.query(`UPDATE ai_audit_traces SET started_at=$2,finished_at=CASE WHEN state='running' THEN NULL ELSE $2::timestamptz END WHERE id=$1`,[ids.traceId,new Date(now-age*day).toISOString()]);
 return ids;
}
const ids=async(db:PGlite)=>(await db.query<{id:string}>('SELECT id FROM ai_audit_traces')).rows.map(r=>r.id);

test('retention migration preserves existing audits and job setting, defaults to forever',async()=>{
 const db=new PGlite();try{
  await migrate(db,migrations.filter(m=>m.version<17));
  const audit=await seed(db,100);
  await setJobRetention(db,7);
  const ledger=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await migrate(db);await migrate(db);
  expect((await db.query('SELECT * FROM app_migrations WHERE version<17 ORDER BY version')).rows).toEqual(ledger);
  expect(await getAiAuditRetention(db)).toBeNull();expect(await getJobRetention(db)).toBe(7);
  await pruneAiAudits(db);expect(await ids(db)).toContain(audit.traceId);
 }finally{await db.close();}
});

test('expiration removes entire finished traces, protects active work and honors the completion boundary',async()=>{
 const db=new PGlite();try{
  await migrate(db);const now=Date.now();
  await db.query('UPDATE ai_audit_settings SET retention_days=30');
  const expired=await Promise.all((['completed','failed','cancelled','interrupted'] as const).map(state=>seed(db,31,state,now)));
  const boundary=await seed(db,30,'completed',now),recent=await seed(db,1,'completed',now),active=await seed(db,100,'running',now);
  const childActive=await seed(db,100,'completed',now);
  await db.query("UPDATE ai_audit_runs SET state='running',finished_at=NULL WHERE id=$1",[childActive.runId]);
  await pruneAiAudits(db,now);
  expect((await ids(db)).sort()).toEqual([boundary.traceId,recent.traceId,active.traceId,childActive.traceId].sort());
  for(const trace of expired){
   expect((await db.query('SELECT id FROM ai_audit_runs WHERE trace_id=$1',[trace.traceId])).rows).toEqual([]);
   expect((await db.query('SELECT id FROM ai_audit_events WHERE trace_id=$1',[trace.traceId])).rows).toEqual([]);
  }
 }finally{await db.close();}
});

test('saving prunes immediately and transaction failures leave retention and evidence unchanged',async()=>{
 const db=new PGlite();try{
  await migrate(db);const old=await seed(db,100);
  for(const invalid of [0,1,-7,31,'7',undefined])await expect(setAiAuditRetention(db,invalid)).rejects.toThrow();
  await db.exec(`CREATE FUNCTION reject_fixture_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$;
   CREATE TRIGGER reject_fixture_deletion BEFORE DELETE ON ai_audit_traces FOR EACH ROW EXECUTE FUNCTION reject_fixture_deletion();`);
  await expect(setAiAuditRetention(db,7)).rejects.toThrow('synthetic failure');
  expect(await getAiAuditRetention(db)).toBeNull();expect(await ids(db)).toContain(old.traceId);
  await db.exec('DROP TRIGGER reject_fixture_deletion ON ai_audit_traces');
  expect(await setAiAuditRetention(db,7)).toBe(7);expect(await ids(db)).not.toContain(old.traceId);
  expect(await setAiAuditRetention(db,null)).toBeNull();
  const kept=await seed(db,100);await pruneAiAudits(db);expect(await ids(db)).toContain(kept.traceId);
 }finally{await db.close();}
});

test('maintenance expires audits on startup and hourly without needing a connected account',async()=>{
 const db=new PGlite();let now=Date.now();
 const lifecycle={use:async<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)} as ReturnType<typeof createDatabaseLifecycle>;
 const maintenance=createMaintenance(lifecycle,{busy:()=>false,cancel:()=>{},refresh:async()=>{throw new Error('No account should be called');}},()=>false,()=>now);
 try{
  await migrate(db);await setAiAuditRetention(db,7);
  const old=await seed(db,8,'completed',now),later=await seed(db,7-0.5/24,'completed',now);
  await maintenance.start();expect(await ids(db)).not.toContain(old.traceId);expect(await ids(db)).toContain(later.traceId);
  now+=day/24;await maintenance.tick();expect(await ids(db)).not.toContain(later.traceId);
 }finally{await maintenance.stop();await db.close();}
});
