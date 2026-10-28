// Chat's requests to turn on a tool, kept until the member decides. A request
// changes nothing until the member approves it from the reply that made it, so
// it waits for them instead of holding the reply open on a timed approval.
export const toolAccessRequestMigration={version:112,name:'Tool access requests decided after the reply',sql:`
CREATE TABLE tool_access_requests (
 id uuid PRIMARY KEY,
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES take_messages(id) ON DELETE CASCADE,
 run_id uuid REFERENCES take_runs(id) ON DELETE SET NULL,
 server_id uuid NOT NULL,
 tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 200),
 policy text NOT NULL CHECK (policy IN ('ask','allowed')),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 300),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','superseded')),
 created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz
);
CREATE INDEX tool_access_requests_message ON tool_access_requests(message_id);
CREATE UNIQUE INDEX tool_access_requests_one_pending ON tool_access_requests(take_id,server_id,tool_name) WHERE status='pending';
`};
// What the member granted: the setting chat asked for, or "ask" when they
// turned the tool on but kept approving each use.
export const toolAccessGrantedMigration={version:113,name:'Tool access requests record the setting granted',sql:`
ALTER TABLE tool_access_requests ADD COLUMN granted text CHECK (granted IN ('ask','allowed'));
`};
