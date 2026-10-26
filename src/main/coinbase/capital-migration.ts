export const coinbaseCapitalMigration = {version:56,name:'Reviewed Coinbase capital instructions',sql:`
CREATE TABLE coinbase_capital_reviews (
 id uuid PRIMARY KEY, take_id uuid NOT NULL REFERENCES takes(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('assign','release')), input jsonb NOT NULL,
 account_label text NOT NULL, take_title text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','expired')),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE FUNCTION coinbase_capital_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Capital reviews cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
 OR OLD.state<>'pending' THEN RAISE EXCEPTION 'Capital review cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coinbase_capital_review_guard BEFORE UPDATE OR DELETE ON coinbase_capital_reviews
 FOR EACH ROW EXECUTE FUNCTION coinbase_capital_review_identity();
`};
