export const ruleProposalMigration={version:93,name:'Chat rule proposals and accepted revisions',sql:`
CREATE TABLE strategy_rule_accepted (
 take_id uuid PRIMARY KEY REFERENCES takes(id),
 revision integer NOT NULL,
 FOREIGN KEY(take_id,revision) REFERENCES strategy_rule_draft_revisions(take_id,revision)
);
-- Preserve only explicitly enrolled shadow configurations; unapproved drafts stay drafts.
INSERT INTO strategy_rule_accepted SELECT take_id,draft_revision FROM strategy_rule_shadow;
CREATE TABLE strategy_rule_proposals (
 id uuid PRIMARY KEY,
 take_id uuid NOT NULL REFERENCES takes(id),
 message_id uuid NOT NULL REFERENCES take_messages(id),
 run_id uuid NOT NULL REFERENCES take_runs(id),
 operation_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL,
 base_revision integer NOT NULL,
 base_version uuid NOT NULL REFERENCES strategy_versions(id),
 base_input_revision integer NOT NULL,
 config jsonb NOT NULL CHECK(octet_length(config::text)<=131072),
 inputs jsonb NOT NULL,
 before_config jsonb NOT NULL,
 before_inputs jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed','superseded')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strategy_rule_proposals_message ON strategy_rule_proposals(message_id);
CREATE INDEX strategy_rule_proposals_take ON strategy_rule_proposals(take_id,created_at DESC);
`};
