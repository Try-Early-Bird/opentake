export const coinbaseInvestmentMigration={version:62,name:'Coinbase investment command recovery',sql:`
CREATE TABLE coinbase_investments (
 id uuid PRIMARY KEY,take_id uuid NOT NULL REFERENCES takes(id),account_id uuid NOT NULL REFERENCES linked_accounts(id),
 request jsonb NOT NULL,capital_review_id uuid UNIQUE REFERENCES coinbase_capital_reviews(id),
 order_review_id uuid REFERENCES coinbase_order_reviews(id),
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','funded','ready','dispatched','cancelled')),
 created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX coinbase_investment_pending_take ON coinbase_investments(take_id) WHERE state IN ('started','funded','ready');
CREATE OR REPLACE FUNCTION coinbase_order_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Order review cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR
 NOT ((OLD.state='preview' AND NEW.state IN ('confirmed','expired','cancelled')) OR (OLD.state='confirmed' AND NEW.state IN ('cancelled','settled'))) THEN
  RAISE EXCEPTION 'Order review cannot change';
 END IF;
 RETURN NEW;
END $$;
`};
