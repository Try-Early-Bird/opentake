# Chat test suite

Run from the repository root:

- `npm run test:chat` — chat unit tests, shared gateway RPC tests, typecheck,
  production build, then serial bridge/Electron integration tests.
- `npm run test:chat:unit` — fast chat service/runtime/MCP tests and shared RPC tests.
- `npm run test:chat:integration` — typecheck/build and bridge/Electron tests.

For a small change select the relevant file or named test instead of every suite:

```sh
npx vitest run tests/chat/unit/takes.test.ts
node --test --test-name-pattern='chat polling errors' tests/chat/integration/takes-ui.test.mjs
```

Build first when running an integration file directly after application changes.
The bridge tests exercise `out/main/earlybird-opentake-mcp.js`; Electron tests run
the built application. Integration files run serially in the npm script.

## Organization and coverage

`unit/` contains Take persistence/branching/idempotency/cancellation, instruction
revisions, migration upgrades, attachment lifecycle/validation, synthetic Claude
runtime image transport/incomplete output/cancellation, MCP discovery/contracts,
account scope, credential rotation/revocation, and policy changes during startup.

`integration/` contains the built MCP bridge's run-scoped routing/revocation and
Electron tests for archive navigation, background-error toasts versus chat errors,
provider/model controls, sending, tool activity, stopping and returning to history.
The UI conversation test injects the current `takes:*` IPC contract; it does not
claim to be a real provider-to-brokerage end-to-end test.

Shared `tests/unit/host-rpc.test.ts` stays in the host suite and is also included in
`test:chat:unit` because chat authorization depends on it. Provider onboarding and
model discovery tests remain in `tests/unit/ai-*.test.ts` and
`tests/unit/opencode-*.test.ts`; run their relevant tests when those modules change.

The retired `chat:send` UI fixture and legacy `createClaudeChat` unit tests have
been replaced by tests of the Take runtime and `takes:*` IPC. Do not reintroduce
legacy mocks to make the new chat tests pass.

## Strategy editing and text uploads

Run only the relevant checks for this flow:

```sh
npx vitest run tests/chat/unit/chat-file-input.test.ts
node --test tests/chat/integration/strategy-editor.test.mjs
```

The strategy editor test serves the renderer component through an isolated Vite
fixture and launches headless Chrome with synthetic strategy data. It needs no
application build, Electron host, brokerage connection, or credentials. Set
`CHROME_PATH` if Chrome is not at the platform default path; the test skips when
that executable is unavailable. It checks step validation, review-before-save,
preserved fields, cancellation, busy state, and narrow-screen bounds. Screenshots
are written to a temporary directory printed by the test.

Text-file uploads preserve reference content in the editable composer. Their unit
tests cover file type/encoding, individual and combined size limits, read failures,
and preserving holdings columns and rationale. These checks do not validate a live
model's interpretation of uploaded content.

## Test isolation

All credentials, providers and account data are synthetic. Default child-process runtime
tests launch fixture Node programs; the explicit opt-in compatibility checks below
use installed CLIs against mock model servers. Electron tests use a
new temporary profile and `--earlybird-test-no-secrets`; they close the desktop,
stop its background host, then delete the profile. Never substitute a real profile
or invoke live login, token refresh or brokerage operations in this suite.

## Still to cover as implementation progresses

Additional OAuth provider compatibility, additional CLI history versions,
model image capability and run limits,
orientation/encoding, incremental/paged history, usage budgets, full database
backup/restore of chat attachments, and additional Codex/OpenCode CLI versions. Passing this
suite is not evidence that these unfinished plan items work or that a live
provider accepts the synthetic fixture protocol.

## Last verified run

2026-10-01: `npm run test:chat:unit` and `npm run test:chat:integration` passed
with 34 unit tests and 5 integration tests,
including typecheck and production build. No skipped tests in the grouped run.
The expanded tests exposed equal-timestamp instruction revisions being ordered by
UUID; migration 7 and sequence-based reads fix that, with regression coverage.

## User-authorized live check

