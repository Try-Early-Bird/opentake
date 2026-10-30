# Adding a trading venue

The **action-job core** is venue-neutral: worker loops, per-account queues,
action jobs, rule queueing and the shared approval card talk to a venue
registry, never to a named broker. **The rest of the app is not yet**: connecting
an account, syncing it, pricing and valuing it, the Take ledger, rule policy,
agent read tools and the renderer each still name Coinbase or Robinhood, and
several of those branches are two-way (`coinbase ? … : robinhood`), so a third
venue fails silently rather than at compile time. The redesign that closes this
gap, slot by slot, is tracked in the local `plans/venue-connector-redesign.md`;
this guide is updated as each slot lands.

Coinbase (`src/main/venues/coinbase.ts`) is the working example of a venue module.
Read this whole page before starting: the registration steps alone produce a
venue whose accounts cannot be configured or authorised.

## 0. Know what fails silently today

Until the renderer and host registries exist, a venue that is only registered
in the action core will:

- show the **Coinbase logo** in seven renderer spots that choose
  `venue==='robinhood' ? Robinhood : Coinbase`;
- have its **agent reads routed to Robinhood** (`background-host.ts` treats
  every platform that is not `coinbase` as Robinhood);
- be **rejected by the account-plan schema** and filtered out of account plans
  and trading grants (see §1);
- return **no prices, no performance** (`market-price-reader.ts` answers
  `unsupported`; `performance.ts` answers `null`).

None of these raise an error. Check each when adding a venue.

## 1. Register the venue

- **Migration.** Append one migration that inserts the venue id:
  `INSERT INTO venues(id) VALUES ('kraken');`. Ids are lowercase,
  `^[a-z][a-z0-9_]{1,31}$`. Widen the three remaining
  `CHECK (venue IN ('coinbase','robinhood'))` constraints in the same migration:
  `strategy_account_routes` (`strategies/account-plan-migration.ts`),
  `order_activity` (`trading/activity-migration.ts`) and
  `mixed_take_execution_legs` (`mixed-execution/execution-migration.ts`).
  Decide whether the venue allows several connections per member; today the
  `one_legacy_venue_connection` index (`coinbase/migration.ts`) limits every
  venue except Coinbase to one. Never edit an applied migration; append its
  checksum to `tests/fixtures/migration-checksums.json`.
- **Admission paths.** Without these the venue's accounts cannot be put on a
  Take or granted trading, however well the adapter works. The venue filters
  in account plans, rule granting, notifications and the data-source inventory,
  plus the account-plan route enum and cap, all read one list,
  `investmentVenueIds` in `src/shared/investment-venues.ts`, so they widen
  when the venue is added there (see "Display data, last" below). Still
  per venue:
  - `src/main/strategies/account-plans.ts`: the per-venue "can this account
    trade" check (Coinbase `can_trade`, Robinhood `agentic_allowed`) and the
    per-venue buying-power read;
  - `src/main/strategies/rule-action-policy.ts`: the "live" check that labels
    a rule `trading` or `preview_only` for agents counts only Coinbase routes.
- **Calendar.** Teach `tradingSessionPolicy` in `src/main/trading/session-policy.ts`
  which asset classes the venue trades and when. Unknown combinations throw; they
  never default to open.
- **Display data, last.** Adding a key to `src/shared/investment-venues.ts`
  widens `InvestmentVenue`, which breaks the build at
  `mixed-execution/adapters.ts` and `renderer/.../InvestmentVenuePanel.tsx` until
  a mixed-execution adapter and an investment panel exist. Do this step after
  those exist, not first.

## 2. Write the venue module

A `VenueModule` (`src/main/venues/types.ts`) has:

- **Profile** (required): asset classes, order types, which asset classes accept
  fractional and quote-currency (notional) orders, quote currencies, calendar, and
  per-call timeout and scheduler interval. *Today only `id`, `label` and
  `assetClasses` are read by the core (`actionCapability`). The other fields are
  declared for the redesign and change nothing yet; the venue's own code must
  still enforce them.*
