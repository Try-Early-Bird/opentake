// Each accepted rule has its own On/Off. An off rule keeps its run count, cooldown and
// receipts; it is not evaluated and starts no new action until it is turned on again.
export const ruleSwitchMigration={version:103,name:'Per-rule on and off',sql:`
ALTER TABLE strategy_rule_accepted ADD COLUMN disabled_rule_ids uuid[] NOT NULL DEFAULT '{}';
`};
