export const eventInboxMigration={version:98,name:'Durable accepted rule event inbox',sql:`
CREATE TABLE strategy_rule_event_inbox (
 id bigserial PRIMARY KEY,
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 draft_revision integer NOT NULL,
 rule_id uuid NOT NULL,
 receipt text NOT NULL,
 observation jsonb NOT NULL,
 received_at timestamptz NOT NULL,
 handled_at timestamptz,
 outcome text,
 UNIQUE(take_id,draft_revision,rule_id,receipt)
);
CREATE INDEX strategy_rule_event_pending ON strategy_rule_event_inbox(take_id,draft_revision,rule_id,id) WHERE handled_at IS NULL;
`};
