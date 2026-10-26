export const coinbaseAllocationMigration={version:55,name:'Durable Coinbase allocation accounting',sql:`
CREATE TABLE coinbase_allocations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 strategy_id uuid NOT NULL, version_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','reconciliation_required')),
 restore_required boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
 UNIQUE(id,account_id), UNIQUE(account_id,strategy_id),
 FOREIGN KEY(strategy_id,version_id) REFERENCES strategy_versions(strategy_id,id) ON DELETE RESTRICT
);
CREATE TABLE coinbase_allocation_orders (
 id uuid PRIMARY KEY, allocation_id uuid NOT NULL, account_id uuid NOT NULL,
 cause text NOT NULL, request_hash text NOT NULL, client_ref uuid NOT NULL,
 product text NOT NULL, side text NOT NULL CHECK(side IN ('buy','sell')),
 max_base numeric(78,36) NOT NULL CHECK(max_base>0), provider_order_ref text,
 state text NOT NULL CHECK(state IN ('prepared','bound','closed','reconciliation_required')),
 created_at timestamptz NOT NULL, closed_at timestamptz,
 UNIQUE(id,allocation_id,account_id), UNIQUE(allocation_id,cause), UNIQUE(account_id,client_ref), UNIQUE(account_id,provider_order_ref),
 FOREIGN KEY(allocation_id,account_id) REFERENCES coinbase_allocations(id,account_id) ON DELETE RESTRICT
);
CREATE TABLE coinbase_allocation_reservations (
 order_id uuid NOT NULL, allocation_id uuid NOT NULL, account_id uuid NOT NULL,
 asset text NOT NULL, maximum numeric(78,36) NOT NULL CHECK(maximum>0),
 remaining numeric(78,36) NOT NULL CHECK(remaining>=0 AND remaining<=maximum),
 PRIMARY KEY(order_id,asset),
 FOREIGN KEY(order_id,allocation_id,account_id) REFERENCES coinbase_allocation_orders(id,allocation_id,account_id) ON DELETE RESTRICT
);
CREATE TABLE coinbase_allocation_entries (
 id uuid PRIMARY KEY, allocation_id uuid NOT NULL, account_id uuid NOT NULL,
 asset text NOT NULL, quantity numeric(78,36) NOT NULL,
 cause text NOT NULL, request_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('capital','release','fill')),
 order_id uuid, provider text NOT NULL DEFAULT 'coinbase' CHECK(provider='coinbase'), execution_ref text,
 occurred_at timestamptz NOT NULL,
 UNIQUE(allocation_id,cause,asset), UNIQUE(account_id,execution_ref,asset),
 FOREIGN KEY(allocation_id,account_id) REFERENCES coinbase_allocations(id,account_id) ON DELETE RESTRICT,
 FOREIGN KEY(order_id,allocation_id,account_id) REFERENCES coinbase_allocation_orders(id,allocation_id,account_id) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,provider,execution_ref) REFERENCES account_executions(account_id,provider,provider_ref) ON DELETE RESTRICT,
 CHECK((kind='fill')=(execution_ref IS NOT NULL)), CHECK((kind='fill')=(order_id IS NOT NULL))
);
CREATE TRIGGER coinbase_allocation_entries_immutable BEFORE UPDATE OR DELETE ON coinbase_allocation_entries
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE FUNCTION coinbase_allocation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.strategy_id<>OLD.strategy_id OR NEW.version_id<>OLD.version_id) THEN
  RAISE EXCEPTION 'Allocation identity cannot change';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
 JOIN strategies s ON s.owner_id=c.owner_id WHERE a.id=NEW.account_id AND s.id=NEW.strategy_id AND c.venue='coinbase') THEN
  RAISE EXCEPTION 'Coinbase allocation owner mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coinbase_allocation_identity_guard BEFORE INSERT OR UPDATE ON coinbase_allocations
 FOR EACH ROW EXECUTE FUNCTION coinbase_allocation_identity();
CREATE FUNCTION coinbase_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Order accounting cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'state'-'provider_order_ref'-'closed_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'provider_order_ref'-'closed_at')
 OR (OLD.provider_order_ref IS NOT NULL AND NEW.provider_order_ref IS DISTINCT FROM OLD.provider_order_ref) THEN
  RAISE EXCEPTION 'Order identity and reviewed limits cannot change';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coinbase_order_identity_guard BEFORE UPDATE OR DELETE ON coinbase_allocation_orders
 FOR EACH ROW EXECUTE FUNCTION coinbase_order_identity();
CREATE FUNCTION coinbase_reservation_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservation accounting cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'remaining') IS DISTINCT FROM (to_jsonb(OLD)-'remaining') OR NEW.remaining>OLD.remaining THEN
  RAISE EXCEPTION 'Reservation limits cannot increase or change identity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coinbase_reservation_limit_guard BEFORE UPDATE OR DELETE ON coinbase_allocation_reservations
 FOR EACH ROW EXECUTE FUNCTION coinbase_reservation_limit();
`};
