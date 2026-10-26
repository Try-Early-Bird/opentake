import { accountSyncInterval } from './account-sync/cadence';
import { pruneJobHistory } from './job-history';
import { pruneAiAudits } from './ai-audit-retention';
import { pruneFinancialObservations } from './allocations/retention';
import type { createDatabaseLifecycle } from './database';
import type { createConnections } from './connections';
import type { ActivityJob } from '../shared/activity';
import { connectionFailure } from './connection-errors';

// One worker owns all queue transitions. Jobs never contain tokens or account numbers.
export function createMaintenance(database: ReturnType<typeof createDatabaseLifecycle>, connections: Pick<ReturnType<typeof createConnections>, 'refresh' | 'busy' | 'cancel'>,
  unavailable: () => boolean, now = () => Date.now(), random = Math.random, portfolio?: { synchronize(): Promise<void>; start(): Promise<void>; cancel(): void; engaged(): boolean; continuous?():Promise<boolean> }, options: { externalPolling?: boolean; portfolioBackgroundAllowed?():Promise<boolean> } = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let working: Promise<void> | undefined;
  let paused = false;
  let stopped = false;
  let lastPrunedAt = 0;
  const use = database.use;
  async function prune() {
    const timestamp=now();
    await use(db=>db.transaction(async tx=>{await pruneJobHistory(tx,timestamp);await pruneAiAudits(tx,timestamp);}));
    // Account history beyond the retention setting; evidence strategies still need is kept.
    await use(db=>pruneFinancialObservations(db,timestamp));
    lastPrunedAt=timestamp;
  }
  async function enqueue(reason: string, force = false) {
    await use(db => db.query(`INSERT INTO background_jobs(connection_id, kind, state, reason)
      SELECT c.id, 'account_sync', 'pending', $1 FROM platform_connections c
      WHERE c.venue='robinhood' AND c.maintenance_enabled AND c.credential_ref IS NOT NULL
      AND ($2 OR c.checked_at IS NULL OR c.checked_at < to_timestamp($3 / 1000.0) - interval '5 minutes')
      AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.connection_id = c.id AND j.kind='account_sync' AND j.state IN ('failed','needs_attention'))
      ON CONFLICT DO NOTHING`, [reason, force, now()]));
  }
  async function enqueuePortfolio(reason: string, force = false) {
    if (!portfolio) return;
    const open = await use(async db => (await db.query("SELECT 1 FROM account_orders o JOIN linked_accounts a ON a.id=o.account_id WHERE a.selected AND a.available AND NOT o.terminal LIMIT 1")).rows.length > 0);
    // An order sent in the last two minutes is learned about only from the next read (the executor does
    // not poll it), so read every few seconds until it settles instead of waiting out the cadence.
    const sending = await use(async db => (await db.query(`SELECT 1 FROM strategy_executions WHERE status IN ('submitting','submitted','partially_filled')
      AND coalesce(submitted_at,updated_at) > to_timestamp($1::double precision/1000.0) - interval '2 minutes' LIMIT 1`, [now()])).rows.length > 0);
    const continuous = await portfolio.continuous?.() ?? false;
    const interval = accountSyncInterval(now(), portfolio.engaged() || (!continuous && open), sending, continuous);
    await use(db => db.query(`INSERT INTO background_jobs(connection_id,kind,state,reason)
      SELECT c.id,'portfolio_sync','pending',$1 FROM platform_connections c
      WHERE c.venue='robinhood' AND c.status='connected' AND c.maintenance_enabled AND c.credential_ref IS NOT NULL
      AND EXISTS(SELECT 1 FROM linked_accounts a WHERE a.connection_id=c.id AND a.available AND a.selected AND a.agentic_allowed)
      AND NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.connection_id=c.id AND j.kind='portfolio_sync' AND j.state IN ('failed','needs_attention'))
      AND ($2 OR NOT EXISTS(SELECT 1 FROM account_sync_runs r JOIN linked_accounts a ON a.id=r.account_id WHERE a.connection_id=c.id AND a.selected AND r.started_at>to_timestamp(($3::double precision-$4::double precision)/1000.0)))
      ON CONFLICT DO NOTHING`, [reason,force,now(),interval]));
  }

  async function cycle() {
    if (stopped || paused || unavailable()) return;
    if (now() - lastPrunedAt >= 60 * 60_000) {
      await prune();
    }
    await enqueue('scheduled');
    const portfolioAllowed=await options.portfolioBackgroundAllowed?.()??true;
    if(portfolioAllowed)await enqueuePortfolio('scheduled');
    const job = await use(async db => (await db.query<{ id: string; attempts: number; kind: string }>(`UPDATE background_jobs SET state = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = (SELECT j.id FROM background_jobs j JOIN platform_connections c ON c.id = j.connection_id
        WHERE j.state IN ('pending','retrying') AND j.next_run_at <= to_timestamp($1 / 1000.0) AND c.maintenance_enabled
        AND (j.kind<>'portfolio_sync' OR $2 OR j.reason='manual')
        ORDER BY j.next_run_at LIMIT 1)
      RETURNING id, attempts, kind`, [now(),portfolioAllowed])).rows[0]);
    if (!job) return;
    try {
      if (job.kind === 'portfolio_sync') await portfolio!.synchronize();
      else await connections.refresh();
      await use(db => db.query("UPDATE background_jobs SET state = 'completed', error_code = NULL, updated_at = now() WHERE id = $1", [job.id]));
    } catch (error) {
      const code = connectionFailure(error).code;
      const state = code === 'reauth_required' || code === 'storage_locked' ? 'needs_attention' : job.attempts >= 5 ? 'failed' : 'retrying';
      const delay = Math.min(300_000, 5_000 * 2 ** (job.attempts - 1)) * (0.8 + random() * 0.4);
      await use(db => db.query(`UPDATE background_jobs SET state = $2, error_code = $3,
        updated_at = now(), next_run_at = to_timestamp($4 / 1000.0) WHERE id = $1`, [job.id, state, code, now() + delay]));
    }

  }
  function tick(): Promise<void> {
    if (working) return working;
    working = cycle().finally(() => { working = undefined; });
    return working;
  }
  function schedule() {
    if (stopped || options.externalPolling) return;
    timer = setTimeout(() => { void tick().catch(() => {}).finally(schedule); }, 5000);
  }
  return {
    tick,
    cancel() { portfolio?.cancel(); connections.cancel(); },
    async start() {
      // Only idempotent read jobs exist. Interrupted reads can safely be retried.
      await use(db => db.exec("UPDATE background_jobs SET state = 'pending', error_code = 'host_restarted', updated_at = now() WHERE state = 'running'"));
      await prune();
      await portfolio?.start();
      await enqueue('startup', true); await enqueuePortfolio('startup', true); schedule();
    },
    async request() {
      await use(db => db.exec(`UPDATE background_jobs j SET state = 'pending', attempts = 0, error_code = NULL, next_run_at = now(), updated_at = now()
        WHERE j.state IN ('failed','needs_attention')
        AND EXISTS (SELECT 1 FROM platform_connections c WHERE c.id = j.connection_id AND c.maintenance_enabled)
        AND NOT EXISTS (SELECT 1 FROM background_jobs other WHERE other.connection_id = j.connection_id AND other.kind = j.kind AND other.state IN ('pending','running','retrying'))`));
      await enqueue('manual', true); await enqueuePortfolio('manual', true);
    },
    async wake() {
      paused = false;
      if (stopped || unavailable()) return;
      await use(db => db.exec(`UPDATE background_jobs j SET state = 'pending', attempts = 0, next_run_at = now(), updated_at = now()
        WHERE j.state = 'failed' AND j.error_code IN ('transient','cancelled')
        AND EXISTS (SELECT 1 FROM platform_connections c WHERE c.id = j.connection_id AND c.maintenance_enabled)
        AND NOT EXISTS (SELECT 1 FROM background_jobs other WHERE other.connection_id = j.connection_id AND other.kind = j.kind AND other.state IN ('pending','running','retrying'))`));
      await enqueue('resume', true); await enqueuePortfolio('resume', true);
      // Resume/network recovery coalesces into one active job, not missed intervals.
      await use(db => db.exec("UPDATE background_jobs SET next_run_at = now() WHERE state = 'retrying'"));
      await tick();
    },
    suspend() { paused = true; portfolio?.cancel(); connections.cancel(); },
    async settled() { await working; },
    async stop() { stopped = true; clearTimeout(timer); portfolio?.cancel(); connections.cancel(); await working; },
    async list(): Promise<ActivityJob[]> {
      return use(async db => (await db.query<ActivityJob>(`SELECT id, kind, state, attempts, reason,
        error_code AS "errorCode", updated_at::text AS "updatedAt", next_run_at::text AS "nextRunAt"
        FROM background_jobs ORDER BY CASE WHEN state IN ('needs_attention','failed') THEN 0 WHEN state IN ('pending','running','retrying') THEN 1 ELSE 2 END,
        updated_at DESC LIMIT 100`)).rows);
    },
    async retry(id: unknown) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job');
      await use(db => db.query(`UPDATE background_jobs j SET state = 'pending', attempts = 0, error_code = NULL, next_run_at = now(), updated_at = now()
        WHERE j.id = $1 AND j.state IN ('failed','needs_attention')
        AND EXISTS (SELECT 1 FROM platform_connections c WHERE c.id = j.connection_id AND c.maintenance_enabled)
        AND NOT EXISTS (SELECT 1 FROM background_jobs other WHERE other.connection_id = j.connection_id AND other.kind = j.kind AND other.state IN ('pending','running','retrying'))`, [id]));
    },
    async reconnected() {
      await use(db => db.exec("UPDATE background_jobs SET state = 'cancelled', error_code = NULL, updated_at = now() WHERE state IN ('failed','needs_attention')"));
    },
  };
}
