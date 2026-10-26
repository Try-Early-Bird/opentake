export const cryptoObservationMigration={version:78,name:'Crypto position observations',sql:`
ALTER TABLE account_sync_runs DROP CONSTRAINT account_sync_runs_resource_check;
ALTER TABLE account_sync_runs ADD CONSTRAINT account_sync_runs_resource_check CHECK(resource IN ('portfolio','equity_positions','option_positions','equity_orders','option_orders','crypto_positions'));
ALTER TABLE position_snapshots DROP CONSTRAINT position_snapshots_asset_class_check;
ALTER TABLE position_snapshots ADD CONSTRAINT position_snapshots_asset_class_check CHECK(asset_class IN ('equity','option','crypto'));
`};
