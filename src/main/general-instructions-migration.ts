// General becomes a built-in instruction set. A General that follows the app
// default keeps following it; a customized General carries its latest text as
// version 1. ai_instruction_revisions stays as history and is no longer written.
export const generalInstructionsMigration = { version: 14, name: 'General instruction set and about-you context', sql: `
CREATE TABLE ai_user_context (
 owner_id uuid PRIMARY KEY REFERENCES local_owners(id) ON DELETE CASCADE,
 about text NOT NULL DEFAULT '' CHECK (length(about) <= 6000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_user_context(owner_id) SELECT id FROM local_owners;
ALTER TABLE ai_instruction_profiles ADD COLUMN builtin text UNIQUE CHECK (builtin = 'general');
ALTER TABLE ai_instruction_profiles ADD COLUMN follows_default boolean NOT NULL DEFAULT false;
UPDATE ai_instruction_profiles SET name=left(name,73)||' ('||left(id::text,4)||')' WHERE lower(name)='general';
WITH latest AS (
 SELECT text FROM ai_instruction_revisions WHERE mode='custom' AND sequence=(SELECT max(sequence) FROM ai_instruction_revisions)
), general AS (
 SELECT gen_random_uuid() AS id, (SELECT text FROM latest) AS custom,
  '{"description":"Everyday conversations and research.","guidance":"","details":"","completion":"","tools":null}'::jsonb AS config
)
INSERT INTO ai_instruction_profiles(id,name,text,config,published,builtin,follows_default)
SELECT id,'General',coalesce(custom,''),config,
 jsonb_build_object('name','General','text',coalesce(custom,''),'config',config,'version',1,'publishedAt',now(),'followsDefault',custom IS NULL),
 'general',custom IS NULL FROM general;
INSERT INTO ai_instruction_versions(profile_id,version,snapshot) SELECT id,1,published FROM ai_instruction_profiles WHERE builtin='general';
` };
