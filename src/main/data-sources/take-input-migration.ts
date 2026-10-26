export const takeInputMigration={version:87,name:'Versioned read-only Take input bindings',sql:`
CREATE TABLE take_input_revisions (
 take_id uuid NOT NULL REFERENCES takes(id), revision integer NOT NULL CHECK(revision>0),
 accepted_version uuid NOT NULL REFERENCES strategy_versions(id),
 config jsonb NOT NULL CHECK(octet_length(config::text)<=32768),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(take_id,revision)
);
CREATE TRIGGER take_input_revision_immutable BEFORE UPDATE OR DELETE ON take_input_revisions
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
`};
