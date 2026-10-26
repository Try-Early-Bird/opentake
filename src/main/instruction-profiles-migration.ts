export const instructionProfilesMigration = { version: 9, name: 'Saved AI instruction sets', sql: `
CREATE TABLE ai_instruction_profiles (
 id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 text text NOT NULL CHECK (length(text) <= 24000), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_instruction_profiles_name ON ai_instruction_profiles(lower(name));
ALTER TABLE takes ADD COLUMN instruction_profile_id uuid REFERENCES ai_instruction_profiles(id) ON DELETE SET NULL;
` };
