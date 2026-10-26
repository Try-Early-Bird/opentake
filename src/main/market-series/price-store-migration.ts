// Local price store: the latest quote and the daily
// closes for every symbol the member holds or a strategy targets, polled from
// the member's own Robinhood connection by the background host. Prices are
// public market data, not account evidence, so rows are overwritten in place.
export const priceStoreMigration={version:31,name:'Local market quotes and daily closes',sql:`
CREATE TABLE market_quotes (
 symbol text PRIMARY KEY CHECK(symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$'),
 price numeric(38,18) CHECK(price>0), previous_close numeric(38,18) CHECK(previous_close>0),
 extended_price numeric(38,18) CHECK(extended_price>0), last_trade_at timestamptz,
 observed_at timestamptz NOT NULL
);
CREATE TABLE market_daily_closes (
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$'),
 day date NOT NULL, close numeric(38,18) NOT NULL CHECK(close>0),
 observed_at timestamptz NOT NULL, PRIMARY KEY(symbol,day)
);
`};

// The built chart series (any interval) per range and symbol, persisted so
// charts survive restarts and every screen reads one copy. Rebuilt in place.
export const seriesCacheMigration={version:32,name:'Persistent market series cache',sql:`
CREATE TABLE market_series_cache (
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$'),
 range text NOT NULL CHECK(range IN ('1d','1w','1m','3m','1y','all')),
 fetched_at timestamptz NOT NULL, series jsonb NOT NULL, PRIMARY KEY(range,symbol)
);
`};
