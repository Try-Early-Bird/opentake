export const toolGovernanceMigration = { version: 12, name: 'Scoped tool permissions and invocation history', sql: `
ALTER TABLE mcp_servers ADD COLUMN policy text NOT NULL DEFAULT 'allowed' CHECK(policy IN ('blocked','ask','allowed'));
CREATE TABLE take_tool_permissions (
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
 tool_name text NOT NULL DEFAULT '',
 policy text NOT NULL CHECK(policy IN ('blocked','ask','allowed')),
 PRIMARY KEY(take_id,server_id,tool_name)
);
CREATE TABLE tool_invocations (
 id uuid PRIMARY KEY, sequence bigserial UNIQUE,
 run_id uuid NOT NULL REFERENCES take_runs(id) ON DELETE CASCADE,
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 provider text NOT NULL, server_id uuid, server_name text NOT NULL,
 tool_name text NOT NULL, destination text NOT NULL,
 state text NOT NULL, "authorization" text NOT NULL DEFAULT 'automatic',
 platform_sharing boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
 finished_at timestamptz, detail text NOT NULL DEFAULT ''
);
CREATE INDEX tool_invocations_take_sequence ON tool_invocations(take_id,sequence DESC);
ALTER TABLE tool_approvals ADD COLUMN invocation_id uuid REFERENCES tool_invocations(id) ON DELETE SET NULL;
ALTER TABLE tool_approvals ADD COLUMN platform_sharing boolean NOT NULL DEFAULT false;
ALTER TABLE tool_approvals ADD COLUMN destination text NOT NULL DEFAULT '';
ALTER TABLE tool_approvals ADD COLUMN server_name text NOT NULL DEFAULT '';
` };
