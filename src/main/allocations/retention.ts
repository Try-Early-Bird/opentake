import type { DatabaseClient as PGlite } from '../database-client';

/** Settings choices: 90 days, a year (the Portfolio 1Y chart's span) or forever. */
export const FINANCIAL_RETENTION_CHOICES=[90,366,null] as const;
export async function getFinancialRetention(db:Pick<PGlite,'query'>):Promise<number|null>{
 return (await db.query<{retention_days:number|null}>('SELECT retention_days FROM financial_history_settings WHERE singleton')).rows[0].retention_days;
}
export async function setFinancialRetention(db:PGlite,days:number|null) {
 if(days!==null&&(!Number.isInteger(days)||days<1||days>3650))throw new Error('Retention must be 1–3650 days or unlimited');
 await db.query('UPDATE financial_history_settings SET retention_days=$1 WHERE singleton',[days]);
}
/** The Settings control: one of the offered choices, applied (and pruned) immediately. */
export async function chooseFinancialRetention(db:PGlite,input:unknown):Promise<number|null>{
 if(!FINANCIAL_RETENTION_CHOICES.includes(input as never))throw new Error('Choose 90 days, 1 year or forever');
 await setFinancialRetention(db,input as number|null);
 await pruneFinancialObservations(db);
 return getFinancialRetention(db);
}
// Pruning runs with the background host's hourly cleanup (maintenance.ts).
// Deliberately conservative: pending reinvestments and open cases pin the entire
// account history, and unreleased allocations keep observations since inception.
export async function pruneFinancialObservations(db:PGlite,now=Date.now()) {
 return db.transaction(async tx=>{
  const days=(await tx.query<{retention_days:number|null}>('SELECT retention_days FROM financial_history_settings WHERE singleton')).rows[0].retention_days;
  if(days===null)return {observations:0};
  const cutoff=new Date(now-days*86400000).toISOString();
  const result=await tx.query<{id:string}>(`DELETE FROM account_observations o WHERE o.observed_at<$1
   AND NOT EXISTS(SELECT 1 FROM strategy_evidence_pins p WHERE p.observation_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM strategy_reconciliation_cases c WHERE c.account_id=o.account_id AND c.resolved_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM account_executions e WHERE e.account_id=o.account_id AND e.attribution_state<>'completed' AND e.data->>'origin'='drip')
   AND o.id<>(SELECT latest.id FROM account_observations latest WHERE latest.account_id=o.account_id AND latest.resource=o.resource AND latest.observed_at<=$1 ORDER BY latest.observed_at DESC,latest.id LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM strategy_allocations a WHERE a.account_id=o.account_id AND a.status IN ('active','paused','diverged')
    AND (o.observed_at>=a.created_at OR o.id=(SELECT before.id FROM account_observations before
      WHERE before.account_id=o.account_id AND before.resource=o.resource AND before.observed_at<=a.created_at
      ORDER BY before.observed_at DESC,before.id LIMIT 1))) RETURNING o.id`,[cutoff]);
  await tx.query(`DELETE FROM position_snapshots s WHERE NOT EXISTS(SELECT 1 FROM account_observations o WHERE o.position_snapshot_id=s.id)`);
  await tx.query(`DELETE FROM portfolio_snapshots s WHERE NOT EXISTS(SELECT 1 FROM account_observations o WHERE o.portfolio_snapshot_id=s.id)`);
  await tx.query(`DELETE FROM account_sync_runs r WHERE r.finished_at<$1 AND r.state<>'running'
   AND NOT EXISTS(SELECT 1 FROM account_observations o WHERE o.run_id=r.id)
   AND r.id IS DISTINCT FROM (SELECT latest.id FROM account_sync_runs latest WHERE latest.account_id=r.account_id AND latest.resource=r.resource ORDER BY started_at DESC LIMIT 1)
   AND r.id IS DISTINCT FROM (SELECT latest.id FROM account_sync_runs latest WHERE latest.account_id=r.account_id AND latest.resource=r.resource AND latest.state='completed' ORDER BY finished_at DESC LIMIT 1)`,[cutoff]);
  await tx.query(`DELETE FROM account_sync_gaps g WHERE g.to_at<$1
   AND NOT EXISTS(SELECT 1 FROM strategy_allocations a WHERE a.account_id=g.account_id AND a.status IN ('active','paused','diverged'))
   AND NOT EXISTS(SELECT 1 FROM strategy_reconciliation_cases c WHERE c.account_id=g.account_id AND c.resolved_at IS NULL)`,[cutoff]);
  const coinbase=await tx.query<{id:string}>(`DELETE FROM coinbase_portfolio_observations o WHERE observed_at<$1
   AND id<>(SELECT latest.id FROM coinbase_portfolio_observations latest WHERE latest.account_id=o.account_id AND latest.observed_at<$1 ORDER BY latest.observed_at DESC,latest.id DESC LIMIT 1) RETURNING id`,[cutoff]);
  const valuations=await tx.query('DELETE FROM coinbase_valuation_snapshots WHERE bucket<$1 RETURNING account_id',[cutoff]);
  return {observations:result.rows.length+coinbase.rows.length+valuations.rows.length};
 });
}
