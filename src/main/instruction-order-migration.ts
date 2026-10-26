export const instructionOrderMigration = { version: 7, name: 'Deterministic AI instruction revision order', sql: `
CREATE SEQUENCE ai_instruction_sequence;
ALTER TABLE ai_instruction_revisions ADD COLUMN sequence bigint;
WITH ranked AS (
 SELECT id, row_number() OVER (ORDER BY created_at, ctid) AS n FROM ai_instruction_revisions
) UPDATE ai_instruction_revisions SET sequence=ranked.n FROM ranked WHERE ai_instruction_revisions.id=ranked.id;
SELECT setval('ai_instruction_sequence',coalesce((SELECT max(sequence) FROM ai_instruction_revisions),0)+1,false);
ALTER TABLE ai_instruction_revisions ALTER COLUMN sequence SET DEFAULT nextval('ai_instruction_sequence');
ALTER TABLE ai_instruction_revisions ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX ai_instruction_revisions_sequence ON ai_instruction_revisions(sequence);
` };
