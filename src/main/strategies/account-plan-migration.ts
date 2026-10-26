export const strategyAccountPlanMigration = { version: 49, name: 'Reusable account plans for research Takes', sql: `
CREATE TABLE strategy_account_plans (
 strategy_id uuid PRIMARY KEY REFERENCES strategies(id) ON DELETE CASCADE,
 revision uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE strategy_account_routes (
 strategy_id uuid NOT NULL REFERENCES strategy_account_plans(strategy_id) ON DELETE CASCADE,
 venue text NOT NULL CHECK (venue IN ('coinbase','robinhood')),
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 PRIMARY KEY (strategy_id,venue)
);
CREATE INDEX strategy_account_routes_account ON strategy_account_routes(account_id);
` };
