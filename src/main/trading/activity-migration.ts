export const orderActivityMigration={version:60,name:'Account-scoped order activity',sql:`
CREATE TABLE order_activity (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 id uuid NOT NULL UNIQUE,
 venue text NOT NULL CHECK(venue IN ('robinhood','coinbase')),
 account_id uuid NOT NULL,
 order_id uuid NOT NULL,
 signature text NOT NULL,
 payload jsonb NOT NULL
);
CREATE INDEX order_activity_identity ON order_activity(venue,account_id,order_id,sequence DESC);
CREATE INDEX order_activity_account ON order_activity(account_id,sequence DESC);
`};
