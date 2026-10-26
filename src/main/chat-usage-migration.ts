export const chatUsageMigration={version:20,name:'Chat usage summaries and budgets',sql:`
ALTER TABLE take_runs ADD COLUMN usage jsonb;
CREATE TABLE chat_budgets (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), claude_cost_usd numeric CHECK (claude_cost_usd > 0 AND claude_cost_usd <= 100));
INSERT INTO chat_budgets(singleton) VALUES(true);
`};
