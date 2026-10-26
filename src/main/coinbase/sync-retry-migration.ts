export const coinbaseSyncRetryMigration={version:61,name:'Persistent Coinbase sync retries',sql:`
ALTER TABLE coinbase_portfolio_sync ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0);
ALTER TABLE coinbase_portfolio_sync ADD COLUMN next_attempt_at timestamptz;
`};
