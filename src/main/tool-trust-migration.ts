// A member can trust a server's tool updates (typically their own MCP): its changed
// tools keep their setting instead of being blocked; the change is still shown.
export const toolTrustMigration={version:106,name:'Trust a server\'s tool updates',sql:`
ALTER TABLE mcp_servers ADD COLUMN trust_updates boolean NOT NULL DEFAULT false;
`};
