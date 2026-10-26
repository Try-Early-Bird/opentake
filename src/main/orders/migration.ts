// Durable order intents. One row per logical order: reviewed (a fresh
// Robinhood review, valid two minutes) -> placing (claimed by the single
// writer) -> placed | rejected (Robinhood refused the request: proof no
// order exists) | placement_unknown (the outcome may have reached Robinhood;
// never resent automatically, resolved only by matching a synced order's
// ref_id). An intent may cite the allocation instruction it serves, which
// is how a later fill is attributed to that allocation.
export const orderIntentsMigration={version:33,name:'Durable order intents',sql:`
CREATE TABLE order_intents (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 allocation_id uuid, transaction_id uuid,
 asset_class text NOT NULL CHECK(asset_class='equity'),
 status text NOT NULL CHECK(status IN ('reviewed','expired','placing','placed','rejected','placement_unknown')),
 ref_id uuid NOT NULL UNIQUE,
 order_request jsonb NOT NULL, review_result jsonb, placement_result jsonb,
 provider_order_ref text, error_code text,
 reviewed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 confirmed_at timestamptz, placed_at timestamptz, updated_at timestamptz NOT NULL,
 FOREIGN KEY(transaction_id,allocation_id) REFERENCES strategy_allocation_transactions(id,allocation_id) ON DELETE RESTRICT,
 CHECK((allocation_id IS NULL)=(transaction_id IS NULL)),
 CHECK(status<>'placed' OR provider_order_ref IS NOT NULL)
);
CREATE UNIQUE INDEX order_intents_provider_ref ON order_intents(account_id,provider_order_ref) WHERE provider_order_ref IS NOT NULL;
CREATE INDEX order_intents_open ON order_intents(account_id,status) WHERE status IN ('placing','placement_unknown');
`};
