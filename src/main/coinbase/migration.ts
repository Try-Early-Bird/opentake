export const coinbaseConnectionMigration = { version: 47, name: 'Coinbase portfolio connections', sql: `
ALTER TABLE platform_connections DROP CONSTRAINT platform_connections_owner_id_venue_key;
CREATE UNIQUE INDEX one_legacy_venue_connection ON platform_connections(owner_id,venue) WHERE venue <> 'coinbase';
ALTER TABLE platform_connections ADD COLUMN environment text NOT NULL DEFAULT 'live';
ALTER TABLE platform_connections ADD COLUMN external_account_ref text;
CREATE UNIQUE INDEX platform_account_identity ON platform_connections(owner_id,venue,environment,external_account_ref)
  WHERE external_account_ref IS NOT NULL;
ALTER TABLE platform_connections ADD CONSTRAINT coinbase_portfolio_identity
  CHECK (venue <> 'coinbase' OR (environment = 'live' AND external_account_ref IS NOT NULL));
CREATE TABLE coinbase_connection_details (
  connection_id uuid PRIMARY KEY REFERENCES platform_connections(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  portfolio_name text NOT NULL,
  can_trade boolean NOT NULL,
  issue text
);
` };
