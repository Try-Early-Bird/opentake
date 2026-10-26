// When a tool's definition changed, for "Changed since you allowed it · Oct 22".
export const toolChangedAtMigration={version:105,name:'Tool change time',sql:`
ALTER TABLE mcp_tools ADD COLUMN changed_at timestamptz;
`};
