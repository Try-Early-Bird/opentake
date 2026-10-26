export const metadataTimestampsMigration={version:97,name:'Per-field market metadata update timestamps',sql:`
ALTER TABLE market_source_metadata ADD COLUMN field_timestamps jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK (jsonb_typeof(field_timestamps)='object');
`};
