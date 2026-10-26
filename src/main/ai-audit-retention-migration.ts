export const aiAuditRetentionMigration = { version: 17, name: 'AI audit retention settings', sql: `
CREATE TABLE ai_audit_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 retention_days integer CHECK (retention_days IN (7,30,90))
);
INSERT INTO ai_audit_settings DEFAULT VALUES;
CREATE INDEX ai_audit_traces_expiration ON ai_audit_traces(finished_at,id) WHERE state <> 'running';
` };
