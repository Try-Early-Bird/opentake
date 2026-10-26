export const usageBudgetMigration={version:24,name:'Reported usage stopping thresholds',sql:`
ALTER TABLE chat_budgets ADD COLUMN output_tokens integer CHECK (output_tokens BETWEEN 1 AND 1000000);
ALTER TABLE chat_budgets ADD COLUMN opencode_cost_usd numeric CHECK (opencode_cost_usd > 0 AND opencode_cost_usd <= 100);
`};
