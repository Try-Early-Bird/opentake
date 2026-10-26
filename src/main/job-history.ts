import type { DatabaseClient as PGlite } from './database-client';
import type { ActivityJob, JobDetails, JobEvent, JobHistoryPage } from '../shared/activity';
import { z } from 'zod';

// Preserve PostgreSQL's microseconds in the cursor; converting to a JS Date
// would lose precision and could skip jobs at page boundaries.
const cursorSchema = z.object({
  updatedAt: z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/)
    .refine(value => Number.isFinite(Date.parse(value))),
  id: z.union([z.string().uuid(), z.string().regex(/^trade:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]),
});
const pageSize = 50;

export async function readJobHistory(db: PGlite, input?: unknown): Promise<JobHistoryPage> {
  const cursor = input == null ? undefined : cursorSchema.parse(input);
  // Read terminal order legs directly: queued/partially filled/unknown orders
  // must never look completed, and viewing history must not mutate the ledger.
  const { rows } = await db.query<ActivityJob>(`WITH history AS (
    SELECT id::text, kind, state, attempts, reason, error_code,
      updated_at, next_run_at, NULL::jsonb AS execution
    FROM background_jobs WHERE state IN ('completed','cancelled','failed')
    UNION ALL
    SELECT 'trade:' || e.id::text, e.kind,
      CASE e.status WHEN 'filled' THEN 'completed' ELSE e.status END,
      0, coalesce(e.trigger,''), e.failure_code,
      coalesce(e.terminal_at,e.updated_at), coalesce(e.terminal_at,e.updated_at),
      jsonb_build_object('strategyId',e.strategy_id,'strategyTitle',coalesce(v.metadata->>'title','Take'),
        'symbol',e.symbol,'side',e.side,'status',e.status)
    FROM strategy_executions e
    LEFT JOIN strategy_versions v ON v.id=e.version_id
    WHERE e.status IN ('filled','failed','cancelled')
  ) SELECT id,kind,state,attempts,reason,error_code AS "errorCode",
    updated_at::text AS "updatedAt",next_run_at::text AS "nextRunAt",execution
    FROM history
    WHERE ($1::timestamptz IS NULL OR (updated_at,id COLLATE "C") < ($1::timestamptz,$2::text COLLATE "C"))
    ORDER BY updated_at DESC,id COLLATE "C" DESC LIMIT $3`, [cursor?.updatedAt ?? null, cursor?.id ?? null, pageSize + 1]);
  const jobs = rows.slice(0, pageSize);
  const last = jobs.at(-1);
  return { jobs, nextCursor: rows.length > pageSize && last ? { updatedAt: last.updatedAt, id: last.id } : null };
}

export async function readJobDetails(db: PGlite, input: unknown): Promise<JobDetails | null> {
  const id = z.string().uuid().parse(input);
  return db.transaction(async tx => {
    const job = (await tx.query<JobDetails['job']>(`SELECT id, kind, state, attempts, reason,
      error_code AS "errorCode", created_at::text AS "createdAt", updated_at::text AS "updatedAt",
      next_run_at::text AS "nextRunAt" FROM background_jobs WHERE id = $1`, [id])).rows[0];
    if (!job) return null;
    const events = (await tx.query<JobEvent>(`SELECT id::text, state, attempts, error_code AS "errorCode",
      occurred_at::text AS "occurredAt", next_run_at::text AS "nextRunAt"
      FROM job_events WHERE job_id = $1 ORDER BY id DESC LIMIT 201`, [id])).rows;
    return { job, events: events.slice(0, 200).reverse(), truncated: events.length > 200 };
  });
}

export async function getJobRetention(db: PGlite): Promise<number | null> {
  return (await db.query<{ days: number | null }>('SELECT retention_days AS days FROM job_history_settings WHERE singleton')).rows[0].days;
}

export async function pruneJobHistory(db: Pick<PGlite, 'query'>, now = Date.now()): Promise<void> {
  // Failed/attention jobs still control retry behavior and must be resolved first.
  await db.query(`DELETE FROM background_jobs WHERE state IN ('completed','cancelled')
    AND updated_at < to_timestamp($1 / 1000.0) -
      (SELECT retention_days FROM job_history_settings WHERE singleton) * interval '1 day'`, [now]);
}

export async function setJobRetention(db: PGlite, input: unknown): Promise<number | null> {
  const days = z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]).parse(input);
  await db.transaction(async tx => {
    await tx.query('UPDATE job_history_settings SET retention_days = $1 WHERE singleton', [days]);
    await pruneJobHistory(tx);
  });
  return days;
}
