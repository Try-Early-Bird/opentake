export const coinbaseOrderReviewMigration={version:57,name:'Coinbase order previews and reservations',sql:`
CREATE TABLE coinbase_order_reviews (
 id uuid PRIMARY KEY,take_id uuid NOT NULL REFERENCES takes(id),account_id uuid NOT NULL REFERENCES linked_accounts(id),
 allocation_id uuid NOT NULL REFERENCES coinbase_allocations(id),version_id uuid NOT NULL REFERENCES strategy_versions(id),
 authority text NOT NULL,claims_hash text NOT NULL,payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','confirmed','cancelled','expired')),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL
);
CREATE FUNCTION coinbase_order_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Order review cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR
 NOT ((OLD.state='preview' AND NEW.state IN ('confirmed','expired')) OR (OLD.state='confirmed' AND NEW.state='cancelled')) THEN
  RAISE EXCEPTION 'Order review cannot change';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coinbase_order_review_guard BEFORE UPDATE OR DELETE ON coinbase_order_reviews
 FOR EACH ROW EXECUTE FUNCTION coinbase_order_review_identity();
`};
