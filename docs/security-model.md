# Security model

What Opentake protects, how, and what it does not protect against. Report
problems as described in [SECURITY.md](../SECURITY.md).

## Trust boundaries

- **Your OS user is trusted.** Malware running as you, or an administrator, can
  read the database and use credentials while the app runs. Encrypted secret
  storage cannot protect a credential that a compromised app is using.
- **The renderer is not trusted with secrets.** It is sandboxed and
  context-isolated, loads only the bundled UI, cannot open new windows or
  navigate away, and talks to the main process through a fixed list of IPC
  channels. No channel returns a credential value or runs arbitrary SQL.
- **AI models and everything they read are not trusted.** See
  [Agents and trading](#agents-and-trading).

## Credentials

`src/main/secret-store.ts` stores credentials (brokerage OAuth tokens, AI
sign-ins, API keys) with Electron's `safeStorage`, which uses the macOS
Keychain, Windows DPAPI or a Linux keyring. Records live in `<profile>/secrets/`,
outside the database and outside backups. Each record is bound to its reference
inside the encryption, files are written atomically with owner-only permissions,
and symlinks are refused. If OS storage is missing or locked, credential access
fails closed: there is no plaintext fallback, and on Linux the insecure
`basic_text` backend is refused. Only the background host can read secrets.

AI CLIs need a credential file while they run. Each run gets a throwaway home
directory (0700, files 0600) that is deleted when the run ends, and the host
clears any leftovers from a crash when it starts.

## Local data

The database and its retained recovery copies are **not encrypted by
Opentake**. Use FileVault, BitLocker or Linux disk encryption. On macOS and
Linux the profile and database directories are owner-only (umask 077, 0700);
Windows relies on the user profile's ACL.

Diagnostics in `<profile>/logs/host/` use an allowlist of fields: messages,
stack traces, paths, SQL, broker payloads, credentials, balances and holdings
are omitted. Nothing is sent anywhere: there is no telemetry, crash upload or
installation identifier.

## Backups

Settings → Memory exports `.ebbackup` files: AES-256-GCM with a fresh random
salt and nonce per file and an authenticated header, keyed by scrypt
(N=131072, r=8, p=1; parameters are fixed in code, not read from the file).
Passphrases must be at least 12 characters and are never stored. Backups contain
the database only, never credentials or preferences.

Importing replaces the database after decryption, archive validation (size caps,
no links or path traversal) and migration of a separate copy. A restored
database never trades or connects on its own: connections need signing in again,
allocations and trading rules are paused, MCP servers are disabled and their tool
permissions reset, and a server's configuration is re-validated before it can be
turned back on. Only import backups you made yourself.

## Local RPC and the MCP bridge

The desktop and the background host talk over HTTP on `127.0.0.1` with a random
port and a 256-bit bearer token, compared in constant time. The token lives in
`host.json` (0600, checked for symlinks and permissions on read). Requests with
an `Origin` header are rejected, which blocks browser pages (CSRF and DNS
rebinding). Agent runs get a separate per-run token, stored only as a hash,
limited to the gateway methods and valid only while that run is active.

## Agents and trading

- AI CLIs run with their built-in shell, file and web tools disabled. Agents can
  only call Opentake's gateway tools and third-party MCP tools you allowed.
- No agent tool runs SQL, shell commands or arbitrary HTTP. Agents never choose
  symbols, sides or quantities: trades are planned from a Take's target weights.
- A rule may trade only after you accept it and grant it trading. Trades wait
  for your approval when the rule asks first or "Confirm every trade" is on.
- An agent rule has a per-trade dollar ceiling, checked against the previewed
  orders in USD, and is limited to the accounts and actions you accepted.
- When a trade you approved is placed, it is re-planned at current prices. It
  must stay within what you approved (no new symbol or side, no order more than
  10% or $1 larger) or you are asked again. A rule's own trigger must still hold.
- Content from data sources, documents and third-party MCP servers reaches the
  model fenced as untrusted data. If an automatic run reads text that looks like
  instructions, any trade it requests waits for your approval regardless of the
  rule's setting, and the notification says why.
- Third-party MCP servers run with your user's permissions. Add only servers you
  trust, and be careful with "trust updates", which keeps a tool's permission
  when its definition changes.

## Signed releases

Release builds are code-signed and notarized. They ignore `NODE_OPTIONS`, load
only an integrity-checked `app.asar`, keep macOS library validation on, and exit
if launched with remote-debugging or inspector switches. In-app updates verify
signatures, never downgrade, and install only after you confirm. Development and
unsigned builds have none of these protections.

## Not yet audited

The backup format and the agent guardrails have not had an independent security
audit. Robinhood account numbers are stored as unsalted hashes, which can be
reversed by anyone with a copy of the database.
