export const coinbaseAutomationMigration={version:63,name:'Coinbase scheduled rebalance recovery',sql:`
CREATE TABLE coinbase_rebalance_runs (
 id uuid PRIMARY KEY, allocation_id uuid NOT NULL REFERENCES coinbase_allocations(id),
 scheduled_on date NOT NULL, review_id uuid REFERENCES coinbase_order_reviews(id),
 phase text NOT NULL DEFAULT 'initial' CHECK(phase IN ('initial','buy')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','working','completed','attention')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(allocation_id,scheduled_on)
);
`};
