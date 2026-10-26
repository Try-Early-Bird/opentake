# Shared AI audit capture

Migration 15 adds local audit storage independent of any UI feature. New chat
executions now write to it through the host, Claude adapter, MCP gateway and
platform-approval path. The shared recorder accepts arbitrary feature/operation
names so a future AI search can use the same storage. No search executor or audit
UI is introduced here. Existing take records remain unchanged; old history is
not backfilled or presented as a complete trace.

## Model and ordering

- `ai_audit_traces`: one operation, with owner, feature (such as chat/search),
  operation, optional source reference, state and capture status.
- `ai_audit_runs`: provider execution attempts, with provider/model,
  adapter/version and optional provider request ID. The schema supports multiple
  runs, parent runs and retries within a trace. The current chat recorder creates
  one run per trace; future multi-run producers must coordinate trace completion.
- `ai_audit_events`: an ordered timeline across the trace, including work outside
  inference. Each event has an ID, kind, payload schema version, capture status,
  optional run/span, optional earlier causal event, and observation/receipt times.

The database assigns a per-trace sequence under a row lock. Failed inserts roll
back the counter. Read using `WHERE trace_id=$1 AND sequence>$2 ORDER BY sequence
LIMIT ...`; timestamps are not a reliable ordering key. Cast bigint sequence
values to text at JavaScript boundaries. Run references and causal links cannot
cross traces; causal events must precede their dependants. A sequence represents
recording order, not a claim that concurrent operations ran serially.

A gateway invocation uses one span for its request, approval, dispatch intent,
result and outcome. Provider content retains its own message/tool IDs. The CLI
bridge does not currently expose a shared ID joining a provider tool-use block to
its gateway invocation; these two identity domains must not be falsely equated.

## Captured evidence

| Events | Stored evidence |
| --- | --- |
| `trace.started`, `run.started` | Feature, operation, conversation context, effective instructions, model selection and tool-policy snapshot |
| `model.request` | Input supplied to the CLI: instructions, reconstructed prior messages, current message and image bytes, allowed-tool settings |
| `tools.catalog` | Tool definitions and policies actually returned to the provider |
| `model.delta`, `model.output`, `model.result` | Supported streamed deltas, message content, tool-use/result blocks, exposed thinking text, final output, provider message/model/session identifiers |
| `provider.lifecycle`, `provider.exited` | Available CLI version/model/compaction metadata, exit code/signal and completion flags |
| `usage.recorded` | Reported token usage, per-model usage and USD cost when supplied by the CLI |
| `tool.checking`, `tool.requested` | Tool/server/destination identity, schema and sanitized arguments |
| `approval.requested`, `approval.scope`, `approval.user_decision`, `approval.decided` | Sharing flag, exact call scope, expiry, user decision and consumed decision |
| `tool.dispatch_intent`, `tool.result`, `tool.finished` | Pre-dispatch checkpoint, returned content, final dispatch flag and outcome |
| `platform.*` | Verification scope/settings, approval requests/decisions and authorization |
| `execution.error`, `capture.gap` | Failure stage and explicitly missing/omitted evidence |
| `run.finished`, `trace.finished` | Completion, failure, cancellation, or interrupted/unknown outcome |

The adapter snapshots reconstructed history and current image bytes before
launch. These do not depend on mutable settings or source attachments remaining
available later. Stream captures are drained before the executor resolves.
Request capture failure prevents launching inference; output capture failure
stops the child and fails the response. Tool request/dispatch capture is awaited
before external dispatch. User approval decisions and their audit events commit
in the same transaction. Other gateway checkpoints may precede the actual
network call, so a dispatch intent alone is never proof of execution.

## Completeness and privacy

Traces currently remain `partial`, even when execution succeeds. The CLI owns
exact upstream wire requests, internal context transformations and hidden model
reasoning. We capture what it exposes; we cannot reconstruct undisclosed content.
Raw stderr, raw exception strings, unknown event types and unsupported content
blocks are not stored. Size limits stop capture/execution with explicit gap
records. Unknown usage is absent, never fabricated as zero. Usage fields inside
reconstructed Claude history are synthetic envelope fields, not actual usage;
only reported usage events are accounting evidence.

`payload_status` distinguishes captured, redacted, omitted and unavailable
payloads. The latter three require an explanation. Bound provider/gateway/MCP
credentials are removed at their execution boundaries; the shared recorder also
removes credential fields and token patterns. It never enumerates credential
storage to build a redaction inventory. Payloads can contain private conversation
and platform data and are not included in ordinary renderer snapshots. This is
not a guarantee that arbitrary user-provided sensitive prose can be detected.

`capture_version` and event `schema_version` start at 1. New producers must
validate/version their event payloads and document unsupported evidence. Future
retrieval should record query, sources, selected content and ranking; retries
should get their own runs/spans. The database intentionally permits new event
kinds without a schema migration. A future producer may mark a trace `complete`
only under its documented capture contract; this never means hidden reasoning is
available. `legacy` is reserved for explicitly labelled historical imports.

## Recovery and lifetime

Startup and backup restore close unfinished runs/traces with interruption events,
partial capture and an unknown-outcome flag. Recovery is idempotent and never
replays an action. Run/trace terminal projections and terminal events commit
atomically. Event updates are rejected; corrections should append evidence. This
is local audit storage, not a cryptographically tamper-proof ledger.

Audits have their own lifetime. Deleting a take does not delete its audits;
explicit trace deletion cascades to its runs/events. Settings → Data Retention
provides an independent AI audit lifetime of 7, 30, 90 days or Forever (default).
Expiration is measured from the trace finish time and removes complete traces
with their runs/events, including failed, cancelled and interrupted executions.
Running traces and traces with running children are preserved. Changing the
setting prunes immediately in the same transaction; maintenance prunes at host
startup and hourly while idle. Conversation history is unaffected, and existing
backup files are not rewritten. Snapshot backups include these tables and the
retention setting. Producers must avoid retaining credentials
in any payload. Future blob extraction must preserve immutable audit-owned bytes
and integrity hashes rather than depend on source attachment lifetime.

Retracing means inspecting evidence step by step. Re-execution is a separate
operation requiring authorization; models and external data may have changed,
and tool calls may have side effects.
