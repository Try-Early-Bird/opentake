/** Append-only: existing equity intents and ledger entries retain their meaning. */
export const cryptoJournalMigration={version:73,name:'Robinhood crypto intent journal and cash holds',sql:`
ALTER TABLE order_intents DROP CONSTRAINT order_intents_asset_class_check;
ALTER TABLE order_intents ADD CONSTRAINT order_intents_asset_class_check CHECK(asset_class IN ('equity','crypto'));
ALTER TABLE order_intents DROP CONSTRAINT order_intents_status_check;
ALTER TABLE order_intents ADD CONSTRAINT order_intents_status_check CHECK(status IN ('reviewed','expired','placing','placed','rejected','placement_unknown','abandoned','approval_pending'));
ALTER TABLE order_intents ADD COLUMN approval_ref text;
ALTER TABLE order_intents ADD COLUMN maximum_debit numeric(38,18);
ALTER TABLE order_intents ADD CONSTRAINT order_intents_crypto_debit CHECK(asset_class<>'crypto' OR (maximum_debit IS NOT NULL AND maximum_debit>0));
ALTER TABLE order_intents ADD CONSTRAINT order_intents_crypto_approval CHECK(status<>'approval_pending' OR (asset_class='crypto' AND approval_ref IS NOT NULL));
CREATE UNIQUE INDEX order_intents_approval_ref ON order_intents(account_id,approval_ref) WHERE approval_ref IS NOT NULL;
CREATE TABLE order_cash_holds (
 intent_id uuid PRIMARY KEY REFERENCES order_intents(id) ON DELETE RESTRICT,
 amount numeric(38,18) NOT NULL CHECK(amount>0),
 state text NOT NULL CHECK(state IN ('held','released')),
 created_at timestamptz NOT NULL,
 released_at timestamptz,
 CHECK((state='released')=(released_at IS NOT NULL))
);
CREATE INDEX order_cash_holds_active ON order_cash_holds(intent_id) WHERE state='held';
`};
