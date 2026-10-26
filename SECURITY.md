# Security policy

Opentake holds brokerage and AI-provider credentials and can place real trades,
so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Instead, either:

- use GitHub's [private vulnerability reporting](https://github.com/Try-Early-Bird/opentake/security/advisories/new), or
- email **founders@joinearlybird.com** with "Security" in the subject.

Include what you found, how to reproduce it, and the impact you expect. We aim
to acknowledge reports within three business days and to agree on a disclosure
timeline with you. Please give us a reasonable chance to ship a fix before
publishing details.

Never test against accounts that are not yours, and never place trades or move
money in someone else's account while researching an issue.

## Supported versions

Only the latest release receives security fixes. Opentake is pre-1.0 software.

## Scope

In scope: the desktop app, its background host and local RPC, the bundled MCP
bridge, credential storage, backups, the update mechanism, and the AI agent
tool and trading guardrails (including prompt-injection paths that lead to
trades or data leaving the machine).

Out of scope: vulnerabilities in third-party services (Robinhood, Coinbase, AI
providers) or in AI CLIs you install yourself, and attacks that require an
attacker already running code as your OS user, except where Opentake makes
them meaningfully easier.

See [docs/security-model.md](docs/security-model.md) for how Opentake protects
credentials and data, and what it does not protect against.
