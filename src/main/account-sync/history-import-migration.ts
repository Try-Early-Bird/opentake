export const portfolioHistoryImportMigration = {
 version: 26,
 name: 'Account-scoped portfolio history imports',
 sql: `CREATE TABLE portfolio_history_imports (
  account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
  source_branch text NOT NULL CHECK(source_branch = 'development'),
  source_account_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,source_branch,source_account_id,source_snapshot_id)
 );
 CREATE INDEX portfolio_history_imports_time ON portfolio_history_imports(account_id,observed_at);
`,
};
