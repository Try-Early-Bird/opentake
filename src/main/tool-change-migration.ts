// Why a tool is blocked (new, its definition changed, or the member blocked it) and,
// for a changed tool, the definition the member last had, so they can see the change.
export const toolChangeMigration={version:104,name:'Tool block reasons and previous definitions',sql:`
ALTER TABLE mcp_tools ADD COLUMN blocked_reason text CHECK (blocked_reason IN ('new','changed','member'));
ALTER TABLE mcp_tools ADD COLUMN previous_definition jsonb;
`};
