export const mcpRemoteSignInMigration = { version: 16, name: 'Remote MCP OAuth credential references', sql: `
CREATE TABLE mcp_oauth_connections (
 server_id uuid PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
 credential_ref text, state text NOT NULL DEFAULT 'disconnected',
 updated_at timestamptz NOT NULL DEFAULT now()
);
` };
