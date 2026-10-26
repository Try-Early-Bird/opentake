import type { DatabaseClient as PGlite } from './database-client';
import { z } from 'zod';

export async function getAiAuditRetention(db: PGlite): Promise<number | null> {
 return (await db.query<{days:number|null}>('SELECT retention_days AS days FROM ai_audit_settings WHERE singleton')).rows[0].days;
}

export async function pruneAiAudits(db: Pick<PGlite,'query'>, now=Date.now()): Promise<void> {
 // Delete whole traces so their ordered evidence is never partially expired.
 // A terminal trace with a still-running child is also protected.
 await db.query(`DELETE FROM ai_audit_traces t WHERE t.state <> 'running'
  AND t.finished_at < to_timestamp($1 / 1000.0) -
   (SELECT retention_days FROM ai_audit_settings WHERE singleton) * interval '1 day'
  AND NOT EXISTS (SELECT 1 FROM ai_audit_runs r WHERE r.trace_id=t.id AND r.state='running')`,[now]);
}

export async function setAiAuditRetention(db: PGlite, input: unknown): Promise<number | null> {
 const days=z.union([z.literal(7),z.literal(30),z.literal(90),z.null()]).parse(input);
 await db.transaction(async tx=>{
  await tx.query('UPDATE ai_audit_settings SET retention_days=$1 WHERE singleton',[days]);
  await pruneAiAudits(tx);
 });
 return days;
}
