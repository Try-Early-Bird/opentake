// A rule's agent run waits while its Take is busy with the member's own chat.
export const ruleAgentMigration={version:101,name:'Rule agent runs wait for their Take',sql:`
ALTER TABLE action_jobs DROP CONSTRAINT action_jobs_waiting_for_check;
ALTER TABLE action_jobs ADD CONSTRAINT action_jobs_waiting_for_check CHECK (waiting_for IN ('approval','market_open','funds','inputs','account','take'));
`};