2026-10-01: separately from the automated suite, the user authorized validation
through the running app with their connected Claude and Robinhood accounts.
Claude completed `opentake_connection_status` and `opentake_list_accounts`; the UI
showed both calls completed and exactly one selected account exposed. A subsequent
turn recalled the masked suffix and account count without additional tool calls.
No balances, holdings, orders, credentials, or account changes were requested.
The validation take remains in the app as “Live validation — Claude + Robinhood”.

Observed limitation: the follow-up had the earlier assistant reply but not the raw
MCP results; Claude explicitly distinguished recollection from fresh verification.
This was observed before the structured replay checkpoint above. This live check
is not approval to use real profiles in the automated test commands above.

## Installed Claude transcript compatibility (opt-in)

With Node 24+ and an explicit installed CLI path:

```sh
OPENTAKE_TEST_CLAUDE=/absolute/path/to/claude node tests/chat/compatibility/claude-history.cjs
```

This check uses the production transcript builder, a loopback mock Messages API,
synthetic credentials, and a disposable HOME. It does not read the user's Claude
profile or call a real provider/brokerage. It is deliberately outside the default
suite because installed CLI availability/version is environment-dependent.
Verified with Claude Code 2.1.286 on 2026-10-01 and 2.1.289 on 2026-10-05 (one request
carrying roles user/assistant/user/assistant/user with the replayed tool result, exit 0);
unverified versions fail explicitly. Add a version to `VERIFIED_CLAUDE_HISTORY_VERSIONS`
only after this check passes for it.

## Codex and OpenCode adapters

```sh
npx vitest run tests/chat/unit/native-adapters.test.ts
npm run build
OPENTAKE_TEST_CODEX=/absolute/path/to/codex OPENTAKE_TEST_OPENCODE=/absolute/path/to/opencode npx vitest run tests/chat/unit/native-cli-compatibility.test.ts
node --test tests/chat/integration/native-provider-ui.test.mjs
```

## Local models and OpenRouter (OpenCode)

```sh
npx vitest run tests/unit/local-model-connection.test.ts tests/unit/openrouter-connection.test.ts tests/unit/featured-models.test.ts tests/unit/ai-models.test.ts
npm run build
OPENTAKE_TEST_OPENCODE=/absolute/path/to/opencode npx vitest run tests/chat/unit/local-model-compatibility.test.ts
# Optional live check against a running local server, for example Ollama:
OPENTAKE_TEST_OPENCODE=... OPENTAKE_TEST_LOCAL_MODEL_URL=http://127.0.0.1:11434/v1 OPENTAKE_TEST_LOCAL_MODEL=qwen3:8b \
  npx vitest run tests/chat/unit/local-model-compatibility.test.ts
```

The scripted mode runs the installed OpenCode against a synthetic OpenAI-compatible
server, including an Ollama-style `reasoning` chunk that must not become reply text.
The live mode needs a model that supports tool calling. A recording proxy fails the
test on any outbound request except OpenCode's background plugin install from npm.
Verified 2026-10-02 with OpenCode 1.14.25 and Ollama 0.35.1 serving `qwen3:8b` on
macOS arm64: one gateway tool call, exact final text, 7–11 s per response.

The same file has a scripted OpenRouter-style case: a keyed compatible provider must
send the key as a Bearer token, report cost from the configured list price, and keep
the key out of audit, replay and output. No live OpenRouter request is made.
`tests/chat/integration/ai-picker-ui.test.mjs` covers the five featured models and
the searchable full list.

The installed checks are skipped unless each executable is explicitly supplied.
They use synthetic credentials, disposable homes, mock model/gateway servers and
the built MCP bridge. Scope: Codex 0.144.3 and OpenCode 1.14.25 on macOS. Coverage
includes role/image/tool-result history on the actual model wire, gateway-only
external tools and per-round usage events. Fixture checks cover unsupported CLI
versions, malformed protocol, native tools/approvals, early exits, cancellation,
streamed secret redaction, the Codex round limit and concurrent credential changes.
The Electron check verifies both selections send through `takes:*`, show adapter
errors and retain the unsent draft. It does not call either provider.

