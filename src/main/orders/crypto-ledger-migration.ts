export const cryptoLedgerMigration={version:75,name:'Crypto instruments in the Take attribution ledger',sql:`
ALTER TABLE strategy_attribution_entries DROP CONSTRAINT strategy_attribution_entries_asset_class_check;
ALTER TABLE strategy_attribution_entries ADD CONSTRAINT strategy_attribution_entries_asset_class_check CHECK(asset_class IN ('equity','crypto'));
ALTER TABLE strategy_attribution_entries DROP CONSTRAINT strategy_attribution_entries_check;
ALTER TABLE strategy_attribution_entries ADD CONSTRAINT strategy_attribution_entries_check CHECK(
 (quantity_delta IS NULL AND instrument_ref IS NULL AND asset_class IS NULL) OR
 (quantity_delta IS NOT NULL AND instrument_ref IS NOT NULL AND asset_class IN ('equity','crypto')));
`};
