// Read-only status of the development profile for live checks (Plan 11).
// Copies only the profile's database folder to a temporary directory and reads
// the copy, never the running host's files; secrets/, host.json and the keychain
// are never touched. Usage: node scripts/dev-live-status.mjs [--since=ISO] [--profile=DIR]
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = arg('profile') ?? join(homedir(), 'Library/Application Support/earlybird-oss-development');
const since = arg('since') ?? new Date(Date.now() - 24 * 3600_000).toISOString();
const copy = mkdtempSync(join(tmpdir(), 'opentake-live-status-'));
cpSync(join(profile, 'database'), copy, { recursive: true });
rmSync(join(copy, 'postmaster.pid'), { force: true });
const db = new PGlite(copy);
const et = value => value === null ? '—' : new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const title = `(SELECT v.metadata->>'title' FROM strategies s LEFT JOIN strategy_versions v ON v.id=s.current_version_id WHERE s.id=a.strategy_id)`;
const section = (name, rows) => { console.log(`\n== ${name}`); if (!rows.length) console.log('(none)'); else console.table(rows); };
try {
  console.log(`Profile copy taken ${et(Date.now())} ET; events since ${et(since)} ET`);
  section('Takes with money', (await db.query(`SELECT ${title} AS take,a.status,v.spec->'rebalance'->>'schedule' AS schedule,
     coalesce(v.spec->'rebalance'->>'driftBandPoints','-')||' pt / '||coalesce(v.spec->'rebalance'->>'driftBandRelative','-')||'%' AS bands,
     a.applied_version_sequence||'/'||v.sequence AS applied,a.last_rebalanced_on::text AS rebalanced,a.last_drift_check_on::text AS drift_checked,
     a.planning_reason_code AS reason,a.planning_deferred_until AS deferred_until
    FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id LEFT JOIN strategy_versions v ON v.id=s.current_version_id
    WHERE a.status IN ('active','paused','diverged') ORDER BY 1`)).rows.map(r => ({ ...r, deferred_until: r.deferred_until && et(r.deferred_until) })));
  section('Plans', (await db.query(`SELECT ${title} AS take,p.trigger,p.disposition,p.reason_code AS reason,p.created_at AS at
    FROM strategy_execution_plans p JOIN strategy_allocations a ON a.id=p.allocation_id WHERE p.created_at>$1 ORDER BY p.created_at`, [since])).rows.map(r => ({ ...r, at: et(r.at) })));
  section('Orders (legs)', (await db.query(`SELECT ${title} AS take,e.kind,e.trigger,e.side,e.symbol,e.status,e.failure_code AS failure,e.created_at,e.submitted_at,e.terminal_at
    FROM strategy_executions e JOIN strategy_allocations a ON a.id=e.allocation_id WHERE e.created_at>$1 OR e.status NOT IN ('filled','failed','cancelled') ORDER BY e.created_at`, [since])).rows
    .map(r => ({ ...r, created_at: et(r.created_at), submitted_at: et(r.submitted_at), terminal_at: et(r.terminal_at) })));
  section('Account reads (latest per resource)', (await db.query(`SELECT DISTINCT ON (resource) resource,state,started_at,finished_at,error_code
    FROM account_sync_runs ORDER BY resource,started_at DESC`)).rows.map(r => ({ ...r, started_at: et(r.started_at), finished_at: et(r.finished_at) })));
  // One row per outage: every resource records its own gap for the same stretch.
  section('Watching gaps', (await db.query(`SELECT reason,min(from_at) AS from_at,max(to_at) AS to_at,round(extract(epoch FROM max(to_at)-min(from_at))/60)::int AS minutes,count(*)::int AS resources
    FROM account_sync_gaps WHERE to_at>$1 GROUP BY reason,date_trunc('minute',from_at) ORDER BY 2`, [since])).rows
    .map(r => ({ ...r, from_at: et(r.from_at), to_at: et(r.to_at) })));
  section('Quotes', (await db.query(`SELECT count(*)::int AS symbols,max(observed_at) AS newest FROM market_quotes`)).rows.map(r => ({ ...r, newest: et(r.newest) })));
  section('Notifications', (await db.query(`SELECT payload->>'kind' AS kind,payload->>'title' AS title,created_at,resolved_at FROM notifications WHERE created_at>$1 AND NOT pruned ORDER BY created_at`, [since])).rows
    .map(r => ({ ...r, created_at: et(r.created_at), resolved_at: et(r.resolved_at) })));
} finally {
  await db.close();
  rmSync(copy, { recursive: true, force: true });
}