See [the adapter runbook](../../docs/chat-adapters.md) before changing the version
allowlist. Live credentials, provider entitlement, brokerage actions and other
platforms are outside this verification scope.

## Platform verification checks

For optional platform data verification changes:

```sh
npx vitest run tests/chat/unit/platform-access.test.ts tests/chat/unit/mcp-management.test.ts
npm run build
node --test tests/chat/integration/platform-access-ui.test.mjs
```

Coverage includes default allow, provider/account/settings invalidation, history-only
follow-ups, decline/Stop/expiry, restore/restart, legacy migration preservation,
and the built-in dispatch gate. The Electron checks use disposable profiles with
secret access disabled: Settings persistence uses the real IPC/database path;
Allow/Decline rendering uses synthetic desktop IPC responses. These checks do not
validate live platform access or provider-side handling of data.

## Tool permissions and invocation history

```sh
npx vitest run tests/chat/unit/mcp-management.test.ts tests/chat/unit/tool-governance-migration.test.ts tests/chat/unit/takes.test.ts
npm run build
node --test tests/chat/integration/tool-governance-ui.test.mjs
```

Checks cover server/tool/take policy precedence, mid-run restrictions, broader
changes deferred to the next response, separate-MCP approval with platform context,
credential changes during approval, persistent per-attempt outcomes, cursor paging,
privacy of audit records, and migration/restore preservation. Electron checks use
real permission IPC/database operations plus synthetic history/approval payloads to
verify rendering. The production build also runs the repository startup guard.

## Remote MCP OAuth checks

```sh
npx vitest run tests/chat/unit/mcp-oauth.test.ts tests/chat/unit/mcp-management.test.ts
npm run build
node --test tests/chat/integration/mcp-oauth-ui.test.mjs
```

Verified 2026-10-01: 18 unit tests, one Electron UI test, typecheck/build and
seven build-gated startup/migration tests passed. The OAuth fixture uses the real
SDK against a loopback server with synthetic tokens; the UI test mocks browser
sign-in/status while saving configuration through the real disposable host.
Neither test opens the user's browser, accesses their keychain, or uses a live
platform account.

## MCP guidance and metadata provenance

```sh
npx vitest run tests/chat/unit/mcp-management.test.ts tests/chat/unit/mcp-oauth.test.ts tests/unit/host-rpc.test.ts
npm run build
node --test --test-concurrency=1 tests/chat/integration/opentake-mcp-bridge.test.mjs tests/chat/integration/mcp-metadata-ui.test.mjs
```

Verified 2026-10-01: 16 management, seven OAuth and two RPC tests passed; the
built bridge and disposable Electron metadata UI checks passed, along with
typecheck/build and its seven startup/migration checks. Coverage includes fixed
run guidance/definitions after metadata refresh, permission preservation for
informational updates, schema-change blocking, credential-value redaction, bounded
discovery rollback, retained invocation links after server removal, source/change
inspection and run-scoped gateway guidance delivery. Tests use synthetic data.

## Auto / Ask toolbar

```sh
npx vitest run tests/chat/unit/takes.test.ts tests/chat/unit/mcp-management.test.ts -t 'approval mode|Ask take mode|platform tools or earlier platform context|takes persist branches'
npm run build
node --test tests/chat/integration/permission-mode-ui.test.mjs
```

Verified 2026-10-01: five selected unit tests, one disposable Electron UI test,
typecheck/build and its seven startup/migration checks passed. Covers default Auto,
persisted per-take Ask, run snapshots, active-run changes rejected, exact-call
approval for custom and built-in tools, global blocking, existing sharing approval,
and switching/reloading takes. No live credentials or provider calls are used.

## Image capabilities, screenshot handling and response limits

```sh
npx vitest run tests/chat/unit/take-images.test.ts tests/chat/unit/run-budget.test.ts tests/chat/unit/claude-history.test.ts tests/chat/unit/take-runtime.test.ts tests/unit/ai-models.test.ts
npx vitest run tests/chat/unit/takes.test.ts -t 'image capability|attachment cleanup'
npx vitest run tests/chat/unit/mcp-management.test.ts -t 'thirty-first'
npm run build
node --test tests/chat/integration/image-upload.test.mjs
```

