export const dataSourceDestinationMigration = { version: 84, name: 'Controlled source price provenance and market metadata', sql: `
ALTER TABLE market_quotes ADD COLUMN price_provider text NOT NULL DEFAULT 'robinhood';
ALTER TABLE market_quotes ADD COLUMN price_source_id uuid REFERENCES data_sources(id);
ALTER TABLE market_quotes ADD COLUMN price_source_revision integer;
ALTER TABLE market_quotes ADD COLUMN price_source_feed text;
CREATE TABLE market_source_metadata (
 owner_id uuid NOT NULL REFERENCES local_owners(id), market_key text NOT NULL,
 namespace text NOT NULL, source_id uuid NOT NULL REFERENCES data_sources(id),
 revision integer NOT NULL, feed_id text NOT NULL, fields jsonb NOT NULL,
 observed_at timestamptz NOT NULL, event_time timestamptz,
 PRIMARY KEY(owner_id,market_key,namespace),
 CHECK (jsonb_typeof(fields)='object' AND octet_length(fields::text)<=16384)
);
CREATE TABLE data_source_destination_status (
 source_id uuid NOT NULL REFERENCES data_sources(id), feed_id text NOT NULL,
 revision integer NOT NULL, target text NOT NULL, outcome text NOT NULL,
 checked_at timestamptz NOT NULL, PRIMARY KEY(source_id,feed_id)
);
` };
