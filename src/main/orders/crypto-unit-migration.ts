/** Append-only: sell reservations use units; buys keep their existing cash holds. */
export const cryptoUnitMigration={version:76,name:'Crypto sell unit reservations',sql:`
ALTER TABLE order_intents DROP CONSTRAINT order_intents_crypto_debit;
ALTER TABLE order_intents ADD CONSTRAINT order_intents_crypto_debit CHECK(asset_class<>'crypto' OR
 (maximum_debit IS NOT NULL AND ((order_request->>'side'='buy' AND maximum_debit>0) OR (order_request->>'side'='sell' AND maximum_debit=0))));
CREATE TABLE order_unit_holds (
 intent_id uuid PRIMARY KEY REFERENCES order_intents(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 allocation_id uuid NOT NULL REFERENCES strategy_allocations(id) ON DELETE RESTRICT,
 instrument_ref text NOT NULL,
 quantity numeric(38,18) NOT NULL CHECK(quantity>0),
 state text NOT NULL CHECK(state IN ('held','released')),
 created_at timestamptz NOT NULL,
 released_at timestamptz,
 CHECK((state='released')=(released_at IS NOT NULL))
);
CREATE INDEX order_unit_holds_active ON order_unit_holds(account_id,instrument_ref) WHERE state='held';
`};
