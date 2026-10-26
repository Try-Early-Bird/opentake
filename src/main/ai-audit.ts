import { randomUUID } from 'node:crypto';
import type { DatabaseClient as PGlite } from './database-client';
import type { createDatabaseLifecycle } from './database';
import type { AiAuditPayloadStatus, AiAuditState } from '../shared/ai-audit';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
type Query = Pick<PGlite, 'query'>;
export interface AuditCapture {
 kind: string;
 payload: Record<string, unknown>;
 spanId?: string;
 status?: AiAuditPayloadStatus;
 note?: string;
 occurredAt?: string;
}
export type AuditSink = (event: AuditCapture) => Promise<void>;

// Defense in depth; adapters must also remove bound secret VALUES before calling
// the recorder. Never enumerate the user's credential inventory for redaction.
export function sanitizeAudit(payload: Record<string, unknown>) {
 let redacted = false;
 const serialized = JSON.stringify(payload, (key, value) => {
  if (/^(authorization|proxy.authorization|cookie|set.cookie|password|secret|token|access.?token|refresh.?token|api.?key|client.?secret|credential)$/i.test(key)) {
   redacted = true; return '[redacted]';
  }
  if (typeof value !== 'string') return value;
  const clean = value.replace(/sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+\/-]+/gi, '[redacted]');
  if (clean !== value) redacted = true;
  return clean;
 });
 return { serialized, redacted };
}

async function append(tx: Query, trace: string, run: string | null, event: AuditCapture) {
 const { serialized, redacted } = sanitizeAudit(event.payload);
 const status = redacted ? 'redacted' : event.status ?? 'captured';
 await tx.query(`INSERT INTO ai_audit_events(trace_id,run_id,span_id,kind,payload_status,payload,capture_note,occurred_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,clock_timestamp()))`, [trace,run,event.spanId??null,event.kind,status,serialized,
  redacted ? 'Credential fields or token patterns removed.' : event.note??null,event.occurredAt??null]);
}

export async function recordAiAudit(tx: Query, run: string, event: AuditCapture) {
 const row=(await tx.query<{trace_id:string}>('SELECT trace_id FROM ai_audit_runs WHERE id=$1',[run])).rows[0];
 if(row)await append(tx,row.trace_id,run,event);
}

export async function recoverAiAudits(db: Query, reason: 'host_restarted' | 'restored_backup') {
 const traces = (await db.query<{id:string}>("SELECT id FROM ai_audit_traces WHERE state='running' FOR UPDATE")).rows;
 for (const trace of traces) {
  const runs = (await db.query<{id:string}>("SELECT id FROM ai_audit_runs WHERE trace_id=$1 AND state='running'",[trace.id])).rows;
  for (const run of runs) {
   await append(db,trace.id,run.id,{kind:'run.finished',payload:{state:'interrupted',reason,outcomeKnown:false}});
  }
  await db.query("UPDATE ai_audit_runs SET state='interrupted',finished_at=clock_timestamp() WHERE trace_id=$1 AND state='running'",[trace.id]);
  await append(db,trace.id,null,{kind:'trace.finished',payload:{state:'interrupted',reason,outcomeKnown:false}});
  await db.query("UPDATE ai_audit_traces SET state='interrupted',capture_status='partial',finished_at=clock_timestamp() WHERE id=$1",[trace.id]);
 }
}

export function createAiAudit(db: Database) {
 return {
  async start(input: { runId?:string; feature:string; operation:string; sourceRef?:string; provider:string; model:string; adapter:string; adapterVersion:string; context:Record<string,unknown> }) {
   const trace = randomUUID(), run = input.runId ?? randomUUID();
   await db.use(d=>d.transaction(async tx=>{
    await tx.query(`INSERT INTO ai_audit_traces(id,owner_id,feature,operation,source_ref)
     SELECT $1,id,$2,$3,$4 FROM local_owners`,[trace,input.feature,input.operation,input.sourceRef??null]);
    await tx.query(`INSERT INTO ai_audit_runs(id,trace_id,provider,model,adapter,adapter_version)
     VALUES($1,$2,$3,$4,$5,$6)`,[run,trace,input.provider,input.model,input.adapter,input.adapterVersion]);
    await append(tx,trace,null,{kind:'trace.started',payload:{feature:input.feature,operation:input.operation}});
    await append(tx,trace,run,{kind:'run.started',payload:input.context});
   }));
   return {traceId:trace,runId:run};
  },
  // Missing rows are legacy/non-AI callers; capture never manufactures a trace.
  async record(run: string, event: AuditCapture) {
   await db.use(d=>d.transaction(tx=>recordAiAudit(tx,run,event)));
  },
  async finish(run: string, state: Exclude<AiAuditState,'running'>) {
   await db.use(d=>d.transaction(async tx=>{
    const row=(await tx.query<{trace_id:string;state:string}>('SELECT trace_id,state FROM ai_audit_runs WHERE id=$1 FOR UPDATE',[run])).rows[0];
    if(!row||row.state!=='running')return;
    await append(tx,row.trace_id,run,{kind:'run.finished',payload:{state}});
    await tx.query('UPDATE ai_audit_runs SET state=$2,finished_at=clock_timestamp() WHERE id=$1',[run,state]);
    await append(tx,row.trace_id,null,{kind:'trace.finished',payload:{state}});
    // Capture remains partial: the CLI does not expose exact wire requests and
    // may transform/compact the supplied context internally.
    await tx.query('UPDATE ai_audit_traces SET state=$2,finished_at=clock_timestamp() WHERE id=$1',[row.trace_id,state]);
   }));
  },
 };
}
