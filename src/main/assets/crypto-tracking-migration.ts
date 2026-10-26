export const cryptoTrackingMigration={version:79,name:'Crypto quote history and account order discovery',sql:`
ALTER TABLE account_sync_runs DROP CONSTRAINT account_sync_runs_resource_check;
ALTER TABLE account_sync_runs ADD CONSTRAINT account_sync_runs_resource_check CHECK(resource IN ('portfolio','equity_positions','option_positions','equity_orders','option_orders','crypto_positions','crypto_orders'));
ALTER TABLE account_orders DROP CONSTRAINT account_orders_asset_class_check;
ALTER TABLE account_orders ADD CONSTRAINT account_orders_asset_class_check CHECK(asset_class IN ('equity','option','crypto'));
CREATE TABLE robinhood_crypto_price_samples (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 instrument_ref text NOT NULL, symbol text NOT NULL, routing text NOT NULL,
 bucket_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
 mark_price numeric(38,18) NOT NULL CHECK(mark_price>0),
 previous_close numeric(38,18) CHECK(previous_close>0), close_day date,
 CHECK((previous_close IS NULL)=(close_day IS NULL)),
 PRIMARY KEY(account_id,instrument_ref,routing,bucket_at)
);
`};
