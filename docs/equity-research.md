# Equity research

Equity detail pages show earnings above the Key statistics, Filings, Analyst
ratings, and Quarterly financials tabs. Research calls stay in the OSS main
process and use the existing Robinhood connection and account controls.

`window.connections.toolSchemas()` fetches the complete live Robinhood MCP
catalog, follows pagination, and preserves schemas and annotations. Unknown reads
are discovered afresh on invocation and permitted only when the provider declares
`readOnlyHint: true`, the live JSON Schema accepts the arguments, and neither the
schema nor input references account identifiers. Known reads keep their account
mapping and validation. Order writes retain their separate execution paths.

The background host checks the market-wide earnings calendar every 30 seconds
while awake, fetching once successfully per America/New_York calendar date. It
requests the next 31 days without a symbol or large-cap filter and stores the
complete data payload in local `earnings_calendar_snapshots`. Migration 81 is
append-only. Empty calendars count as successful; failures retry later. Overlapping
work is coalesced, and existing snapshots survive restarts. The app must be running
for background sync to run; the next tick catches up after downtime.

Verification uses mocked tool definitions and disposable PGlite databases, never
the user's credentials or live host. The user validates live brokerage access.
