export const mixedWithdrawalMigration={version:72,name:'Whole Take withdrawal journal',sql:`
CREATE TABLE mixed_take_withdrawals (
 id uuid PRIMARY KEY,
 take_id uuid NOT NULL REFERENCES takes(id),
 state text NOT NULL CHECK(state IN ('preview','running','completed','attention','expired')),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mixed_take_withdrawal_active ON mixed_take_withdrawals(take_id) WHERE state IN ('running','attention');
`};
