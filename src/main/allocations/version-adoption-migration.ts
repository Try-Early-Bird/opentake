export const versionAdoptionMigration={version:68,name:'Reviewed Robinhood allocation versions',sql:`
ALTER TABLE strategy_allocations ADD COLUMN accepted_version_id UUID REFERENCES strategy_versions(id);
UPDATE strategy_allocations SET accepted_version_id=applied_version_id;
CREATE FUNCTION pin_allocation_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.accepted_version_id IS NULL THEN NEW.accepted_version_id:=NEW.applied_version_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM strategy_versions WHERE id=NEW.accepted_version_id AND strategy_id=NEW.strategy_id) THEN RAISE EXCEPTION 'Allocation version must belong to its Take'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_version_pin BEFORE INSERT OR UPDATE OF accepted_version_id,strategy_id ON strategy_allocations FOR EACH ROW EXECUTE FUNCTION pin_allocation_version();
ALTER TABLE strategy_allocations ALTER COLUMN accepted_version_id SET NOT NULL;
`};
