export const takeContextMigration={version:22,name:'Persisted take context summaries',sql:`
CREATE TABLE take_context_summaries (
 id uuid PRIMARY KEY,
 take_id uuid NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES take_messages(id) ON DELETE CASCADE,
 source_hash text NOT NULL,
 algorithm text NOT NULL,
 text text NOT NULL,
 provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(take_id,message_id,source_hash,algorithm)
);
CREATE INDEX take_context_summaries_take ON take_context_summaries(take_id);
`};