- **Adapters** (one per supported action kind): `rebalance_to_target`,
  `deploy_cash`, `reduce`, and later `buy`, `trim`, `exit`. A missing adapter is
  a capability answer (`action_unsupported`), not an error, **provided the
  venue's `queue` has enqueued the job**: nothing is answered for a firing that
  was never enqueued.
- **Queue** (required to trade): `queue.enqueue()` turns accepted rule firings
  on the venue's accounts into `action_jobs` rows with
  `idempotency_key='rule:'||request_id`. The host tick calls every registered
  venue's `queue` before advancing jobs. Without it, firings sit in `shadow`
  until they expire.
- **Approvals** (required when the member can be asked): `approvals.pending(takeId)`
  lists trades waiting for the member as `PendingTrade`s;
  `approvals.approve(requestId)` carries out the approval. Declining is the
  core's cancel of the action job. The shared approval card lists every
  registered venue's pending trades and routes each decision back to its venue;
  set `estimated:true` when the orders are sized again at placement.
- **Admission** (`admission:'core'`, recommended for a new venue): the core
  checks, before a trade job's first adapter step, that trading is on, the
  venue can do the action, the account is available, and the firing is still
  active, accepted, granted and not switched off (`execution/admission.ts`,
  the same checks and reasons as the Robinhood guard). A refused job is
  `blocked` with the reason and never reaches the adapter. Only a job the
  adapter has never seen is blocked this way; the core records `started_at`
  before every adapter call and never ends a started job itself. Coinbase and
  Robinhood leave this unset and keep their own engine checks, so their
  outcomes are unchanged. With `admission:'core'` the adapter still re-checks
  at dispatch time (§3); admission does not see final orders.
- **Ledger**: `VenueModule.ledger` (`TakeLedger`) is **declared but not yet
  consumed** by anything. Each venue currently keeps its own Take ledger
  (Coinbase: `coinbase_allocations` and friends; Robinhood:
  `strategy_allocations` / `strategy_attribution_entries`). A new venue needs
  one of its own until the ledger slot lands.

Register it in `src/main/background-host.ts`, which today reads:

```ts
const venues=createVenueRegistry([
  coinbaseVenue(ruleTrades,{queue:ruleTrades,approvals:coinbaseRuleApprovals(database,id=>coinbaseExecution.submit(id))}),
  robinhoodVenueWith(robinhoodTrades.adapters,{queue:robinhoodTrades,approvals:robinhoodRuleApprovals(robinhoodTrades)}),
  // krakenVenue(krakenTrades,{queue:krakenTrades,approvals:krakenApprovals}),
],{agent_run:ruleAgents.adapter});
```

