// Archiving a take with money in it. Hosted opens an awaiting archive closure for every open bucket, cancels
// queued legs and parks planning as strategy_archived; the member then
// chooses to hold or sell. Here a take is archived by the takes table, whose
// trigger archives its strategy (migration 28), so the same work runs from a
// trigger on strategies.archived_at. Unarchiving, which hosted has no
// equivalent for, withdraws any closure still waiting on a decision so the
// investment follows the take again. Takes archived before this migration
// get their closures now.
export const archiveClosureMigration={version:41,name:'Archived takes ask to hold or sell',sql:`
CREATE FUNCTION open_archive_closures() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
  UPDATE strategy_executions e SET status='cancelled',failure_code='archived',terminal_at=NEW.archived_at,updated_at=NEW.archived_at
   FROM strategy_allocations a WHERE e.allocation_id=a.id AND a.strategy_id=NEW.id AND a.status IN ('active','paused','diverged') AND e.status='queued';
  INSERT INTO strategy_allocation_closures(id,allocation_id,reason,status,opened_at,updated_at)
   SELECT gen_random_uuid(),a.id,'archive','awaiting',NEW.archived_at,NEW.archived_at FROM strategy_allocations a
   WHERE a.strategy_id=NEW.id AND a.status IN ('active','paused','diverged')
   ON CONFLICT (allocation_id) DO NOTHING;
  UPDATE strategy_allocations SET planning_reason_code='strategy_archived',planning_deferred_until=NULL,updated_at=NEW.archived_at
   WHERE strategy_id=NEW.id AND status IN ('active','paused','diverged');
 ELSIF NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL THEN
  DELETE FROM strategy_allocation_closures c USING strategy_allocations a
   WHERE c.allocation_id=a.id AND a.strategy_id=NEW.id AND c.reason='archive' AND c.status IN ('awaiting','failed');
  UPDATE strategy_allocations SET planning_reason_code=NULL,updated_at=now()
   WHERE strategy_id=NEW.id AND planning_reason_code='strategy_archived';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER strategy_archive_closures AFTER UPDATE OF archived_at ON strategies FOR EACH ROW EXECUTE FUNCTION open_archive_closures();
INSERT INTO strategy_allocation_closures(id,allocation_id,reason,status,opened_at,updated_at)
 SELECT gen_random_uuid(),a.id,'archive','awaiting',s.archived_at,now() FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id
 WHERE s.archived_at IS NOT NULL AND a.status IN ('active','paused','diverged')
 ON CONFLICT (allocation_id) DO NOTHING;
`};

// Archiving while a close is already under way left its queued sells
// cancelled and its planning reason overwritten. The close is left to finish:
// only investments without a closure lose their queued legs, and only those
// now waiting on the archive decision are parked.
export const archiveClosureGuardMigration={version:42,name:'Archiving leaves a close under way alone',sql:`
CREATE OR REPLACE FUNCTION open_archive_closures() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
  UPDATE strategy_executions e SET status='cancelled',failure_code='archived',terminal_at=NEW.archived_at,updated_at=NEW.archived_at
   FROM strategy_allocations a WHERE e.allocation_id=a.id AND a.strategy_id=NEW.id AND a.status IN ('active','paused','diverged') AND e.status='queued'
   AND NOT EXISTS(SELECT 1 FROM strategy_allocation_closures c WHERE c.allocation_id=a.id);
  INSERT INTO strategy_allocation_closures(id,allocation_id,reason,status,opened_at,updated_at)
   SELECT gen_random_uuid(),a.id,'archive','awaiting',NEW.archived_at,NEW.archived_at FROM strategy_allocations a
   WHERE a.strategy_id=NEW.id AND a.status IN ('active','paused','diverged')
   ON CONFLICT (allocation_id) DO NOTHING;
  UPDATE strategy_allocations SET planning_reason_code='strategy_archived',planning_deferred_until=NULL,updated_at=NEW.archived_at
   WHERE strategy_id=NEW.id AND status IN ('active','paused','diverged')
    AND id IN (SELECT allocation_id FROM strategy_allocation_closures WHERE reason='archive' AND status='awaiting');
 ELSIF NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL THEN
  DELETE FROM strategy_allocation_closures c USING strategy_allocations a
   WHERE c.allocation_id=a.id AND a.strategy_id=NEW.id AND c.reason='archive' AND c.status IN ('awaiting','failed');
  UPDATE strategy_allocations SET planning_reason_code=NULL,updated_at=now()
   WHERE strategy_id=NEW.id AND planning_reason_code='strategy_archived';
 END IF;
 RETURN NEW; END $$;
`};
