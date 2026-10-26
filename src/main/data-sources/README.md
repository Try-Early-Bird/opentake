# Data-source runtime and host integration

`service.ts` now composes the modules described below in the production host.
It resolves the local owner, manages source revisions and previews, registers
validated/enabled HTTP feeds, and forwards accepted observations to storage.
No source is created or enabled by default. Both collection modes currently use
UI demand; durable Take demand is deferred. The custom setup UI is not shipped.

The coordinator exposes guarded configuration operations through preload, never
raw secrets, owner selection or runtime definitions. Preview validates one shared
response across all declared feeds without retaining it or enabling collection.
Edits and enable/disable changes retire all custom leases; consumers reacquire.
Suspend cancels previews and leases; shutdown awaits operations and storage drain.

The sections below record the earlier foundation boundaries; their statements
about empty production registration or no host-owned storage describe 16A/B.
The coordinator supersedes those boundaries. `service.test.ts` covers the composed
lifecycle with a disposable database and injected transport.


The background host owns this in-memory runtime through `host-service.ts`.
The production catalog and adapter registry are empty until validated providers
are implemented. Tests inject synthetic HTTP and WebSocket adapters. Production collection remains disabled. The staged 16C modules described below
are not instantiated by the host and introduce no trading hooks.

`createDataSourceRuntime(adapters)` owns feed demand and adapter lifetimes. Acquire
with a validated `FeedDefinition` and `{ mode: 'latest', demand: 'ui' }`, read a
copied snapshot, then release the handle. A `durable` demand is currently only an
in-memory host-owned reference used to prove sharing; persistence and acceptance
of Take bindings come later. Do not expose `acquire` directly to renderer input.

Keys include owner, source/revision, auth scope, feed/schema, and sorted parameters.
Conflicting definitions for an active key fail rather than mutate its meaning.
Released entries are evicted after a five-second grace period; immutable revision
history across eviction/restarts is handled by the staged configuration repository.

Adapters emit normalized samples. The runtime checks kind, primitive types,
declared event fields, payload size and timestamps, stamps provenance, fences old
sessions, and rejects stale ordering/duplicates. Adapters must enforce raw byte
limits before parsing, provider-specific semantics (including book consistency),
and normalize sequence numbers to the exact declared feed/epoch. They signal gaps;
the runtime does not guess whether sparse sequence numbers imply missing data.
Book payloads are bounded display projections, not the internal provider book.
History and replay capabilities are explicitly false in this adapter version.

HTTP requests use one permit per source/auth scope and a global cap. A request
that ignores abort keeps its permit until it settles, preventing timeout/retry
from exceeding actual concurrency. Other sources can use remaining permits. Polls
are scheduled from completion with jitter; resuming does not replay missed polls.
A WebSocket adapter's `open` returns a synchronous cleanup function and must honor
abort. `connected` reports connection readiness; `heartbeat` affects its watchdog,
not observation freshness. Failures back off; invalid normalized data blocks the
entry until its configuration is replaced/reacquired, rather than endlessly retrying.

Latest consumers coalesce naturally. Event consumers use bounded queues and
`drain()`; the result contains a gap marker and ordered observations. A gap requires
a fresh consumer baseline even when new-epoch observations are returned alongside
it. This is in-memory delivery, not a durable acknowledgement/outbox. Never treat
it as execution authorization. Draining/releasing returns buffer capacity.
Returned observations are copies, and raw exceptions/payloads never become errors.

`read()` computes freshness without provider I/O. A 100 ms scheduler handles
expiry, timeout, clock discontinuity, fair admission, and retry. `suspend()` retires
sessions and invalidates continuity; `resume()` starts fresh epochs. `close()`
aborts acquisition and clears timers/buffers; it does not wait forever for a
misbehaving injected HTTP promise. Late completion cannot publish. No storage is
owned by this version, so there is no write queue to drain.

## Production transport gate

Do not add a fetch/socket default to this module. Before any real custom adapter
is registered, the transport must enforce HTTPS/WSS destination policy, DNS/address
pinning and TLS verification on each connect, redirect denial, decoded payload
limits, proxy policy, synthetic-secret tests, and credential isolation. Defining
a feed does not authorize a network destination. The host lease API has no URL or secret fields. The staged HTTP client enforces
a restricted public-endpoint policy; registration still requires lifecycle wiring
and acceptance of the configuration/preview boundary.

## Verification

Run `vitest run tests/unit/data-sources/runtime.test.ts` using the repository's
Node 24 runtime. The tests cover sharing, isolation, lifecycle, independent source
progress, normalized validation, freshness, ordering, clock changes, resource
caps and gap delivery. Run the node/web TypeScript projects when shared types
change. No live connection, native keychain or database acceptance is implied.

## Host boundary

`createDataSourceHostService` accepts a host-owned catalog. The renderer receives
only feed references, kind/unit, opaque lease IDs and validated snapshots through
`window.dataSources`. It cannot supply runtime definitions, auth scope, URLs,
parameters or durable demand. Catalog entries must already have been authorized
for display by the host; future source persistence supplies that policy.