The second argument holds `local` adapters for actions that run in the app
rather than on a venue.

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
- **The core does not authorise the trade.** It looks the adapter up and calls
  `advance`; it does not re-check that the rule is still granted, not disabled,
  not expired, that trading is still enabled, or that an approval is present and
  unchanged. **Until the core supplies that check, every adapter must re-check
  all of these itself at dispatch time, from the database, never from a saved
  result, and must do it against the final orders** (after any re-pricing or
  re-sizing), not against the preview. The place for it is `journal.claim()` in
  `dispatchOrder` (`trading/dispatch.ts`), which runs once, immediately before
  the send, and whose failure never sends. Coinbase re-joins
  `strategy_rule_accepted` (`strategies/rule-trades.ts`) and refuses on stale
  inputs; Robinhood does it in `guard` and `withinApproved`
  (`strategies/robinhood-rule-trades.ts`), which also bounds re-sized orders
  against what the member approved. Write refusal tests for a revoked grant, a
  disabled rule, an expired request, trading turned off, and an approval whose
  orders changed.
  **The core supplies this check for a venue that opts in:** build
  `dispatchAuthorization(admit)` (`execution/dispatch-authorization.ts`) and
  call it inside your `claim()` with the final orders, what the member approved
  (if approval was needed) and your limit evidence. It re-reads the grant as a
  started job, applies the shared approval tolerance (`withinApproved`: same
  symbol and side, no new orders, at most ten percent or one dollar more per
  order; Robinhood's engine already uses this function from the core) and the
  shared `riskEligibility`, and throws `DispatchRefused` with the reason, which
  fails the claim so nothing is sent. The fake venue
  (`tests/unit/execution/fake-venue.ts`) is the exemplar, and
  `dispatchConformance` is the test to pass. Coinbase's engine keeps its own
  bps tolerance and re-confirmation until it opts in.
- **Revocation stops new sends, nothing else.** If the grant is removed or
  trading is turned off while an order is already out, the adapter must keep
  following fills, recovering by client id, resolving reservations and honouring
  `cancel`. Only a *new* send is refused. Test this with a revocation after a
  lost submit response: the job recovers, resolves, and sends nothing new.
- **A job the adapter has touched is only ever ended through the adapter.**
  Reservations can exist before anything is sent (Coinbase reserves before it
  asks for approval), and a crash can leave side effects whose outcome was never
  saved. So `cancel` must be safe to call on any job after `recover`, release
  what is reserved, keep what filled, and report the outcome; the core never
  writes a terminal state over a job that has adapter evidence. Do not rely on
  `attempts` or `adapter_state` to tell whether your adapter has run: `attempts`
  counts errors, and `adapter_state` is optional. Your own durable records are
  the evidence, and `recover` must read them.
- **Before sending an order, record durably that it is being sent** (as Coinbase
  does with `coinbase_order_dispatches.state='sending'`), using a client order id
  the broker can be queried by. After a crash or a lost response, look the order up
  by that id. **Never resend an order whose outcome is unknown**: return
  `needs_attention` (or `waiting` for `account` while it keeps being re-checked).
  For an onchain venue the same rule applies to transactions: record sender,
  nonce and hash before broadcasting; a dropped transaction may be re-signed
  only with the same nonce, so at most one ever lands.
- Return `running` with `retryInMs` to be called again, `waiting` with a reason to
  wait for approval, market open, funds, inputs or the account, or a terminal state
  (`succeeded`, `blocked`, `failed`, `needs_attention`, `cancelled`) with a
  snake_case reason. Throwing is retried with backoff and asks for attention after
  five errors.
- A platform refusal (a venue that will not serve this member, a token that
  rejects the transfer) is a normal outcome: return `blocked` with the
  platform's reason. Opentake adds no jurisdiction logic of its own and never
  retries a refusal as if it were transient.
- `cancel` releases reservations and keeps fills. If orders are already out and
  cannot be cancelled now, return `running` or `waiting`; the job continues.
- Honor `signal`: it aborts at the step deadline (2 minutes) and at shutdown.
- Broker calls go through the venue's request queue (`createVenueQueue`), one at a
  time, with a per-call timeout.

## 4. Pass the conformance suite, and the authorisation tests

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

**Passing conformance is not readiness.** The suite proves dispatch, recovery
and cancellation; it does not test trading authorisation. The venue is ready to
trade when it passes conformance **and** its own refusal tests from §3 (revoked
grant, disabled rule, expired request, trading disabled, changed approval,
revocation after a lost submit), **and** the admission paths in §1 accept its
accounts, **and** a member has connected an account and the venue's reads appear
in the portfolio, **and** the member controls below are honoured.

### Member controls every venue must honour

Opentake is self-hosted; these are the member's levers over their own
automation, and each needs a test on the new venue:

| Control | Required behaviour |
|---|---|
| Read-only by default | A new connection cannot trade until the member enables it (Coinbase: key permissions → `can_trade`; Robinhood: `agentic_allowed`; a signer venue: no trading until the member turns it on for that connection) |
| Limits | `OPENTAKE_TRADING`, `confirm_trades`, per-rule approval, per-rule `maxTradeNotionalUsd`, per-account daily notional, and a signer's scope cap are checked immediately before every send, never from a saved result |
| Pause | Trading off, rule disabled or grant removed → no new sends; in-flight orders finish, reservations resolve, the member is notified. Never a silent stall. A Take's chat `permission_mode` is not a trading pause; trading confirmation is `confirm_trades` and per-rule approval |
| Revoke / disconnect | Disconnect refuses while anything still needs the credential to be managed: a dispatch `sending` or `unknown`, an `accepted` order not yet terminal at the venue, an unresolved cancellation, or a job with adapter evidence still `running`/`waiting`. Offer "cancel open orders, then disconnect". Only after reconciliation: revoke a signer's key at the venue, then delete the local secret; keep a wallet key until the member has recovered or swept it |

## 5. Scheduling

- Rule firings, sent orders and saved syncs wake the action loop; the interval is a
  backup. If the venue offers pushed order updates (for example a WebSocket user
  channel), wake the loop from them and keep polling as the backup.
- A scheduled or drift rebalancer for the venue runs as its own worker loop
  (`createWorkerLoop`) and holds each account through `AccountQueues.run`.
- Background account sync is scheduled by `maintenance.ts`, which today only
  schedules Robinhood; add the venue there until the sync slot lands.
- Synthetic tests only: no live credentials, profiles or orders. A live check with
  real money is run by the member, with explicit approval of amount and asset.

## 6. Everything the action core does not cover (yet)

A venue that stops at §5 cannot be used. Each of these is per venue today and
has its own slot in the redesign plan:

| Area | Today | Where to look |
|---|---|---|
| Connect | Bespoke service per venue, a hand-written RPC block in `background-host.ts`, a `desktop.ts` channel entry, a preload bridge, rows in `Connections.tsx` / `ConnectMenu.tsx` | `connections.ts` (Robinhood), `coinbase/connections.ts` |
| Signing | Venues where the member's instance signs with the member's own key (agent wallet, dedicated EOA, session key) have no seam yet; keys live in `SecretStore`, main process only, never exposed to agents, revealed to the member only behind an OS auth prompt | `secret-store.ts` |
| Sync | `account-sync/service.ts` is Robinhood MCP only; Coinbase has parallel tables; `platform-portfolios.ts` merges exactly two venues | `account-sync/`, `coinbase/portfolio.ts` |
| Prices and performance | Price reader and performance branch on venue and answer `unsupported` / `null` otherwise; quote tables are keyed by bare ticker | `data-sources/market-price-reader.ts`, `strategies/performance.ts` |
| Agent read tools | Per-venue tool list with contract hashes, a chat scope, and the platform enum in the MCP catalog | `coinbase/read-tools.ts`, `opentake-mcp/catalog.ts` |
| Renderer | Logo, investment panel, market route, and the two-way venue ternaries | `renderer/src/logos.tsx`, `InvestmentVenuePanel.tsx` |
| Mixed baskets | Exactly two venues (`mixed-execution/version.ts`, `funding.ts`, `withdrawal-adapters.ts`); a new venue ships single-venue first | `mixed-execution/` |

## A second example: Robinhood

`src/main/strategies/robinhood-rule-trades.ts` adapts a venue whose engine already plans and
places orders (the Robinhood planner and executor). Such an adapter does not submit orders
itself: it previews (a dry run), stores the preview for the member's approval, hands the
approved work to the engine with the approval carried through, and follows the engine's
order records to a terminal state. Never-resend and recovery then stay the engine's, tested
there. Its `queue` is its own `enqueue`, and its `approvals` slot
(`robinhoodRuleApprovals` in `strategies/rule-trade-approvals.ts`) wraps its
`pending` and `decide`, so it appears on the shared approval card without that
card knowing its name.
