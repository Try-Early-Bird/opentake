// The allocation ledger and the minimal strategy/version identity it references.
// Proposals, editing and commit APIs come later; this migration creates no baskets.
export const allocationMigration = { version: 27, name: 'Strategy allocation ledger and reconciliation core', sql: `
CREATE TABLE financial_history_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 retention_days integer DEFAULT 90 CHECK(retention_days BETWEEN 1 AND 3650)
);
INSERT INTO financial_history_settings DEFAULT VALUES;
CREATE TABLE strategies (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE RESTRICT,
 kind text NOT NULL DEFAULT 'basket' CHECK(kind='basket'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','committed')),
 current_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 UNIQUE(id,owner_id), CHECK((status='draft')=(current_version_id IS NULL))
);
CREATE TABLE strategy_versions (
 id uuid PRIMARY KEY, strategy_id uuid NOT NULL, owner_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), schema_version integer NOT NULL CHECK(schema_version>0),
 metadata jsonb NOT NULL, spec jsonb NOT NULL, provenance jsonb NOT NULL,
 verification jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(strategy_id,sequence), UNIQUE(strategy_id,id),
 FOREIGN KEY(strategy_id,owner_id) REFERENCES strategies(id,owner_id) ON DELETE RESTRICT
);
ALTER TABLE strategies ADD CONSTRAINT strategy_current_version_fk
 FOREIGN KEY(id,current_version_id) REFERENCES strategy_versions(strategy_id,id) ON DELETE RESTRICT;
CREATE TABLE strategy_allocations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 strategy_id uuid NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT,
 applied_version_id uuid NOT NULL, currency text NOT NULL CHECK(currency='USD'),
 status text NOT NULL CHECK(status IN ('active','paused','diverged','detached','closed')),
 resume_status text CHECK(resume_status IN ('active','paused')),
 limits jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL, restore_required boolean NOT NULL DEFAULT false,
 UNIQUE(id,account_id), FOREIGN KEY(strategy_id,applied_version_id) REFERENCES strategy_versions(strategy_id,id) ON DELETE RESTRICT
);
CREATE INDEX strategy_allocations_account ON strategy_allocations(account_id,status);
CREATE TABLE strategy_allocation_transactions (
 id uuid PRIMARY KEY, allocation_id uuid NOT NULL REFERENCES strategy_allocations(id) ON DELETE RESTRICT,
 sequence integer NOT NULL CHECK(sequence>0), kind text NOT NULL CHECK(kind IN
 ('investment','contribution','cash_release','version_change','rebalance','redemption','exit','detachment','reconciliation','reinvestment')),
 trigger text NOT NULL, requested_amount numeric(38,18), idempotency_key text NOT NULL,
 request_hash text NOT NULL, pending_reason text, outcome text CHECK(outcome IN ('cancelled','superseded','failed')),
 created_at timestamptz NOT NULL, UNIQUE(allocation_id,sequence), UNIQUE(allocation_id,idempotency_key), UNIQUE(id,allocation_id)
);
CREATE TABLE strategy_attribution_entries (
 id uuid PRIMARY KEY, allocation_id uuid NOT NULL, account_id uuid NOT NULL,
 transaction_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0),
 entry_type text NOT NULL CHECK(entry_type IN ('capital_allocated','capital_released','fill','fee','reinvestment','corporate_action','detachment','external_adjustment','reversal')),
 instrument_ref text, symbol text, asset_class text CHECK(asset_class='equity'),
 quantity_delta numeric(38,18), cash_delta numeric(38,18) NOT NULL DEFAULT 0,
 currency text NOT NULL CHECK(currency='USD'), unit_cost numeric(38,18),
 provider text, execution_ref text, source_kind text NOT NULL, source_ref text NOT NULL,
 idempotency_key text NOT NULL, request_hash text NOT NULL, reversal_of uuid,
 metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(allocation_id,sequence), UNIQUE(allocation_id,idempotency_key), UNIQUE(id,allocation_id), UNIQUE(id,account_id),
 FOREIGN KEY(allocation_id,account_id) REFERENCES strategy_allocations(id,account_id) ON DELETE RESTRICT,
 FOREIGN KEY(transaction_id,allocation_id) REFERENCES strategy_allocation_transactions(id,allocation_id) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,provider,execution_ref) REFERENCES account_executions(account_id,provider,provider_ref) ON DELETE RESTRICT,
 FOREIGN KEY(reversal_of,allocation_id) REFERENCES strategy_attribution_entries(id,allocation_id) ON DELETE RESTRICT,
 CHECK((quantity_delta IS NULL AND instrument_ref IS NULL AND asset_class IS NULL) OR
 (quantity_delta IS NOT NULL AND instrument_ref IS NOT NULL AND asset_class='equity')),
 CHECK((provider IS NULL)=(execution_ref IS NULL))
);
CREATE UNIQUE INDEX strategy_one_reversal ON strategy_attribution_entries(reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX strategy_attribution_instrument ON strategy_attribution_entries(account_id,instrument_ref,occurred_at);
CREATE TABLE strategy_lot_bindings (
 entry_id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 provider text NOT NULL, open_lot_id text NOT NULL, matched_at timestamptz NOT NULL,
 UNIQUE(account_id,provider,open_lot_id),
 FOREIGN KEY(entry_id,account_id) REFERENCES strategy_attribution_entries(id,account_id) ON DELETE RESTRICT
);
CREATE TABLE strategy_reconciliation_cases (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 scope text NOT NULL, cause text NOT NULL, instrument_ref text,
 observed numeric(38,18), claimed numeric(38,18), difference numeric(38,18),
 impacts jsonb NOT NULL, evidence jsonb NOT NULL, assignment jsonb,
 resolution text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, resolved_at timestamptz
);
CREATE UNIQUE INDEX strategy_one_open_case ON strategy_reconciliation_cases(account_id,scope) WHERE resolved_at IS NULL;
CREATE TABLE strategy_evidence_pins (
 allocation_id uuid NOT NULL REFERENCES strategy_allocations(id) ON DELETE RESTRICT,
 observation_id uuid NOT NULL REFERENCES account_observations(id) ON DELETE RESTRICT,
 reason text NOT NULL, PRIMARY KEY(allocation_id,observation_id,reason)
);
CREATE FUNCTION strategy_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Financial history is append-only'; END $$;
CREATE TRIGGER strategy_entries_immutable BEFORE UPDATE OR DELETE ON strategy_attribution_entries
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE TRIGGER strategy_versions_immutable BEFORE UPDATE OR DELETE ON strategy_versions
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE TRIGGER strategy_lots_immutable BEFORE UPDATE OR DELETE ON strategy_lot_bindings
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE FUNCTION strategy_allocation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.strategy_id<>OLD.strategy_id OR NEW.currency<>OLD.currency) THEN
  RAISE EXCEPTION 'Allocation identity cannot change';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
 JOIN strategies s ON s.owner_id=c.owner_id WHERE a.id=NEW.account_id AND s.id=NEW.strategy_id) THEN
  RAISE EXCEPTION 'Allocation owner mismatch';
 END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER strategy_allocation_owner BEFORE INSERT OR UPDATE ON strategy_allocations
 FOR EACH ROW EXECUTE FUNCTION strategy_allocation_identity();
` };
