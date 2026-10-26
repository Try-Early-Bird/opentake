export const coinbaseLifecycleMigration={version:64,name:'Coinbase allocation recovery and version adoption',sql:`
ALTER TABLE coinbase_allocations ADD COLUMN drift_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE coinbase_allocation_decisions (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id),
 allocation_id uuid NOT NULL REFERENCES coinbase_allocations(id),
 kind text NOT NULL CHECK(kind IN ('reconcile','release','adopt','drift')),
 evidence_hash text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TRIGGER coinbase_allocation_decisions_immutable BEFORE UPDATE OR DELETE ON coinbase_allocation_decisions
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE OR REPLACE FUNCTION coinbase_allocation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.strategy_id<>OLD.strategy_id) THEN
  RAISE EXCEPTION 'Allocation identity cannot change';
 END IF;
 IF TG_OP='UPDATE' AND NEW.version_id<>OLD.version_id AND NOT EXISTS(
  SELECT 1 FROM coinbase_allocation_decisions d WHERE d.allocation_id=OLD.id AND d.kind='adopt'
   AND d.details->>'fromVersion'=OLD.version_id::text AND d.details->>'toVersion'=NEW.version_id::text
 ) THEN RAISE EXCEPTION 'Reviewed version adoption required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
 JOIN strategies s ON s.owner_id=c.owner_id WHERE a.id=NEW.account_id AND s.id=NEW.strategy_id AND c.venue='coinbase') THEN
  RAISE EXCEPTION 'Coinbase allocation owner mismatch';
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE coinbase_rebalance_runs ADD COLUMN trigger text NOT NULL DEFAULT 'schedule' CHECK(trigger IN ('schedule','drift'));
ALTER TABLE coinbase_rebalance_runs DROP CONSTRAINT coinbase_rebalance_runs_allocation_id_scheduled_on_key;
CREATE UNIQUE INDEX coinbase_rebalance_daily_trigger ON coinbase_rebalance_runs(allocation_id,scheduled_on,trigger);
`};