UI leases expire after 30 seconds. Visible consumers should renew every 10 seconds,
request at most four batches/second, and release on unmount or product switch.
A batch contains at most 32 unique IDs; snapshots are capped at 1 MiB. Reads do not
renew leases or invoke provider work. Missing/foreign/expired leases return null
snapshots or are omitted from renewal results; callers reacquire on visibility
return or host replacement. Lease UUIDs are fresh for every acquisition.

Desktop main assigns a separate client UUID to each renderer lifecycle, checks
the sender/main frame, and allows one read in flight per renderer. Hide, minimize,
reload and renderer loss retire that client. Requests from hidden windows cannot
acquire/renew/read; TTL covers desktop crashes and failed teardown RPCs. Event
listeners are removed on retirement rather than accumulating across reopenings.
`drop-client` is main-process-only, not exposed by preload. Host rate accounting
is bounded by active leased clients.

Host suspend/offline transitions revoke UI leases and suspend acquisition. Resume
requires visible consumers to reacquire, so abandoned views do not restart feeds.
Shutdown closes the service before awaiting existing host jobs or closing PGlite;
late adapter callbacks cannot publish. This version has no source storage writes.

Additional verification: `tests/unit/data-sources/host-service.test.ts` and
`tests/unit/data-sources/host-rpc.test.ts` exercise active synthetic leases and a
disposable RPC host. `node --test tests/data-sources-host.test.mjs` exercises the
built preload/desktop/host route, hide/native reload and desktop teardown with an
empty catalog in a disposable profile using `--earlybird-test-no-secrets`.

## Staged 16C modules

`config.ts` validates bounded public HTTPS source configurations and declarative
scalar/event mappings. `repository.ts` stores immutable revisions in migration 83;
saving disables the source, and enabling requires validation of that exact
revision. Restore disables sources and clears latest values. No renderer API
currently exposes these operations.

`http.ts` supplies a bounded GET JSON client with DNS validation/address pinning,
TLS verification, redirect denial, deadlines and byte limits. Compressed bodies,
query strings, literal IP endpoints and embedded credentials are rejected in this
first slice. `http-adapter.ts` maps declared fields to runtime observations. The
adapter is not registered in the production host. Optional `credentialId` references an existing HTTP API credential in SecretStore.
Pass the host SecretStore as the third argument to `createHttpAdapter`; it resolves
the credential each poll and fails closed without a matching store/record. The
credential's HTTPS origin and base path constrain the destination. Bearer, Basic,
and X-API-Key/API-Key headers are supported; other custom headers and unscoped
legacy tokens are rejected. Credential values never enter source configuration or
renderer APIs. Production registration and credential-selection UI remain pending.

`storage.ts` retains selected fields only, with live/latest/history policies,
sampling, expiration cleanup, owner caps and a bounded write queue. The runtime's
optional `onObservation` callback can submit accepted observations; rejection
reports capacity loss. Call storage `close()` and await its queue drain before
closing the database once production lifecycle wiring is introduced. The current
host does not instantiate storage or its timer. Retained reads are stale, never
live evidence or trading authorization.

Focused verification additionally covers `storage.test.ts`, `http.test.ts` and
`tests/unit/migrations.test.ts`, using disposable databases and injected transport.
Before production registration, complete configuration/preview authorization,
source-edit/disable cancellation, custom inventory and lifecycle orchestration.
The custom-source editor requires the user's separate design approval.

## Response inspection

`window.dataSources.inspect({ endpoint, credentialId? })` performs one bounded
request before mappings exist. The host uses the same credential and HTTPS policy
as collection, and cancels inspection on suspend, client retirement or close.
`inspection.ts` returns a bounded field projection, omitting sensitive names and
known credential echoes. It does not return the raw body, save a source, validate
an existing revision or enqueue samples. Arrays need explicit future item mapping;
numeric-looking strings and timestamps remain strings. The result is an inference
from one response, not an authoritative schema. Renderer integration is pending.

## Custom-source UI

The approved custom-feed editor and selected-source view are now implemented in
`src/renderer/src/data-sources/`. Typed preload helpers wrap the configuration
bridge. The editor inspects before mapping, saves disabled, validates a fresh
response, then explicitly enables. Detail views own visible UI leases and show
freshness/errors; they release on hide/unmount. Price/metadata destinations remain
pending. Run `node tests/data-sources-ui.mjs` on Node 24 for the fixture browser
flow; it uses fake APIs and a temporary Chromium profile, never the live app.

## Controlled destinations

Optional destination policies are validated by `destination-schema.ts` and applied
by `destinations.ts` inside the revision-fenced storage transaction. Price writes
are explicit opt-in and limited to existing Robinhood equity/USD quotes, with
provider timestamps, bounded freshness, and fill-missing/replace-stale policies.
Broker refreshes reset custom provenance. Metadata is a bounded selected-field
merge in a full-identity namespace owned by a single source/feed. Dry-run preview
returns before/after decisions; status stores the latest outcome without payloads.
No arbitrary table/column writes are accepted. Metadata consumers and destination
setup/review UI remain pending; the current editor creates custom feeds only.
