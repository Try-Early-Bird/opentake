// Strategy execution state: allocation planning columns, strategy_executions
// (one order leg each), strategy_execution_plans (what a planning pass decided,
// for the panel), closures and trading preferences. Every allocation is delegated (orders go out
// without a per-order prompt unless confirm_trades is on).
export const executionMigration={version:34,name:'Strategy execution: plans, legs, closures and trading preferences',sql:`
ALTER TABLE strategy_allocations
 ADD COLUMN allocation_value numeric(38,18) CHECK(allocation_value IS NULL OR allocation_value>=0),
 ADD COLUMN applied_version_sequence integer NOT NULL DEFAULT 0 CHECK(applied_version_sequence>=0),
 ADD COLUMN planning_reason_code text,
 ADD COLUMN planning_deferred_until timestamptz,
 ADD COLUMN planning_failures integer NOT NULL DEFAULT 0 CHECK(planning_failures>=0),
 ADD COLUMN orders_confirmed_at timestamptz,
 ADD COLUMN max_daily_notional numeric(38,18) CHECK(max_daily_notional IS NULL OR max_daily_notional>0),
 ADD COLUMN max_loss numeric(38,18) CHECK(max_loss IS NULL OR max_loss>0),
 ADD COLUMN last_rebalanced_on text,
 ADD COLUMN last_rebalanced_at timestamptz,
 ADD COLUMN last_drift_check_on text,
 ADD COLUMN activated_at timestamptz,
 ADD COLUMN paused_at timestamptz,
 ADD COLUMN closed_at timestamptz;
-- Imported allocations carried their value in the ledger; seed it from capital in/out.
UPDATE strategy_allocations a SET allocation_value=coalesce((SELECT sum(e.cash_delta) FROM strategy_attribution_entries e
 WHERE e.allocation_id=a.id AND e.entry_type IN ('capital_allocated','capital_released')),0);

CREATE TABLE strategy_execution_plans (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL REFERENCES strategy_allocations(id) ON DELETE RESTRICT,
 transaction_id uuid,
 trigger text NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('planned','deferred','skipped','up_to_date','failed')),
 reason_code text,
 sleeves jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL
);
CREATE INDEX strategy_execution_plans_allocation ON strategy_execution_plans(allocation_id,created_at DESC);

CREATE TABLE strategy_executions (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL REFERENCES strategy_allocations(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 strategy_id uuid NOT NULL,
 version_id uuid,
 plan_id uuid REFERENCES strategy_execution_plans(id) ON DELETE SET NULL,
 transaction_id uuid,
 kind text NOT NULL CHECK(kind IN ('subscribe','rebalance','liquidate','redeem')),
 trigger text,
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z0-9.\\-]{1,16}$'),
 side text NOT NULL CHECK(side IN ('buy','sell')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','reviewed','submitting','submitted','placement_unknown','partially_filled','filled','failed','reconciliation_required','cancelled')),
 order_request jsonb NOT NULL,
 order_intent_id uuid REFERENCES order_intents(id) ON DELETE RESTRICT,
 idempotency_key uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 failure_code text,
 created_at timestamptz NOT NULL, reviewed_at timestamptz, submitted_at timestamptz, terminal_at timestamptz, updated_at timestamptz NOT NULL,
 FOREIGN KEY(transaction_id,allocation_id) REFERENCES strategy_allocation_transactions(id,allocation_id) ON DELETE RESTRICT
);
-- One live leg per allocation and symbol, as hosted.
CREATE UNIQUE INDEX strategy_executions_open_leg ON strategy_executions(allocation_id,symbol)
 WHERE status IN ('queued','reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required');
CREATE INDEX strategy_executions_allocation_status ON strategy_executions(allocation_id,status);
CREATE UNIQUE INDEX strategy_executions_intent ON strategy_executions(order_intent_id) WHERE order_intent_id IS NOT NULL;

CREATE TABLE strategy_allocation_closures (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL UNIQUE REFERENCES strategy_allocations(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(reason IN ('archive','close')),
 status text NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','selling','held','sold','failed')),
 sell_symbols jsonb,
 opened_at timestamptz NOT NULL, decided_at timestamptz, completed_at timestamptz, failure_code text,
 updated_at timestamptz NOT NULL
);

CREATE TABLE trading_preferences (
 owner_id uuid PRIMARY KEY REFERENCES local_owners(id) ON DELETE RESTRICT,
 confirm_trades boolean NOT NULL DEFAULT false,
 blocked_symbols text[] NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL
);
`};
