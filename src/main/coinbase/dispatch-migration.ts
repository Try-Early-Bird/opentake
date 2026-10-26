export const coinbaseDispatchMigration={version:58,name:'Coinbase order dispatch and recovery',sql:`
ALTER TABLE coinbase_allocation_orders DROP CONSTRAINT coinbase_allocation_orders_state_check;
ALTER TABLE coinbase_allocation_orders ADD CHECK(state IN ('prepared','submitting','unknown','bound','closed','reconciliation_required'));
ALTER TABLE coinbase_order_reviews DROP CONSTRAINT coinbase_order_reviews_state_check;
ALTER TABLE coinbase_order_reviews ADD CHECK(state IN ('preview','confirmed','cancelled','expired','settled'));
CREATE OR REPLACE FUNCTION coinbase_order_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Order review cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR
 NOT ((OLD.state='preview' AND NEW.state IN ('confirmed','expired')) OR (OLD.state='confirmed' AND NEW.state IN ('cancelled','settled'))) THEN
  RAISE EXCEPTION 'Order review cannot change';
 END IF;
 RETURN NEW;
END $$;
CREATE TABLE coinbase_order_dispatches (
 order_id uuid PRIMARY KEY REFERENCES coinbase_allocation_orders(id),
 review_id uuid NOT NULL REFERENCES coinbase_order_reviews(id),
 state text NOT NULL CHECK(state IN ('sending','unknown','accepted','rejected')),
 cancel_state text NOT NULL DEFAULT 'none' CHECK(cancel_state IN ('none','sending','requested','unknown','rejected')),
 started_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE FUNCTION coinbase_dispatch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dispatch records cannot be deleted'; END IF;
 IF NEW.order_id<>OLD.order_id OR NEW.review_id<>OLD.review_id OR NEW.started_at<>OLD.started_at THEN
  RAISE EXCEPTION 'Dispatch identity cannot change';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coinbase_dispatch_guard BEFORE UPDATE OR DELETE ON coinbase_order_dispatches
 FOR EACH ROW EXECUTE FUNCTION coinbase_dispatch_identity();
`};
