// Imported source evidence is separate from live attribution and never authorizes execution.
export const strategyPortfolioImportMigration={version:29,name:'Immutable development strategy portfolio imports',sql:`
CREATE TABLE strategy_portfolio_imports (
 account_id uuid PRIMARY KEY REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 source_account_id uuid NOT NULL, source_branch text NOT NULL CHECK(source_branch='development'),
 request_hash text NOT NULL, source_data jsonb NOT NULL, mapping jsonb NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER strategy_portfolio_imports_immutable BEFORE UPDATE OR DELETE ON strategy_portfolio_imports
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
`};