Verified 2026-10-01: 26 focused unit tests (across scoped runs), seven build startup
checks and one disposable Electron test passed. Covers image orientation/encoding,
metadata stripping, malformed and oversized files, cumulative limits, capability
checks for follow-ups/regeneration, native image delivery before text, numbered
references, partial output on turn limits, failed tool-attempt counting, native
Electron upload, expanded preview and removal. Tests use synthetic images,
providers and profiles; no real credentials. Other-platform packaged Sharp
binaries and live model vision remain unverified.

## Usage accounting and budgets

```sh
npx vitest run tests/chat/unit/chat-usage.test.ts tests/chat/unit/usage-persistence.test.ts tests/chat/unit/take-runtime.test.ts
npx vitest run tests/chat/unit/native-adapters.test.ts -t 'OpenCode success'
npm run build
node --test tests/chat/integration/usage-ui.test.mjs
```

Verified 2026-10-02: 14 focused units, seven startup checks, the appended migration
checksum check, typecheck and one disposable Electron UI test passed. Covers
cumulative/deduplicated usage, invalid/missing values, cost labeling, durable
partial summaries, stable cursor paging, budget defaults and snapshots, Claude
budget flags/errors, OpenCode step IDs, response usage dialog, history tab,
timestamps, and settings persistence. Synthetic providers only; actual provider
billing and cost-limit behavior have not been tested against a live account.

## Paged history and incremental response updates

```sh
npx vitest run tests/chat/unit/take-history.test.ts tests/chat/unit/takes.test.ts
npm run build
node --test tests/chat/integration/history-paging-ui.test.mjs
```

Verified 2026-10-02: 16 history/take tests, seven build/startup checks and one
Electron test passed. Coverage includes ancestor-only pages, cursor tampering,
branch changes and host restarts, deterministic take/version paging, byte-bounded
pages, incremental streaming, full inference context despite UI paging, replay
exclusion, actual host take-page IPC, scroll preservation and older version
selection. Uses only synthetic fixtures and disposable profiles. Persisted
summaries are not implemented or claimed by these checks.


## Persisted condensed context

```sh
npx vitest run tests/chat/unit/take-context.test.ts tests/chat/unit/takes.test.ts tests/chat/unit/take-history.test.ts
npm run build
node --test tests/chat/integration/context-ui.test.mjs
```

Context tests cover source-bound persistence/reuse, branch isolation, original
history retention, user/image/recent-turn preservation, tool failures and unknown
outcomes, instruction/tool/image admission accounting, unchanged platform
provenance, and deletion cleanup. The Electron test checks the per-response
notice and keyboard expansion with a synthetic transcript. These are local
extractive summaries, not model-generated semantic summaries. Tests use no live
credentials or provider calls.


## Keyboard access and narrow layouts

```sh
npm run build
node --test --test-concurrency=1 tests/chat/integration/accessibility-ui.test.mjs tests/chat/integration/ai-picker-ui.test.mjs tests/chat/integration/history-paging-ui.test.mjs tests/chat/integration/usage-ui.test.mjs
```

The accessibility fixture covers history navigation below the desktop breakpoint,
modal focus containment/return, toolbar Escape behavior, usage focus return,
Shift+Enter, accessible composer guidance, copy/completion status elements, and
wide Markdown at 390/640/1024px with reduced motion enabled. Existing picker,
history and usage tests protect adjacent behavior. All use disposable profiles
with synthetic data. Manual VoiceOver reading order and spoken announcements
remain a separate check.


## Reported usage thresholds and closeout

```sh
npx vitest run tests/chat/unit/usage-budget.test.ts tests/chat/unit/chat-usage.test.ts tests/chat/unit/usage-persistence.test.ts
node --test tests/chat/integration/usage-ui.test.mjs
```

Coverage includes all three provider usage formats, threshold boundaries,
OpenCode cost scoping, missing values, cancellation/tool-dispatch revocation,
immutable run settings and persistence across settings navigation. These are
reported-usage stopping thresholds, not hard billing/token caps. VoiceOver's
native spoken pass was explicitly skipped by the user on 2026-10-02.


