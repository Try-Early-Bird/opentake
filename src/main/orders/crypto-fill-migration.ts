/** Cumulative order accounting checkpoint; application and checkpoint commit together. */
export const cryptoFillMigration={version:74,name:'Crypto cumulative fill checkpoints',sql:`
CREATE TABLE order_fill_checkpoints (
 intent_id uuid PRIMARY KEY REFERENCES order_intents(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 observed_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL
);
`};
