export const coinbasePortfolioMigration = { version: 48, name: 'Account-scoped Coinbase portfolio observations', sql: `
CREATE TABLE coinbase_portfolio_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
 observed_at timestamptz NOT NULL,
 data jsonb NOT NULL
);
CREATE INDEX coinbase_portfolio_account_time ON coinbase_portfolio_observations(account_id,observed_at DESC);
CREATE TABLE coinbase_portfolio_sync (
 account_id uuid PRIMARY KEY REFERENCES linked_accounts(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('running','completed','failed','interrupted')),
 attempted_at timestamptz NOT NULL,
 error_code text
);
` };
