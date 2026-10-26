export const takeIconMigration = { version: 45, name: 'Take icons reuse retained image attachments', sql: `
ALTER TABLE takes ADD COLUMN icon_attachment_id uuid REFERENCES take_attachments(id) ON DELETE SET NULL;
CREATE INDEX takes_icon_attachment ON takes(icon_attachment_id) WHERE icon_attachment_id IS NOT NULL;
` };
