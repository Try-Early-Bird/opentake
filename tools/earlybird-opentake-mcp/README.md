# earlybird-opentake-mcp

Local stdio MCP bridge for the Opentake background host. It talks only to the
host on this computer; there is no remote API. Source lives in `src/main/opentake-mcp`; the app build includes
`out/main/earlybird-opentake-mcp.js` and its shared chunks.

## Platform routing

Shared tools require an explicit platform:

```json
{"name":"opentake_connection_status","arguments":{"platform":"robinhood"}}
{"name":"opentake_list_accounts","arguments":{"platform":"robinhood"}}
```

Provider tools name their platform and do not accept a redundant platform field:

```json
{"name":"robinhood_get_portfolio","arguments":{}}
{"name":"robinhood_get_equity_quotes","arguments":{"symbols":["AAPL"]}}
```

Only `robinhood` is enabled. Each provider tool declares its platform in the
catalog. The host dispatches to the matching service. `accountRef` is a local
account UUID returned by `opentake_list_accounts`, not a hosted account hash or
brokerage number. Omit it to use the selected account. The service checks that
an explicit account belongs to the active Robinhood connection, then resolves
its brokerage number privately through account discovery.

Additional platforms should supply their own catalog and service adapter, extend
the shared platform schema, and preserve connection-scoped account resolution.
Never route a tool based only on an arbitrary model-provided platform string.

## Enabled and deferred

The initial catalog has 28 read tools: connection/account status, portfolio,
positions, quotes, order history, research, tax lots, indexes, Robinhood watchlist
reads and saved scanner reads. Arguments use Robinhood snake_case except for
`accountRef`. Results preserve provider data envelopes and mask account numbers.
The provider session is reused, but an MCP transport is opened per read.

Strategy following and publication are disabled. A future open strategy
repository can load definitions into local strategies; importing a definition
must remain separate from subscribing/following or enabling execution. No
repository fetching or strategy execution is implemented by this bridge.

Personal strategy services, local lists, option chain/instrument lookup, the
popular-market aggregation and portfolio/order sync health are not registered
until their local adapters exist. RHS-specific P&L reads are also omitted until
onboarding supports that account identifier. Trading, exercise, cancellation and
other writes are disabled until local review/approval, intent persistence and
reconciliation services are ready. Disabled tools cannot be invoked by name.
`opentake_connection_status` reports these capabilities explicitly.

The Robinhood contract definitions include writes, which stay disabled; the
catalog and provider independently permit only registered reads. There is no
remote login, API fallback or cloud vault.

## Run

Build from the OSS root with `npm run build`. Start Opentake normally and onboard
Robinhood in its connection UI. A BYO AI runtime can launch the bundled bridge:

```sh
node /absolute/path/to/opentake/out/main/earlybird-opentake-mcp.js --profile /absolute/path/to/opentake-profile
```

Use the profile selected by the application. There is deliberately no default
profile. For a bundled Electron executable, its Node mode can run the same entry
inside `app.asar`; the eventual BYO AI launcher should supply that executable,
entry path and profile rather than relying on a system Node installation.
Keep the shared output chunks with the entry point.

The bridge reads only the existing private host IPC manifest at runtime. Robinhood
credentials stay in the background host's SecretStore and never cross MCP. The
host must already be running; the bridge does not sign in, launch a browser,
disconnect, or auto-start the host. It reloads IPC metadata per call to tolerate
host restarts. Brokerage reads serialize with connection maintenance. If busy,
retry after the current connection operation finishes.

To inspect the catalog without accessing any profile:

```sh
node out/main/earlybird-opentake-mcp.js --list-tools
```

## Focused verification

```sh
npx vitest run tests/chat/unit/opentake-mcp.test.ts tests/unit/robinhood.test.ts tests/unit/connections.test.ts
npm run build
node --test tests/chat/integration/opentake-mcp-bridge.test.mjs
```

Tests use in-memory MCP transports, synthetic credentials/endpoints and disposable
profiles. The stdio test uses a fake host, not the user's running background host.
Live Robinhood/keychain behavior and packaged executable launch remain manual
validation. Connecting Claude/OpenAI and adding the BYO AI UI are separate work.
