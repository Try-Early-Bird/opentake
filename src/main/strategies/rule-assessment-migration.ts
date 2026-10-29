// What an automatic rule run concluded: a fixed verdict and a short summary,
// reported by the agent and shown in the notification and rule history.
export const ruleAssessmentMigration={version:115,name:'Rule agent assessments',sql:`
ALTER TABLE strategy_rule_action_requests ADD COLUMN assessment jsonb CHECK (assessment IS NULL OR octet_length(assessment::text)<=8192);
`};
