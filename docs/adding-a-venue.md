# Adding a trading venue

Strategy execution is venue-neutral at its core: worker loops,
per-account queues, action jobs and capability answers talk to a venue registry,
never to a named broker. This guide lists what a new platform needs. Coinbase
(`src/main/venues/coinbase.ts`) is the working example.

## 1. Register the venue

- **Migration.** Append one migration that inserts the venue id:
  `INSERT INTO venues(id) VALUES ('kraken');`. Ids are lowercase,
  `^[a-z][a-z0-9_]{1,31}$`. If the venue appears in older tables that still use
  `CHECK (venue IN ('coinbase','robinhood'))` (`mixed_take_execution_legs`, `strategy_account_routes`,
  `order_activity`), widen those constraints in the same
  migration. Never edit an applied migration; append its checksum to
  `tests/fixtures/migration-checksums.json`.
- **Display data.** Add the label and currencies to `src/shared/investment-venues.ts`.
- **Calendar.** Teach `tradingSessionPolicy` in `src/main/trading/session-policy.ts`
  which asset classes the venue trades and when. Unknown combinations throw; they
  never default to open.

## 2. Write the venue module

A `VenueModule` (`src/main/venues/types.ts`) has:

- **Profile** (required): asset classes, order types, which asset classes accept
  fractional and quote-currency (notional) orders, quote currencies, calendar, and
  per-call timeout and scheduler interval.
- **Adapters** (one per supported action kind): `rebalance_to_target`, `buy`,
  `trim`, `exit`, `deploy_cash`. A missing adapter is a capability answer
  (`action_unsupported`), not an error.
- **Ledger** (required to trade): the venue's Take ledger behind `TakeLedger`.

Register it in `src/main/background-host.ts`:
`createVenueRegistry([coinbaseVenue(ruleTrades), robinhoodVenue, krakenVenue(...)])`.

## 3. Implement an adapter

```ts
interface ActionAdapter<Input, State> {
  kind: ActionKind;
  parse(input: unknown): Input;
  advance(job, { signal, now }): Promise<ActionOutcome<State>>;
  cancel?(job, { signal, now }): Promise<ActionOutcome<State>>;
  recover?(job, { signal, now }): Promise<void>;
}
```

- `advance` moves the adapter's own phases one step (for example: reserve →
  preview → confirm → submit → follow up), keeping progress in `adapterState`.
  The core calls it inside the account's queue, so nothing else moves money on that
  account meanwhile.
- **Before sending an order, record durably that it is being sent** (as Coinbase
  does with `coinbase_order_dispatches.state='sending'`), using a client order id
  the broker can be queried by. After a crash or a lost response, look the order up
  by that id. **Never resend an order whose outcome is unknown**: return
  `needs_attention` (or `waiting` for `account` while it keeps being re-checked).
- Return `running` with `retryInMs` to be called again, `waiting` with a reason to
  wait for approval, market open, funds, inputs or the account, or a terminal state
  (`succeeded`, `blocked`, `failed`, `needs_attention`, `cancelled`) with a
  snake_case reason. Throwing is retried with backoff and asks for attention after
  five errors.
- `cancel` releases reservations and keeps fills. If orders are already out and
  cannot be cancelled now, return `running` or `waiting`; the job continues.
- Honor `signal`: it aborts at the step deadline (2 minutes) and at shutdown.
- Broker calls go through the venue's request queue (`createVenueQueue`), one at a
  time, with a per-call timeout.

## 4. Pass the conformance suite

Run `actionAdapterConformance` (`tests/unit/execution/action-conformance.ts`)
against the adapter with a synthetic broker and database. It checks:

- one order per firing, however often the action or step repeats;
- an unanswered submit is never resent and keeps its reservation;
- a crash after the broker received the order recovers it without resending;
- a refused order releases its reservation;
- cancelling before sending releases everything; after a partial fill it keeps the
  fill and releases the rest;
- a submit hung past the deadline is aborted and never resent.

A case may be marked as covered by named tests in the adapter's own suite (see the
Coinbase harness in `tests/unit/coinbase-order-reviews.test.ts` and the Robinhood one in
`tests/unit/robinhood-rule-conformance.test.ts`), with the reason.
The venue is ready when it passes.

## 5. Scheduling

- Rule firings, sent orders and saved syncs wake the action loop; the interval is a
  backup. If the venue offers pushed order updates (for example a WebSocket user
  channel), wake the loop from them and keep polling as the backup.
- A scheduled or drift rebalancer for the venue runs as its own worker loop
  (`createWorkerLoop`) and holds each account through `AccountQueues.run`.
- Synthetic tests only: no live credentials, profiles or orders. A live check with
  real money is run by the member, with explicit approval of amount and asset.

## A second example: Robinhood

`src/main/strategies/robinhood-rule-trades.ts` adapts a venue whose engine already plans and
places orders (the Robinhood planner and executor). Such an adapter does not submit orders
itself: it previews (a dry run), stores the preview for the member's approval, hands the
approved work to the engine with the approval carried through, and follows the engine's
order records to a terminal state. Never-resend and recovery then stay the engine's, tested
there. Waiting trades join the shared approvals (`rule-trade-approvals.ts`), so a new venue
appears on the same approval card by adding its pending list and decide step.
