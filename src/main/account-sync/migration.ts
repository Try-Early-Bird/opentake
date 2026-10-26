export const accountSyncMigration = { version: 25, name: 'Persistent account observations, orders and executions', sql: `
ALTER TABLE linked_accounts ADD COLUMN available boolean NOT NULL DEFAULT true;
ALTER TABLE background_jobs DROP CONSTRAINT background_jobs_kind_check;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_kind_check CHECK (kind IN ('account_sync','portfolio_sync'));
CREATE TABLE account_sync_runs (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 resource text NOT NULL CHECK(resource IN ('portfolio','equity_positions','option_positions','equity_orders','option_orders')),
 state text NOT NULL CHECK(state IN ('running','completed','failed','interrupted')),
 started_at timestamptz NOT NULL, finished_at timestamptz, error_code text
);
CREATE TABLE account_sync_checkpoints (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 resource text NOT NULL, watermark timestamptz NOT NULL, discovery_complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(account_id,resource)
);
CREATE TABLE portfolio_snapshots (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 payload_hash text NOT NULL, data jsonb NOT NULL, UNIQUE(account_id,payload_hash)
);
CREATE TABLE position_snapshots (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 asset_class text NOT NULL CHECK(asset_class IN ('equity','option')),
 payload_hash text NOT NULL, data jsonb NOT NULL, UNIQUE(account_id,asset_class,payload_hash)
);
-- An observation is recorded even for unchanged or empty holdings. Snapshot
-- contents are immutable and deduplicated; observation time is never rewritten.
CREATE TABLE account_observations (
 id uuid PRIMARY KEY, run_id uuid NOT NULL UNIQUE REFERENCES account_sync_runs(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 resource text NOT NULL, observed_at timestamptz NOT NULL,
 portfolio_snapshot_id uuid REFERENCES portfolio_snapshots(id) ON DELETE RESTRICT,
 position_snapshot_id uuid REFERENCES position_snapshots(id) ON DELETE RESTRICT,
 CHECK ((portfolio_snapshot_id IS NOT NULL)::int + (position_snapshot_id IS NOT NULL)::int = 1)
);
CREATE INDEX account_observations_latest ON account_observations(account_id,resource,observed_at DESC);
CREATE TABLE account_orders (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 provider text NOT NULL, provider_ref text NOT NULL,
 asset_class text NOT NULL CHECK(asset_class IN ('equity','option')),
 state text NOT NULL, terminal boolean NOT NULL, data jsonb NOT NULL,
 first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
 PRIMARY KEY(account_id,provider,provider_ref)
);
CREATE TABLE account_executions (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 provider text NOT NULL, provider_ref text NOT NULL, order_ref text NOT NULL,
 asset_class text NOT NULL CHECK(asset_class IN ('equity','option')),
 data jsonb NOT NULL, occurred_at timestamptz NOT NULL,
 attribution_state text NOT NULL DEFAULT 'pending' CHECK(attribution_state IN ('pending','deferred','completed')),
 attributed_at timestamptz,
 PRIMARY KEY(account_id,provider,provider_ref),
 FOREIGN KEY(account_id,provider,order_ref) REFERENCES account_orders(account_id,provider,provider_ref) ON DELETE RESTRICT
);
CREATE TABLE account_sync_gaps (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 resource text NOT NULL, from_at timestamptz NOT NULL, to_at timestamptz NOT NULL,
 reason text NOT NULL, UNIQUE(account_id,resource,from_at,to_at)
);
` };
