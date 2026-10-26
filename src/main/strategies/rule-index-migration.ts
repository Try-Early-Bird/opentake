export const ruleIndexMigration={version:99,name:'Rule inbox cleanup and request timeline indexes',sql:`
CREATE INDEX strategy_rule_event_received ON strategy_rule_event_inbox(received_at);
CREATE INDEX strategy_rule_action_take_created ON strategy_rule_action_requests(take_id,created_at,id);
`};
