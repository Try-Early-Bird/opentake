export const mixedExecutionMigration={version:70,name:'Coordinated mixed Take investment journal',sql:`
CREATE TABLE mixed_take_executions (
 id uuid PRIMARY KEY,
 take_id uuid NOT NULL REFERENCES takes(id),
 preview_id uuid NOT NULL UNIQUE REFERENCES mixed_take_previews(id),
 state text NOT NULL CHECK(state IN ('funded','running','completed','attention')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mixed_take_execution_active ON mixed_take_executions(take_id) WHERE state<>'completed';
CREATE TABLE mixed_take_execution_legs (
 execution_id uuid NOT NULL REFERENCES mixed_take_executions(id),
 venue text NOT NULL CHECK(venue IN ('coinbase','robinhood')),
 account_id uuid NOT NULL REFERENCES linked_accounts(id),
 operation_id uuid NOT NULL UNIQUE,
 reference text NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','dispatching','pending','waiting_market','completed','attention')),
 message text,
 PRIMARY KEY(execution_id,venue),
 UNIQUE(execution_id,account_id)
);
`};
