# Opentake

Opentake is a self-hosted desktop app for investing ideas. You describe a belief
("US manufacturing is coming home") to an AI model you bring yourself, turn it into
a **Take**, a basket of holdings with target weights, and then invest in it from
your own brokerage account. Rules can watch data sources and rebalance, invest cash
or reduce a Take, asking you first unless you allow otherwise.

Everything runs on your computer: the database, your credentials, the background
service that watches rules, and the AI agents' tool access. There is no Opentake
server and no telemetry.

> **Opentake can place real orders in your brokerage account.** It is pre-1.0
> software provided under the MIT License, **without warranty of any kind**.
> Nothing in it is financial advice, and AI models can be wrong or manipulated.
> Review what rules and agents are allowed to do, start with small amounts, and
> use it at your own risk.

## Features

- **Brokerages:** Robinhood (equities and crypto) and Coinbase, with
  read-only account sync and order placement through each venue's own API.
- **Bring your own AI:** Claude (Claude Code), ChatGPT (Codex CLI), Grok,
  OpenCode Zen, OpenRouter, or a local model (Ollama, LM Studio, vLLM or any
  OpenAI-compatible server).
- **Takes:** research a thesis with the AI, review its proposed holdings and
  weights, commit a version and invest. Rebalancing, deposits and withdrawals
  are planned locally with exact decimal math and tax-lot attribution.
- **Rules:** watch custom HTTP data sources or live Coinbase prices, then notify
  you, ask an agent to assess, or trade within limits you accept.
- **Guardrails:** trades need your approval unless you allow otherwise, agents
  have per-trade dollar ceilings and only the tools you allow, and content from
  sources and third-party tools is treated as untrusted data.
- **MCP bridge:** expose your local account reads to other MCP clients
  ([tools/earlybird-opentake-mcp](tools/earlybird-opentake-mcp/README.md)).

## Install

Download the latest installer from
[Releases](https://github.com/Try-Early-Bird/opentake-releases/releases).
macOS 13 or later (Apple silicon or Intel) is supported; Windows and Linux
builds are available from source.

AI providers run through their own CLIs, which you install and update yourself:
[Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex) or [OpenCode](https://opencode.ai).
Opentake never imports your existing CLI logins; each sign-in is stored in
Opentake's own encrypted store.

## Build from source

Requires Node 24.

```sh
nvm use
npm ci
npm run dev          # development app with hot reload, on a separate dev profile
npm run build:prod   # installer for the current OS in dist/
```

`npm run dev` first runs `verify:startup`, which checks migrations against a
disposable database before anything starts. `build:prod` produces an unsigned
DMG and ZIP on macOS, an NSIS installer on Windows and an AppImage on Linux.
Build on the target OS. Signed release builds are described in
[docs/releasing.md](docs/releasing.md).

## Tests

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | Type checks for the main process and the renderer |
| `npm test` | Vitest unit and PGlite integration tests |
| `npm run test:chat` | Chat and agent tests ([tests/chat](tests/chat/README.md)) |
| `npm run test:connections` | Migrations, OAuth and account lifecycle |
| `npm run test:host` | Background host queue and authenticated RPC |
| `npm run test:recovery` | Process-kill recovery against a temporary database |
| `npm run test:smoke` | Build plus Electron launch, restart and shutdown |
| `npm run check` | All of the above non-watch suites |

Tests use disposable profiles and synthetic credentials only; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## How it works

The app runs as two processes. The **desktop** process shows the window. A
windowless **background host** owns the database ([PGlite](https://pglite.dev)),
the encrypted credential store, broker connections, rule evaluation and agent
runs. It keeps running when you close the window, so rules keep working, and
the tray menu's **Quit completely** stops both. The two talk over an
authenticated loopback RPC; the renderer never sees credentials or raw
database access.

AI chats run each provider's CLI in a throwaway home directory with its
built-in shell and file tools disabled. The only tools are Opentake's own,
served through a per-run gateway that applies your tool permissions, approval
prompts and budgets, and records an audit trail.

Data lives in your OS's app-data folder (`Earlybird OSS` for installed builds,
`earlybird-oss-development` for `npm run dev`). Settings → Memory exports
password-encrypted backups. See [docs/security-model.md](docs/security-model.md)
for what is encrypted and what is not.

## Documentation

- [Security model](docs/security-model.md)
- [Adding a venue](docs/adding-a-venue.md)
- [Chat adapters](docs/chat-adapters.md)
- [AI audits](docs/ai-audits.md)
- [Data sources](src/main/data-sources/README.md)
- [Releasing](docs/releasing.md)

## Contributing and security

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Earlybird. Opentake is not affiliated with or endorsed by
Robinhood, Coinbase, Anthropic, OpenAI, xAI or any other provider it connects to.
