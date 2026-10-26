export const coinbaseHistoryMigration = {version:51,name:'Coinbase transaction history coverage',sql:`
CREATE TABLE coinbase_transaction_history (
 account_id uuid PRIMARY KEY REFERENCES linked_accounts(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('complete','partial','failed')),
 error_code text,
 data jsonb
);
`};
