// Delistings (kept on symbol_tradability). A symbol with no close for three trading days while
// others close is asked about; when Robinhood reports it not tradable it is
// marked delisted at its last close. The mark is per symbol, so every
// strategy holding it reacts together: the model closes the sleeve to cash,
// the planner never targets it, and each holding allocation releases the
// shares with an `attribution_release` instruction (no trade).
export const delistingMigration={version:39,name:'Delisted symbols',sql:`
CREATE TABLE symbol_delistings (
 symbol text PRIMARY KEY CHECK(symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$'),
 no_close_since date,
 delisted_on date,
 last_close numeric(38,18) CHECK(last_close>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((delisted_on IS NULL)=(last_close IS NULL))
);
ALTER TABLE strategy_allocation_transactions DROP CONSTRAINT strategy_allocation_transactions_kind_check;
ALTER TABLE strategy_allocation_transactions ADD CONSTRAINT strategy_allocation_transactions_kind_check CHECK(kind IN
 ('investment','contribution','cash_release','version_change','rebalance','redemption','exit','detachment','reconciliation','reinvestment','corporate_action','attribution_release'));
`};
