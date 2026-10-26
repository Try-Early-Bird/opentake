// Imported takes and their Robinhood lots, and the day each imported version
// took effect.
// Hosted stamped every strategy buy with the open lot it created and sold by
// naming those lots. The first export carried neither the lot ids nor the day
// each version was published, and the importer opened one claim per symbol,
// so an imported take had no lots: its sells went out unnamed and Robinhood's
// default could take the member's own shares, and its versions took effect on
// the import day. Now:
// - one opening claim may hold several lots (the primary key moves to the
//   pair), and `source_ref` records which source buy a lot came from, so a
//   binding is made once;
// - `strategy_import_lot_ids` keeps hosted's lot ids from a newer export,
//   bound exactly when the lot is still open, ahead of hosted's fill-to-lot
//   matching on the stored source buys;
// - `strategy_version_effective_dates` keeps hosted's publish day for an
//   imported version (versions are immutable; their own created_at is the
//   import time).
export const importLotsMigration={version:43,name:'Imported takes bind their lots and keep publish days',sql:`
ALTER TABLE strategy_lot_bindings DROP CONSTRAINT strategy_lot_bindings_pkey;
ALTER TABLE strategy_lot_bindings ADD PRIMARY KEY(entry_id,open_lot_id);
ALTER TABLE strategy_lot_bindings ADD COLUMN source_ref text;
CREATE UNIQUE INDEX strategy_lot_bindings_source ON strategy_lot_bindings(account_id,source_ref) WHERE source_ref IS NOT NULL;
CREATE TABLE strategy_import_lot_ids (
 account_id uuid NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
 source_entry_id uuid NOT NULL,
 open_lot_id text NOT NULL CHECK(length(open_lot_id) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,source_entry_id)
);
CREATE TABLE strategy_version_effective_dates (
 version_id uuid PRIMARY KEY REFERENCES strategy_versions(id) ON DELETE RESTRICT,
 effective_on date NOT NULL,
 source text NOT NULL CHECK(source IN ('import')),
 created_at timestamptz NOT NULL DEFAULT now()
);
`};
