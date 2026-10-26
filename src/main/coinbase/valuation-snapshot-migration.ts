export const coinbaseValuationSnapshotMigration={version:88,name:'Coinbase sampled portfolio valuations',sql:`
CREATE TABLE coinbase_valuation_snapshots (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
 bucket timestamptz NOT NULL,
 observed_at timestamptz NOT NULL,
 holdings_observed_at timestamptz NOT NULL,
 source_revision integer NOT NULL,
 quality text NOT NULL CHECK(quality IN ('complete','incomplete')),
 reason text,
 total_value text,
 currency text NOT NULL,
 prices jsonb NOT NULL,
 PRIMARY KEY(account_id,bucket),
 CHECK ((quality='complete' AND total_value IS NOT NULL AND reason IS NULL) OR (quality='incomplete' AND total_value IS NULL AND reason IS NOT NULL))
);
`};
