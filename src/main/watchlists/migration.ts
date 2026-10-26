// The member's lists. A list may mirror one on a venue (Robinhood);
// the mirror is the authority only for the items it reports (source 'mirror').
// Market items carry the canonical identity and its marketKey, so one asset on
// two venues is two rows. Take items reference the strategy.
export const watchlistMigration={version:111,name:'Watchlists across venues',sql:`
CREATE TABLE watchlists (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
 icon_emoji text CHECK (icon_emoji IS NULL OR length(icon_emoji) BETWEEN 1 AND 16),
 venue text REFERENCES venues(id),
 connection_id uuid REFERENCES platform_connections(id) ON DELETE CASCADE,
 external_id text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 200),
 external_owner_type text CHECK (external_owner_type IN ('custom','curated')),
 position integer NOT NULL DEFAULT 0,
 archived_at timestamptz,
 last_synced_at timestamptz,
 items_synced_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((external_id IS NULL) = (venue IS NULL) AND (external_id IS NULL) = (connection_id IS NULL) AND (external_id IS NULL) = (external_owner_type IS NULL))
);
CREATE UNIQUE INDEX watchlists_external ON watchlists(connection_id,external_id) WHERE external_id IS NOT NULL;
CREATE INDEX watchlists_owner_position ON watchlists(owner_id,position);
CREATE TABLE watchlist_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 watchlist_id uuid NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('market','take')),
 source text NOT NULL DEFAULT 'app' CHECK (source IN ('app','mirror')),
 venue text REFERENCES venues(id),
 market_key text CHECK (market_key IS NULL OR length(market_key) BETWEEN 1 AND 1200),
 identity jsonb,
 symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 80),
 name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 300),
 strategy_id uuid REFERENCES strategies(id) ON DELETE CASCADE,
 external_object_type text CHECK (external_object_type IS NULL OR length(external_object_type) BETWEEN 1 AND 80),
 external_object_id text CHECK (external_object_id IS NULL OR length(external_object_id) BETWEEN 1 AND 200),
 position integer NOT NULL DEFAULT 0,
 added_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz,
 CHECK ((kind='take' AND strategy_id IS NOT NULL AND venue IS NULL AND market_key IS NULL AND identity IS NULL AND symbol IS NULL AND source='app')
  OR (kind='market' AND strategy_id IS NULL AND venue IS NOT NULL AND market_key IS NOT NULL AND identity IS NOT NULL AND symbol IS NOT NULL)),
 CHECK ((source='mirror') = (external_object_id IS NOT NULL))
);
CREATE UNIQUE INDEX watchlist_items_market ON watchlist_items(watchlist_id,market_key) WHERE market_key IS NOT NULL;
CREATE UNIQUE INDEX watchlist_items_take ON watchlist_items(watchlist_id,strategy_id) WHERE strategy_id IS NOT NULL;
CREATE UNIQUE INDEX watchlist_items_external ON watchlist_items(watchlist_id,external_object_id) WHERE external_object_id IS NOT NULL;
CREATE INDEX watchlist_items_list_position ON watchlist_items(watchlist_id,position);
CREATE INDEX watchlist_items_venue_symbol ON watchlist_items(venue,symbol) WHERE kind='market';
`};
