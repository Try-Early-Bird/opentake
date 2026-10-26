export const executionReliabilityMigration = {version:44,name:'Execution notional evidence and background query indexes',sql:`
ALTER TABLE strategy_executions ADD COLUMN planned_notional numeric CHECK (planned_notional >= 0);
UPDATE strategy_executions SET planned_notional=(order_request->>'dollar_amount')::numeric WHERE order_request->>'dollar_amount' IS NOT NULL;
CREATE INDEX account_sync_runs_latest ON account_sync_runs(account_id,resource,started_at DESC);
CREATE INDEX account_sync_runs_success ON account_sync_runs(account_id,resource,finished_at DESC) WHERE state='completed';
CREATE INDEX account_executions_pending ON account_executions(account_id,occurred_at,provider_ref) WHERE attribution_state<>'completed';
CREATE INDEX strategy_executions_daily ON strategy_executions(allocation_id,created_at) WHERE status NOT IN ('cancelled','failed');
`};