Closeout verified 2026-10-02: `npm run test:chat` passed 108 units (two optional
installed-CLI cases skipped), build/typecheck and seven startup checks; 17 of 19
Electron cases initially passed. The restore-default editor race was fixed and
the toast fixture updated for current image-capability validation. Both failures
then passed in a targeted rerun, yielding 19 passing Electron cases. VoiceOver
was skipped at the user's request. Experimental runtime packages were not part
of this chat regression run.

## Grok ACP adapter

`unit/grok-adapter.test.ts` exercises synthetic ACP streaming, context history,
gateway tools, errors, cancellation and temporary credential rotation.
`integration/grok-chat-ui.test.mjs` checks Grok model selection and sending.

Opt in to the installed-CLI contract tests with
`GROK_COMPAT_BINARY=/absolute/path/to/grok npx vitest run tests/chat/unit/grok-cli-compatibility.test.ts`.
These require macOS and CLI 1.0.46; all auth is synthetic, personal files are
blocked, and network access is restricted to the local mock model server. They
verify the actual tool list and reject file-backed MCP input before reading it.

## Shared PDF documents

PDF originals are ordinary files at `<active database directory>/attachments/pdf/<UUID>.pdf`,
with metadata, SHA-256 integrity hashes, and indexed page text in PGlite. Upload
chunks are temporary `.part` files, removed after finalization. Original filenames
are metadata only and cannot choose filesystem paths. The attachments
folder travels with existing database snapshots, encrypted backups, upgrades and
restores; previous recovery directories remain intact. Restores verify every
original and never activate missing or corrupted ones; at startup a missing
original only makes that document's page images unavailable. Total retained
PDFs are capped at 1 GB because snapshots hold them in memory. Orphans are collected at startup, during
upload/discard, and after chat deletion. Attachments stay separate from the composer. `opentake_documents` lists,
searches, reads paginated text, and renders individual pages for image-capable
models. Tool access is scoped to the active conversation branch and respects
configured tool permissions; instruction sets without it still answer and the
model is told the PDFs are unreadable. Images are omitted from persisted tool
replay and audit records and can be requested again. Take exports explicitly disclose omitted PDF originals.

Local processing limits: 50 MiB/file, 1,000 pages, 10 million extracted characters,
10 PDFs/message, 250 MiB and 100 stored documents/take. These are application
limits, not provider limits. Individual reads return up to 6,000 characters with
an offset for continuation. A response has up to 32,000 document admission units
(subject to remaining chat context); a page image uses 8,000 units. These units
are conservative bookkeeping, not model token counts. Reaching a response budget
does not truncate or remove the stored file. Scans need an image-capable model;
there is no OCR service. Password-protected PDFs need an unlocked copy.

Focused verification (Node 24):

```sh
npx vitest run tests/chat/unit/document-files.test.ts tests/chat/unit/take-documents.test.ts tests/chat/unit/pdf-persistence.test.ts tests/chat/unit/take-images.test.ts tests/chat/unit/claude-history.test.ts
npx vitest run tests/chat/unit/native-adapters.test.ts -t 'cross-provider replay'
npx vitest run tests/unit/take-file.test.ts -t 'PDF export'
npm run build
node --test --test-concurrency=1 tests/chat/integration/pdf-upload.test.mjs tests/chat/integration/image-upload.test.mjs
```

Tests use synthetic PDFs, in-memory databases, mocked model discovery, and a
disposable Electron profile with secret access disabled. Coverage includes a
40-page document, draft persistence, late-page retrieval and visual previews,
scans, invalid uploads, branch isolation, chunk retries, context budgets, cascade
cleanup, migration from version 81, and image replay compatibility. Live provider
reasoning and cross-platform installer packaging remain unverified.

## Reply buttons and General's conversation fields

`unit/reply-options.test.ts` covers the reply-button parser. `unit/takes.test.ts`
covers General's shipped conversation fields (`resources/ai/general/`).
