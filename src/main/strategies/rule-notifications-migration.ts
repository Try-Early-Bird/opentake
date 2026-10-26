export const ruleNotificationsMigration={version:94,name:'Opt-in rule notification delivery',sql:`
ALTER TABLE strategy_rule_shadow ADD COLUMN notifications_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE strategy_rule_action_requests DROP CONSTRAINT strategy_rule_action_requests_status_check;
ALTER TABLE strategy_rule_action_requests ADD CONSTRAINT strategy_rule_action_requests_status_check
 CHECK(status IN ('shadow','expired','superseded','context_pending','context_failed','conditions_false','notified'));
`};
