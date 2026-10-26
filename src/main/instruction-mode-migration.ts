export const instructionModeMigration = { version: 10, name: 'Draft and published chat modes', sql: `
ALTER TABLE ai_instruction_profiles ADD COLUMN config jsonb NOT NULL DEFAULT '{"description":"","guidance":"","details":"","completion":"","tools":null}';
ALTER TABLE ai_instruction_profiles ADD COLUMN published jsonb;
UPDATE ai_instruction_profiles SET published=jsonb_build_object('name',name,'text',text,'config',config,'version',1,'publishedAt',updated_at);
CREATE TABLE ai_instruction_versions (
 profile_id uuid NOT NULL REFERENCES ai_instruction_profiles(id) ON DELETE CASCADE,
 version integer NOT NULL, snapshot jsonb NOT NULL, PRIMARY KEY(profile_id,version)
);
INSERT INTO ai_instruction_versions SELECT id,1,published FROM ai_instruction_profiles;
` };
