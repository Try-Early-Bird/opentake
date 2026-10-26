export const ruleTradeMigration={version:95,name:'Coinbase rule rebalance execution',sql:`
ALTER TABLE strategy_rule_accepted ADD COLUMN trading_enabled boolean NOT NULL DEFAULT false, ADD COLUMN trading_rule_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE strategy_rule_action_requests DROP CONSTRAINT strategy_rule_action_requests_status_check;
ALTER TABLE strategy_rule_action_requests ADD CONSTRAINT strategy_rule_action_requests_status_check CHECK(status IN ('shadow','expired','superseded','context_pending','context_failed','conditions_false','notified','executed','action_blocked'));
CREATE TABLE strategy_rule_trades (
 request_id uuid PRIMARY KEY REFERENCES strategy_rule_action_requests(id) ON DELETE CASCADE,
 take_id uuid NOT NULL REFERENCES takes(id),
 account_id uuid NOT NULL REFERENCES linked_accounts(id),
 phase text NOT NULL DEFAULT 'initial' CHECK(phase IN ('initial','buy')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','working','completed','blocked','attention')),
 review_id uuid REFERENCES coinbase_order_reviews(id),
 reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX coinbase_rule_review_identity ON coinbase_order_reviews
 ((payload->'rebalance'->>'ruleRequestId'),(coalesce(payload->'rebalance'->>'phase','initial')))
 WHERE payload->'rebalance'->>'ruleRequestId' IS NOT NULL;
`};
