// Whether chat and rule runs may delegate research to subagents, where the
// provider supports it. On by default; members can turn it off in AI settings.
export const subagentSettingMigration={version:116,name:'Subagent setting',sql:`
ALTER TABLE chat_budgets ADD COLUMN subagents boolean NOT NULL DEFAULT true;
`};
