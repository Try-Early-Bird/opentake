export const ruleRetentionMigration={version:92,name:'Rule evidence retention and durable firing receipts',sql:`
CREATE TABLE strategy_rule_firing_receipts (
 take_id uuid NOT NULL,
 draft_revision integer NOT NULL,
 rule_id uuid NOT NULL,
 firing_key text NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(take_id,draft_revision,rule_id,firing_key),
 FOREIGN KEY(take_id,draft_revision) REFERENCES strategy_rule_draft_revisions(take_id,revision)
);
INSERT INTO strategy_rule_firing_receipts(take_id,draft_revision,rule_id,firing_key,created_at)
 SELECT take_id,draft_revision,rule_id,firing_key,created_at FROM strategy_rule_action_requests;
CREATE TRIGGER strategy_rule_receipt_immutable BEFORE UPDATE OR DELETE ON strategy_rule_firing_receipts
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
CREATE FUNCTION strategy_rule_claim_firing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO strategy_rule_firing_receipts(take_id,draft_revision,rule_id,firing_key,created_at)
 VALUES(NEW.take_id,NEW.draft_revision,NEW.rule_id,NEW.firing_key,NEW.created_at)
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER strategy_rule_claim_firing BEFORE INSERT ON strategy_rule_action_requests
 FOR EACH ROW EXECUTE FUNCTION strategy_rule_claim_firing();
ALTER TABLE strategy_rule_action_requests ADD COLUMN retained_bytes bigint GENERATED ALWAYS AS
 (octet_length(evidence::text)::bigint+octet_length(action::text)::bigint+256) STORED;
CREATE INDEX strategy_rule_evidence_retention ON strategy_rule_action_requests(created_at,id)
 WHERE status NOT IN ('shadow','context_pending');
`};
