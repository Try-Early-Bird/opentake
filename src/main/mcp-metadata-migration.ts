export const mcpMetadataMigration = { version: 18, name: 'MCP guidance and metadata provenance', sql: `
CREATE TABLE mcp_metadata_revisions (
 id bigserial PRIMARY KEY,
 source_id uuid NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 fingerprint text NOT NULL, previous_fingerprint text,
 summary text NOT NULL,
 snapshot jsonb NOT NULL
);
CREATE INDEX mcp_metadata_source_history ON mcp_metadata_revisions(source_id,id DESC);
ALTER TABLE mcp_servers ADD COLUMN metadata_revision bigint REFERENCES mcp_metadata_revisions(id);
ALTER TABLE mcp_tools ADD COLUMN contract_fingerprint text;
ALTER TABLE tool_invocations ADD COLUMN metadata_revision bigint REFERENCES mcp_metadata_revisions(id);
` };
