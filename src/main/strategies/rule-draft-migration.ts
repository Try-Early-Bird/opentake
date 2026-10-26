export const ruleDraftMigration={version:89,name:'Versioned strategy rule drafts',sql:`
CREATE TABLE strategy_rule_draft_revisions (
 take_id uuid NOT NULL REFERENCES takes(id),
 revision integer NOT NULL CHECK(revision>0),
 accepted_version uuid NOT NULL REFERENCES strategy_versions(id),
 input_revision integer NOT NULL CHECK(input_revision>=0),
 config jsonb NOT NULL CHECK(octet_length(config::text)<=131072),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(take_id,revision)
);
CREATE TRIGGER strategy_rule_draft_immutable BEFORE UPDATE OR DELETE ON strategy_rule_draft_revisions
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
`};
