export const approvalExpiryMigration = { version: 8, name: 'Durable tool approval expiry and decisions', sql: `
ALTER TABLE tool_approvals ADD COLUMN expires_at timestamptz;
UPDATE tool_approvals SET expires_at=created_at+interval '2 minutes';
ALTER TABLE tool_approvals ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE tool_approvals ALTER COLUMN expires_at SET DEFAULT now()+interval '2 minutes';
ALTER TABLE tool_approvals ADD COLUMN decided_at timestamptz;
ALTER TABLE tool_approvals ADD COLUMN consumed_at timestamptz;
UPDATE tool_approvals SET state='expired' WHERE state IN ('pending','approved');
ALTER TABLE tool_approvals ADD CONSTRAINT tool_approval_state CHECK(state IN ('pending','approved','declined','expired','consumed'));
CREATE INDEX pending_tool_approvals ON tool_approvals(expires_at) WHERE state IN ('pending','approved');
` };
