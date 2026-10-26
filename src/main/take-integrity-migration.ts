export const takeIntegrityMigration = { version: 6, name: 'Take ordering, default instruction mode and attachment leases', sql: `
CREATE SEQUENCE take_message_sequence;
ALTER TABLE take_messages ADD COLUMN sequence bigint;
WITH ranked AS (
 SELECT id, row_number() OVER (ORDER BY data->>'createdAt', CASE data->>'role' WHEN 'user' THEN 0 ELSE 1 END, id) AS n
 FROM take_messages
) UPDATE take_messages SET sequence=ranked.n FROM ranked WHERE take_messages.id=ranked.id;
SELECT setval('take_message_sequence', coalesce((SELECT max(sequence) FROM take_messages),0)+1, false);
ALTER TABLE take_messages ALTER COLUMN sequence SET DEFAULT nextval('take_message_sequence');
ALTER TABLE take_messages ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX take_messages_sequence ON take_messages(sequence);
ALTER TABLE ai_instruction_revisions ADD COLUMN mode text NOT NULL DEFAULT 'custom'
 CHECK (mode IN ('custom','follow_app_default'));
ALTER TABLE take_attachments ADD COLUMN staged_until timestamptz DEFAULT now()+interval '1 hour';
UPDATE take_attachments a SET staged_until=NULL WHERE
 EXISTS(SELECT 1 FROM takes t, jsonb_array_elements(t.draft_images) i WHERE t.id=a.take_id AND i->>'id'=a.id::text)
 OR EXISTS(SELECT 1 FROM take_messages m, jsonb_array_elements(coalesce(m.data->'images','[]')) i WHERE m.take_id=a.take_id AND i->>'id'=a.id::text);
` };
