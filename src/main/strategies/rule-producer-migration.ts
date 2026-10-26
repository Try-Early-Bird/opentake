// A rule's buy/trim/exit suggests a Take change itself (no chat run or message),
// so proposals gain a third producer, `rule`.
export const ruleProducerMigration={version:108,name:'Rules can suggest Take changes',sql:`
ALTER TABLE strategy_proposals DROP CONSTRAINT strategy_proposals_producer_check;
ALTER TABLE strategy_proposals DROP CONSTRAINT strategy_proposals_check;
ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_producer_check CHECK (producer IN ('human','agent','rule'));
ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_check CHECK (producer IN ('human','rule') OR (source_message_id IS NOT NULL AND source_run_id IS NOT NULL));
`};
