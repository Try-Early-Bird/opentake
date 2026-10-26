export const platformAccessMigration = { version: 11, name: 'Optional platform data verification', sql: `
CREATE TABLE platform_access_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 verify boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1
);
INSERT INTO platform_access_settings DEFAULT VALUES;
CREATE TABLE take_platform_context (
 take_id uuid PRIMARY KEY REFERENCES takes(id) ON DELETE CASCADE,
 accounts jsonb NOT NULL DEFAULT '[]'
);
-- Old transcripts may contain platform information even without stored tool results.
INSERT INTO take_platform_context(take_id,accounts)
 SELECT DISTINCT take_id,'["legacy-platform-context"]'::jsonb FROM take_messages WHERE data->>'role'='assistant';
CREATE TABLE platform_access_grants (
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 provider text NOT NULL, scope text NOT NULL, revision integer NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(take_id,provider,scope,revision)
);
CREATE TABLE platform_access_requests (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES take_runs(id) ON DELETE CASCADE,
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 provider text NOT NULL, scope text NOT NULL, revision integer NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','approved','declined','expired','consumed')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 decided_at timestamptz
);
CREATE INDEX platform_access_pending ON platform_access_requests(state,expires_at);
UPDATE mcp_servers SET config=jsonb_set(config,'{name}','"Opentake platforms"')
 WHERE id='00000000-0000-4000-8000-000000000001';
` };
