export const takeMigration = { version: 3, name: 'Persistent takes, instructions, attachments and tool configuration', sql: `
CREATE TABLE takes (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES local_owners(id),
 title text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 head_id uuid, draft text NOT NULL DEFAULT '', draft_images jsonb NOT NULL DEFAULT '[]',
 instructions text NOT NULL DEFAULT '', selection jsonb NOT NULL
);
CREATE INDEX takes_recent ON takes(archived_at, updated_at DESC);
CREATE TABLE take_messages (
 id uuid PRIMARY KEY, take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 parent_id uuid REFERENCES take_messages(id), data jsonb NOT NULL
);
CREATE INDEX take_messages_take ON take_messages(take_id);
CREATE TABLE take_attachments (
 id uuid PRIMARY KEY, take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 metadata jsonb NOT NULL, image text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_instruction_revisions (id uuid PRIMARY KEY, text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE take_runs (
 id uuid PRIMARY KEY, take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 request_id uuid NOT NULL UNIQUE, state text NOT NULL, configuration jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE mcp_servers (id uuid PRIMARY KEY, config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1);
CREATE TABLE mcp_tools (server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE, name text NOT NULL, definition jsonb NOT NULL, fingerprint text NOT NULL, policy text NOT NULL DEFAULT 'blocked' CHECK (policy IN ('blocked','ask','allowed')), PRIMARY KEY(server_id,name));
CREATE TABLE tool_approvals (id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES take_runs(id) ON DELETE CASCADE, server_id text NOT NULL, tool_name text NOT NULL, input jsonb NOT NULL, fingerprint text NOT NULL, state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now());
` };
