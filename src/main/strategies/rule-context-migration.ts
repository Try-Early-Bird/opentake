export const ruleContextMigration={version:91,name:'Conditional rule context jobs',sql:`
ALTER TABLE strategy_rule_action_requests DROP CONSTRAINT strategy_rule_action_requests_status_check;
ALTER TABLE strategy_rule_action_requests ADD CONSTRAINT strategy_rule_action_requests_status_check
 CHECK(status IN ('shadow','expired','superseded','context_pending','context_failed','conditions_false'));
CREATE INDEX strategy_rule_context_pending ON strategy_rule_action_requests(created_at,id) WHERE status='context_pending';
`};
