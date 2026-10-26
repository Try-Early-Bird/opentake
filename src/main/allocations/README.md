# Allocation accounting

How Opentake tracks the money and shares that belong to each Take inside a
shared brokerage account. Financial arithmetic uses decimal strings and scaled
bigints (`decimal.ts`), never floating point. Tests live in `tests/unit/allocations`.

## Model

- An **allocation** is one Take's claim on one account: cash and share
  quantities, with immutable tax-lot bindings.
- The **ledger** (`strategy_attribution_entries`) is append-only. Funding,
  fills, fees, dividend reinvestment, reconciliation and releases are entries;
  nothing is edited in place. Matching a lot appends a binding instead of
  modifying a fill.
- **Instructions** (deposits, withdrawals, closes) are durable and idempotent;
  a retry must carry the same payload.

## Behaviour

- Funding previews; atomic cash reservations, contributions and releases.
  Paused and diverged allocations keep their claims.
- Fill and fee attribution through durable order intents (`../orders`); links
  never come from the renderer or an AI tool. An order the provider accepted is
  not a fill until it fills. External buys stay personal.
- Dividend reinvestment uses the verified entitlement time and the last complete
  positions snapshot before the fill; pending fills block attribution.
- Cash and share reconciliation: lot-loss assignment or a proportional proposal,
  remeasurement on acceptance, small share-gap settlement and detachment.
- Moving-average P&L, valuation by instrument ID, drift, withdrawal sizing and
  guarded FIFO sells against the allocation's own lots.
- Self-directed rules and a database guard protect unreleased cash, shares and lots.
- Opt-in pruning keeps inception and explicit evidence, observations during an
  unreleased allocation, and all history for open cases.

## Integration

- Investing, deposits and rebalances plan and place through `../execution`;
  withdrawals and closes plan, place and settle there too.
- Queued, sent and unknown-outcome legs, and any unresolved order intent on the
  account, block releasing cash or detaching.
- Tax lots come fresh from Robinhood after each sync (`../execution/sell-lots.ts`).
- A restored database requires a fresh sync, a clean review and an explicit
  resume (`resume.ts`); nothing bypasses `restore_required`.

Tests use in-memory or disposable PGlite and injected providers. Failure
injection proves transaction rollback; they are not process-kill or live
brokerage tests.
