export const coinbaseRebalanceWarningDetailsMigration={version:67,name:'Coinbase rebalance warning evidence',sql:`
ALTER TABLE coinbase_rebalance_runs ADD COLUMN warning_details jsonb;
`};
