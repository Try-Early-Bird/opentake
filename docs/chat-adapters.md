# Installed CLI chat adapters

Chat uses the user's installed CLIs directly. There is no Vercel AI SDK or
community-provider dependency. `chat-executors.ts` selects the implementation;
the host owns permissions, tool dispatch, approvals, persistence and run budgets.

## Verified protocol versions

| Provider | Runtime | Execution interface |
| --- | --- | --- |
| ChatGPT | Codex CLI 0.144.3 | app-server JSON-RPC, ephemeral thread, injected Responses history |
| OpenCode Zen | OpenCode 1.14.25 | imported session, authenticated loopback HTTP and SSE |

CLIs update themselves, so a version is never a reason to refuse a response
(owner decision 2026-10-05). Every adapter has two layers:

- **Baseline (any version):** only each CLI's stable surface (prompt, system
  prompt, MCP config pointing at the host gateway, output stream). Earlier turns
  go in as one quoted block marked as a record, not instructions
  (`quotedHistory` / `flattenedHistory`), with an "Earlier messages sent as
  context" entry in tool activity.
- **Native history (optional):** Claude's resumed transcript, Codex
  `thread/inject_items`, OpenCode session import. The versions listed above (and
  `VERIFIED_CLAUDE_HISTORY_VERSIONS`) use it directly. Another version tries it:
  Claude runs a one-time loopback self-check (`claude-history-gate.ts`); Codex and
  OpenCode attempt the step before any inference and, if it fails, continue on the
  baseline in the same turn. A failed version is remembered
  (`chat-history-modes.json`, `claude-history-verification.json` in the profile).

`nativeChatVersions` lists the versions verified by the opt-in compatibility
tests; the version is recorded in the audit (`cliVersion`, `cliVerified`). Grok's
check confirms the confined runtime starts and reports its version; its sandbox
still fails closed. Output-stream changes that cannot be parsed still end the
response with the existing "unsupported chat protocol" error; unknown OpenCode
part types are ignored rather than failing it.

Each response has a disposable private HOME/config directory. No user CLI config,
project instructions, plugins or session history is imported. The main process
supplies only the selected app-managed credential. Temporary profiles are removed
after child shutdown; the normal chat audit and canonical history remain in the
app. Codex token refresh uses a compare-and-set write so a disconnect/reconnect
during the response wins over a stale refresh.

## Execution boundaries

- Codex starts with `environments: []` and client-handled dynamic tools. Only
  gateway definitions become callable functions; the child receives no gateway
  capability token. The parent validates callbacks and forwards them to the host.
  Native approval requests and unexpected action items stop the response.
- This Codex release still exposes its inert plan helper and empty skills
  list/read helpers despite disable flags. Automatic skill instructions and all
  external skill sources are absent. The installed-CLI fixture checks the actual
  model tool list; do not assume config flags alone remove tools.
- OpenCode permits only `opentake_*` tools and runs the existing MCP bridge with
  the response's capability. Shell/filesystem tools, plugins and project config
  are disabled. The local server binds to 127.0.0.1 with a random password.
- Both preserve user/assistant roles, tool calls/results and image data across
  provider switches. Missing tool outcomes are marked unknown, never re-executed
  as part of history reconstruction. OpenCode import is explicitly version-bound
  and checked through its public API before inference.
- Stop, deadlines, malformed protocol, premature exit, unexpected native tools,
  excessive output and audit errors fail the response. Safe partial text is kept.
  No adapter-level retry or provider fallback occurs. A CLI may apply its own
  provider transport retry policy; a failed tool's side effects can be unknown.
- Shared host deadlines and the 30-dispatch limit apply to both adapters.
  OpenCode also sets its 20-step limit. Codex stops conservatively on the twentieth
  completed-inference usage event, including models without reasoning events;
  that boundary response is marked limited even if its final text has arrived.
- Streaming text, replay and captured audit payloads redact the known run/provider
  credentials, including secrets split across text deltas. Raw stderr is excluded.
  Reported token usage/cost is captured where available, not fabricated. Full
  provider wire internals, billing budgets and context summarization are separate
  work; these CLIs still own their internal model requests.

## Patching after a CLI update

1. Reproduce using the error's CLI version and a synthetic fixture. Do not inspect
   a real app profile, read the user's CLI config, sign in or call a live provider.
2. Inspect that release's public schemas/docs and isolate the change to its
   adapter/history translator. Keep the common host and renderer contracts stable.
3. Add a regression for the changed event, history shape or failure case. Check
   text, images, prior tool outcomes, model tool definitions, cancellation and
   cleanup. Preserve fail-closed behavior for unknown action messages.
4. Verify the candidate version with the explicit opt-in compatibility test and
   mock model server below. Update the allowlist only together with passing
   evidence; removing the guard is not a compatibility fix.
5. Run typecheck/build and the focused UI check when wiring changes. Record the
   tested version, platform and remaining limitations here and in the chat plan.

```sh
npx vitest run tests/chat/unit/native-adapters.test.ts
npm run build
OPENTAKE_TEST_CODEX=/absolute/path/to/codex OPENTAKE_TEST_OPENCODE=/absolute/path/to/opencode npx vitest run tests/chat/unit/native-cli-compatibility.test.ts
node --test tests/chat/integration/native-provider-ui.test.mjs
```

The compatibility test skips providers whose explicit executable variable is
absent. It uses disposable homes, synthetic credentials, local mock model/gateway
servers and the built MCP bridge. Do not replace them with real accounts.

Verification scope: macOS, Codex 0.144.3 and OpenCode 1.14.25. Unix children are
terminated as process groups. Windows descendant cleanup and packaged builds on
other platforms remain unverified. Live subscription entitlement, real credential
refresh and provider-to-brokerage execution require separate user validation.
