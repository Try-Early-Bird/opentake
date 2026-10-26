export const cryptoModelMigration={version:80,name:'Observed Robinhood crypto model baselines',sql:`
CREATE TABLE robinhood_crypto_model_baselines (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 version_id uuid NOT NULL REFERENCES strategy_versions(id) ON DELETE RESTRICT,
 observed_at timestamptz NOT NULL,
 routes jsonb NOT NULL,
 valuation jsonb NOT NULL,
 PRIMARY KEY(account_id,version_id)
);
`};
