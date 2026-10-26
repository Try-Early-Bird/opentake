// A rule's trade on a Robinhood Take. It keeps the stored preview the
// member approves (one approval flow for both venues), then the existing Robinhood
// planner and executor place the orders.
export const robinhoodRuleTradeMigration={version:109,name:'Robinhood rule trades',sql:`
CREATE TABLE robinhood_rule_trades (
 request_id uuid PRIMARY KEY REFERENCES strategy_rule_action_requests(id) ON DELETE CASCADE,
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES linked_accounts(id),
 allocation_id uuid NOT NULL REFERENCES strategy_allocations(id),
 kind text NOT NULL CHECK (kind IN ('rebalance_to_target','reduce')),
 amount numeric,
 state text NOT NULL CHECK (state IN ('awaiting_approval','approved','executing','completed','blocked','declined','attention')),
 preview jsonb NOT NULL,
 transaction_id uuid,
 reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{1,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX robinhood_rule_trades_open ON robinhood_rule_trades(take_id) WHERE state IN ('awaiting_approval','approved','executing','attention');
`};
// Deploy cash on Robinhood (October 25, 2026): a buy-only plan spending at most the rule's amount.
export const robinhoodDeployCashMigration={version:110,name:'Robinhood rule deploy cash',sql:`
ALTER TABLE robinhood_rule_trades DROP CONSTRAINT robinhood_rule_trades_kind_check;
ALTER TABLE robinhood_rule_trades ADD CONSTRAINT robinhood_rule_trades_kind_check CHECK (kind IN ('rebalance_to_target','deploy_cash','reduce'));
`};
