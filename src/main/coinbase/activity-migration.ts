export const coinbaseActivityMigration = {version:52,name:'Coinbase execution evidence and resumable account sync',sql:`
ALTER TABLE account_orders DROP CONSTRAINT account_orders_asset_class_check;
ALTER TABLE account_orders ADD CONSTRAINT account_orders_asset_class_check CHECK(asset_class IN ('equity','option','crypto'));
ALTER TABLE account_executions DROP CONSTRAINT account_executions_asset_class_check;
ALTER TABLE account_executions ADD CONSTRAINT account_executions_asset_class_check CHECK(asset_class IN ('equity','option','crypto'));
CREATE TABLE coinbase_activity_sync (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
 resource text NOT NULL CHECK(resource IN ('spot_orders','spot_fills')),
 state text NOT NULL CHECK(state IN ('running','partial','completed','failed','interrupted')),
 attempted_at timestamptz NOT NULL, completed_at timestamptz,
 error_code text, cursor text, window_start timestamptz, window_end timestamptz,
 seen_cursors jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(account_id,resource)
);
`};
