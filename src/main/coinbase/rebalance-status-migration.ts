export const coinbaseRebalanceStatusMigration={version:65,name:'Coinbase rebalance warning status',sql:`
ALTER TABLE coinbase_rebalance_runs ADD COLUMN warning_code text CHECK(warning_code IN ('below_minimum','insufficient_funds'));
`};
