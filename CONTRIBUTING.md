# Contributing to Opentake

Thanks for your interest. Opentake is early software that touches real money,
so we favour small, well-tested changes.

## Before you start

- For anything beyond a small fix, open an issue first so we can agree on the
  approach.
- Report security problems privately; see [SECURITY.md](SECURITY.md).

## Development setup

```sh
nvm use      # Node 24
npm ci
npm run dev  # runs the startup guard, then Electron with hot reload
```

`npm run dev` uses a separate development profile, not the packaged app's.

## Ground rules

- **Never use real credentials in tests.** Use synthetic credentials, injected
  fake secret stores, mocked endpoints and disposable profiles. Electron tests
  pass `--earlybird-test-no-secrets`. Automated tests must never sign in to a
  live brokerage or AI provider, place an order, or touch your OS keychain.
- **Never edit an applied migration.** Migrations are append-only: add a new
  version, and append (never regenerate) its checksum in
  `tests/fixtures/migration-checksums.json`.
- **Run the tests your change affects.** Pick the narrowest relevant command
  (see the README); run broad suites when a change touches shared behaviour.
- **Money math is exact.** Use the scaled-decimal helpers in
  `src/main/allocations/decimal.ts`, not floating point, for amounts and
  quantities.
- **Trading paths fail closed.** A change that could place, size or approve an
  order needs tests for the refusal paths as well as the happy path.

## Pull requests

- Keep each pull request to one change, with a short description of what and why.
- Include tests, and say which commands you ran.
- Run `npm run test:release` plus the tests for what you changed. Maintainers
  can run the full suite on every platform from the Actions tab before merging.

## Coding assistants

[AGENTS.md](AGENTS.md) holds the rules for AI coding assistants working in this
repository. They apply to human contributors too.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
