import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createAiAudit, recoverAiAudits } from '../../src/main/ai-audit';
import { migrate } from '../../src/main/migrations';

const input={feature:'search',operation:'answer',provider:'fixture',model:'fixture-model',adapter:'fixture',adapterVersion:'1',context:{instructions:'Synthetic instructions'}};

test('recorder retains ordered private evidence, redacts credentials and closes atomically',async()=>{
 const db=new PGlite();
 try {
  await migrate(db);const audit=createAiAudit({use:async fn=>fn(db)});
  const {traceId,runId}=await audit.start(input);
  await audit.record(runId,{kind:'model.request',payload:{messages:['Synthetic query'],headers:{Authorization:'synthetic-sensitive'},input:{password:'synthetic-password'},usage:{input_tokens:12}}});
  await audit.record(runId,{kind:'model.output',payload:{text:'Synthetic answer'},occurredAt:'2026-01-01T00:00:00Z'});
  await audit.finish(runId,'completed');await audit.finish(runId,'completed');
  const events=(await db.query<{kind:string;payload:unknown;payload_status:string;occurred_at:Date}>('SELECT kind,payload,payload_status,occurred_at FROM ai_audit_events WHERE trace_id=$1 ORDER BY sequence',[traceId])).rows;
  expect(events.map(e=>e.kind)).toEqual(['trace.started','run.started','model.request','model.output','run.finished','trace.finished']);
  expect(events[2]).toMatchObject({payload_status:'redacted',payload:{headers:{Authorization:'[redacted]'},input:{password:'[redacted]'},usage:{input_tokens:12}}});
  expect(JSON.stringify(events)).not.toContain('synthetic-sensitive');
  expect(events[3].occurred_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect((await db.query('SELECT state,capture_status FROM ai_audit_traces WHERE id=$1',[traceId])).rows).toEqual([{state:'completed',capture_status:'partial'}]);
 } finally {await db.close();}
});

for(const reason of ['host_restarted','restored_backup'] as const) {
 test(`recovery appends unknown-outcome evidence once (${reason})`,async()=>{
  const db=new PGlite();
  try {
   await migrate(db);const audit=createAiAudit({use:async fn=>fn(db)});
   const {traceId,runId}=await audit.start(input);
   await audit.record(runId,{kind:'tool.dispatch_intent',payload:{tool:'synthetic'}});
   await db.transaction(tx=>recoverAiAudits(tx,reason));
   const events=(await db.query('SELECT * FROM ai_audit_events WHERE trace_id=$1 ORDER BY sequence',[traceId])).rows;
   expect(events.at(-1)).toMatchObject({kind:'trace.finished',payload:{state:'interrupted',reason,outcomeKnown:false}});
   await db.transaction(tx=>recoverAiAudits(tx,reason));
   expect((await db.query('SELECT * FROM ai_audit_events WHERE trace_id=$1 ORDER BY sequence',[traceId])).rows).toEqual(events);
   expect((await db.query('SELECT state FROM ai_audit_runs WHERE id=$1',[runId])).rows).toEqual([{state:'interrupted'}]);
  }finally{await db.close();}
 });
}
