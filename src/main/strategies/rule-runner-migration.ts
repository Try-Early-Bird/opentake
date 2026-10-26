export const ruleRunnerMigration={version:90,name:'Shadow rule state and action evidence',sql:`
CREATE TABLE strategy_rule_shadow (
 take_id uuid PRIMARY KEY REFERENCES takes(id),
 draft_revision integer NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(take_id,draft_revision) REFERENCES strategy_rule_draft_revisions(take_id,revision)
);
CREATE TABLE strategy_rule_state (
 take_id uuid NOT NULL,
 draft_revision integer NOT NULL,
 rule_id uuid NOT NULL,
 state jsonb NOT NULL,
 reason text NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(take_id,draft_revision,rule_id),
 FOREIGN KEY(take_id,draft_revision) REFERENCES strategy_rule_draft_revisions(take_id,revision)
);
CREATE TABLE strategy_rule_action_requests (
 id uuid PRIMARY KEY,
 take_id uuid NOT NULL,
 draft_revision integer NOT NULL,
 rule_id uuid NOT NULL,
 firing_key text NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('shadow','expired','superseded')),
 action jsonb NOT NULL,
 evidence jsonb NOT NULL CHECK(octet_length(evidence::text)<=262144),
 UNIQUE(take_id,draft_revision,rule_id,firing_key),
 FOREIGN KEY(take_id,draft_revision) REFERENCES strategy_rule_draft_revisions(take_id,revision)
);
CREATE INDEX strategy_rule_action_pending ON strategy_rule_action_requests(take_id,draft_revision,rule_id) WHERE status='shadow';
`};
