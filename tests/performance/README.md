# Performance baseline harness

This opt-in harness measures controlled latency of the background host's services
against synthetic fixtures. It imports current production services and changes no
runtime code, migrations or dependencies. It does not launch an Electron UI or the background host. The macOS commands below
use Electron in Node-only mode to match its bundled Node 24 runtime.

From the repository root, using the installed dependencies:

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/baseline.smoke.test.ts
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/typescript/bin/tsc -p tests/performance/tsconfig.json --noEmit
```

The ordinary Vitest configuration does not include `tests/performance/`. The
dedicated configuration runs one file/worker at a time. Its typecheck covers the
harness and imported source interfaces without emitting build files. No full
build, startup, live connection, or regression-suite command is required.

## Fixtures and smoke coverage

`createFixture()` opens a real `WorkerDatabase` in a new OS temporary directory,
runs unchanged migrations, seeds synthetic records, and returns services' normal
`database.use` interface. It accepts sizes and a seed, never an app-profile path.
Call `close()` in `finally`; it closes/drains the database worker before deletion.
Initialization failures use the same cleanup path.

Each venue gets `accountsPerVenue` accounts, with `allocationsPerAccount` Takes
sharing each account. Every allocation has a committed daily basket, accepted
version, account route, and $100 of attributed synthetic cash. Coinbase has fresh
cached holdings and wallet evidence covering all claims plus $1,000 unassigned.
Robinhood attribution is cash-only; no real planner/preflight is exercised.

`historyRows` is the combined count across these three equally weighted families:

- Take messages, distributed across all Takes as parent-linked histories.
- Coinbase portfolio observations, distributed across Coinbase accounts.
- Resolved reconciliation cases, distributed across Robinhood allocations.

One additional open reconciliation case exercises derived notifications. Each
Coinbase account also has one fresh observation and wallet-history record.
`fixture.manifest` records requested sizes, actual history-family counts, these
extra counts, deterministic domain IDs, account distribution, and business time.
Migration-owned IDs/timestamps are not deterministic; domain fixture IDs and
timestamps are. This is semantic reproducibility, not byte-identical databases.

The smoke file checks:

- Real Take-list and message-page reads (`createTakeHistory.takes/messages`),
  including the 30-message cursor boundary and invested status.
- Cached portfolio reads (`createCoinbasePortfolio.snapshot`), balances and
  allocation ownership, with connection metadata supplied by a local fake.
- Notification reconciliation (`createNotifications.tick/list`), a derived
  missing-evidence notification, and idempotence beyond the cooldown.
- Both real schedulers reach exactly the intended fake planning entry points.
- Robinhood's rotating 50-candidate page visits all 52 allocations in a larger
  fixture. An injected planning failure is recorded by the scheduler.
- Recreated fixtures have the same domain manifest; successful cleanup removes
  the temporary database. Fetch, socket, and subprocess attempts fail before I/O.

The business clock starts at October 16, 2026, 11 a.m. Eastern, with allocations
created October 1. Real elapsed time remains independent of this clock.

## Fake boundaries and measurement

`createServices()` supplies strict fake planning/preview dependencies. It supports
fixed delay, one slow call, and one rejected call, indexed globally within that
service instance. Calls record venue, allocation/Take ID, trigger, start time, and
outcome. Unconfigured methods record a violation and throw, even if the caller
catches the exception. No execution or live account discovery occurs.

Robinhood's fake planner returns `up_to_date` without persisting a completed run;
repeat passes therefore remain due. Coinbase's fake preview returns the normal
no-orders signal, allowing the scheduler to persist a no-op completion. These
different fake semantics must be accounted for in later scenario design. Calls
measure discovery-to-planner/preview latency, not provider throughput or completed
economic execution. Calling both schedulers separately is not a test of the host's
venue ordering or failure isolation.

`measureDatabase()` records only explicitly scoped work. Seeding/migration costs
are excluded. Scopes propagate through concurrent async work; queued transaction callbacks
explicitly restore their submitting scope (covered by a regression test). Query labels hash
normalized SQL; a local label-to-SQL map allows source lookup. Parameters and
result payloads are never recorded. Returned row counts are not rows scanned.

Top-level query latency includes queue wait, IPC, and execution; exact queue wait
and worker execution time are explicitly unavailable. Transaction samples include
BEGIN/COMMIT and callback time, with nested statement samples. Service samples
contain both. Do not sum these overlapping durations. Failures remain visible
even if a service catches them. Raw samples are in memory; no p95, performance
threshold, or baseline report is produced by the smoke run.

`setup.ts` blocks networking and subprocess APIs before services load, permits
only the production database worker, and preloads the same I/O guard into it.
Worker I/O attempts are reported back; caught attempts also fail the test. Electron
APIs are blocked. This guards against accidental I/O; it is not a filesystem or
OS security sandbox. Only approved database/source imports belong in this harness.

## Controlled latency runs

Run from the repository root. Results must use a new absolute directory, separate
from any app profile. These commands use the installed macOS Electron binary in
Node-only mode; an equivalent Node 24 executable can run the same Vitest entry
point elsewhere. The latency test rejects other Node major versions. Record the
exact Electron/V8 versions when comparing runs.

```sh
mkdir -p .local/performance
export EARLYBIRD_PERF_OUTPUT="$(mktemp -d "$PWD/.local/performance/latency.XXXXXX")"
export EARLYBIRD_PERF_REVISION="$(git rev-parse HEAD)"
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT"
ELECTRON_RUN_AS_NODE=1 EARLYBIRD_PERF_RUN=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/baseline.latency.test.ts
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT" --verify
python3 tests/performance/summarize.py "$EARLYBIRD_PERF_OUTPUT"
```

Stop if the benchmark or source verification fails; do not summarize a partial
run as complete. The summarizer rejects pilot and incomplete matrices. For a
quick harness check, add `EARLYBIRD_PERF_PILOT=1` to the Vitest invocation and use
a fresh output directory. A pilot is not enough samples for p95 and is not a
baseline. The full October 17 run took about 15 minutes on an M4 Max.

The matrix varies 10/100/500 Takes at 10,000 history rows and 1,000/10,000/100,000
history rows at 100 Takes. It uses three recreated fixtures per size, 40 detail
loads per repetition, and 100 samples per foreground probe in each phase.
The foreground cadence is 25 ms, bounded to one bundle of four concurrent reads.
The background window runs an incremental notification tick and immediate-fake
scheduler passes. Its sampled window includes time after the burst and a newly
populated inbox; it is not a pure same-state contention experiment.

`capture-source.py` records hashes, Git revision/status, PGlite version, and a
source archive including untracked harness files. It never reads an app profile.
Keep measured inputs unchanged until post-run verification completes. `run.json`
is checkpointed after each repetition. Compressed raw files contain timings and
SQL templates, not query parameters or row payloads. Large raw outputs stay
outside Git under `.local/`. `summarize.py` writes `summary.json`, pooling
foreground/detail samples while preserving background pass median/ranges.

## Optimized overview comparison

The updated Takes screen now uses `takeOverview()`. `baseline.latency.test.ts`
retains the old `takeDetails()` composition as a historical workload; do not
label its detail numbers as the optimized screen's service latency.

```sh
export EARLYBIRD_PERF_OUTPUT="$(mktemp -d "$PWD/.local/performance/overview.XXXXXX")"
export EARLYBIRD_PERF_REVISION="$(git rev-parse HEAD)"
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT"
ELECTRON_RUN_AS_NODE=1 EARLYBIRD_PERF_OVERVIEW=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/overview.latency.test.ts
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT" --verify
```

This writes `overview-run.json` with its own summaries. It runs three fixtures
per size (10/100/500 Takes, 10k history), five control and 40 optimized samples
per repetition. Do not publish a control p95 from the 15 pooled control samples.
Run `overview.test.ts` with this same dedicated Vitest config for the three
correctness checks.

## Notification reconciliation profiling

`notifications.latency.test.ts` profiles six stages and full unchanged/incremental
ticks on three recreated 500-Take fixtures. It requires its own opt-in flag:

```sh
export EARLYBIRD_PERF_OUTPUT="$(mktemp -d "$PWD/.local/performance/notifications.XXXXXX")"
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT"
ELECTRON_RUN_AS_NODE=1 EARLYBIRD_PERF_NOTIFICATIONS=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/notifications.latency.test.ts
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT" --verify
```

Use medians/ranges, not p95, for its three passes. Run
`notification-lifecycle.test.ts` with this dedicated config for batch parity,
expiry, unavailable rows, and notification recurrence/recovery checks. Existing snapshots remain
immutable; fresh runs must use new output directories.

The same notification profiling command also measures the action-stage optimization. Run `tests/performance/action-notifications.test.ts`
with the dedicated config for batch-boundary evidence, receipt reversal, unchanged
card behavior, late duplicate pruning, state transitions, and recovery checks.

## Message history and sustained contention

`history-decoration.latency.test.ts` compares the exact legacy decoration query
with the windowed implementation on identical synthetic pages, alternating order,
and captures read-only `EXPLAIN ANALYZE` plans outside timed trials.
`contention.latency.test.ts` collects idle-before/busy/idle-after foreground reads
against the same populated state. Busy means continuously repeated lifecycle and
action reconciliation, not production polling cadence. It counts missed slots
and bounds concurrency to one four-read bundle.

Use fresh output directories and capture/verify source as for other benchmarks:

```sh
export EARLYBIRD_PERF_OUTPUT="$(mktemp -d "$PWD/.local/performance/history.XXXXXX")"
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT"
ELECTRON_RUN_AS_NODE=1 EARLYBIRD_PERF_HISTORY=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/history-decoration.latency.test.ts
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT" --verify
```

For contention, use a new directory, `EARLYBIRD_PERF_CONTENTION=1`, and select
`tests/performance/contention.latency.test.ts`. Run `history-decoration.test.ts`
with the dedicated config for output parity.

## Portfolio observation reads

`portfolio.latency.test.ts` measures account lists and complete portfolio snapshots
on the 500-Take/10k-history and 100-Take/100k-history fixtures, three repetitions
and 120 reads per service/fixture. It captures observation/capital query plans
outside the timing loops and checks repeated outputs against the warm snapshot.
Use a fresh output directory and the normal capture/verify steps:

```sh
export EARLYBIRD_PERF_OUTPUT="$(mktemp -d "$PWD/.local/performance/portfolio.XXXXXX")"
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT"
ELECTRON_RUN_AS_NODE=1 EARLYBIRD_PERF_PORTFOLIO=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/portfolio.latency.test.ts
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT" --verify
```

Run `portfolio.test.ts` with the dedicated config for full-snapshot parity against
the legacy account query and boundary cases.

## Slow-provider scheduler checks

Run `scheduler.latency.test.ts` with `EARLYBIRD_PERF_SCHEDULER=1`, the dedicated
config, Node 24, and a new absolute `EARLYBIRD_PERF_OUTPUT`; capture/verify sources
as above. It checks two-pass candidate coverage, shared in-flight tick promises,
three-second injected delays in either venue, Robinhood rejection/backoff, and
foreground reads. These fakes never trade.

## Stream writes alongside foreground reads

On the combined data-source/performance branch, run the disk-backed 100-market
writer contention matrix with an explicit opt-in. It covers idle, 1 Hz writes,
continuous reconciliation, combined work, and idle-after; three fresh fixtures
per size and 120 samples per read/phase. No real sockets or credentials are used.

```sh
export EARLYBIRD_PERF_OUTPUT="$(mktemp -d "$PWD/.local/performance/stream-contention.XXXXXX")"
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT"
ELECTRON_RUN_AS_NODE=1 EARLYBIRD_PERF_STREAM_CONTENTION=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run --config tests/performance/vitest.config.ts tests/performance/baseline.smoke.test.ts tests/performance/stream-contention.latency.test.ts
python3 tests/performance/capture-source.py "$EARLYBIRD_PERF_OUTPUT" --verify
```

If this checkout shares dependencies without an Electron binary, substitute the
absolute path to an installed Electron executable with Node 24.
