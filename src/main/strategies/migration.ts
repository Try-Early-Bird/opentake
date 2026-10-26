export const strategyAuthoringMigration={version:28,name:'Basket proposal revisions, commit acceptance and authoring provenance',sql:`
ALTER TABLE takes ADD COLUMN strategy_id uuid UNIQUE REFERENCES strategies(id) ON DELETE RESTRICT;
ALTER TABLE strategies ADD COLUMN draft_revision_id uuid;
CREATE TABLE strategy_proposals (
 id uuid PRIMARY KEY, strategy_id uuid NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE RESTRICT,
 target_take_id uuid NOT NULL REFERENCES takes(id) ON DELETE RESTRICT,
 source_take_id uuid NOT NULL REFERENCES takes(id) ON DELETE RESTRICT,
 source_message_id uuid REFERENCES take_messages(id) ON DELETE RESTRICT,
 source_run_id uuid REFERENCES take_runs(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0), base_version_id uuid,
 copied_from_id uuid REFERENCES strategy_proposals(id) ON DELETE RESTRICT,
 previous_revision_id uuid REFERENCES strategy_proposals(id) ON DELETE RESTRICT,
 producer text NOT NULL CHECK(producer IN ('human','agent')), producer_identity jsonb NOT NULL,
 payload jsonb NOT NULL, platform_context jsonb NOT NULL, verification jsonb NOT NULL,
 operation_id uuid NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,operation_id), UNIQUE(strategy_id,revision), UNIQUE(strategy_id,id),
 FOREIGN KEY(strategy_id,base_version_id) REFERENCES strategy_versions(strategy_id,id) ON DELETE RESTRICT,
 CHECK(producer='human' OR (source_message_id IS NOT NULL AND source_run_id IS NOT NULL))
);
ALTER TABLE strategies ADD CONSTRAINT strategy_draft_revision_fk FOREIGN KEY(id,draft_revision_id) REFERENCES strategy_proposals(strategy_id,id) ON DELETE RESTRICT;
ALTER TABLE strategy_versions ADD COLUMN source_proposal_id uuid REFERENCES strategy_proposals(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX strategy_one_acceptance ON strategy_versions(source_proposal_id) WHERE source_proposal_id IS NOT NULL;
CREATE TABLE strategy_commit_operations (
 owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 version_id uuid NOT NULL REFERENCES strategy_versions(id) ON DELETE RESTRICT,
 PRIMARY KEY(owner_id,operation_id)
);
CREATE INDEX strategy_proposals_message ON strategy_proposals(source_message_id,revision);
CREATE INDEX strategy_proposals_source ON strategy_proposals(source_take_id);
CREATE TRIGGER strategy_proposals_immutable BEFORE UPDATE OR DELETE ON strategy_proposals FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE TRIGGER strategy_commit_operations_immutable BEFORE UPDATE OR DELETE ON strategy_commit_operations FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
-- Take archival controls only the strategy it originated, never another target.
CREATE FUNCTION archive_origin_strategy() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.strategy_id IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
  UPDATE strategies SET archived_at=NEW.archived_at,updated_at=now() WHERE id=NEW.strategy_id;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER take_strategy_archival AFTER UPDATE OF archived_at ON takes FOR EACH ROW EXECUTE FUNCTION archive_origin_strategy();
`};
